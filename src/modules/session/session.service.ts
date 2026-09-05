import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, In, DataSource } from 'typeorm';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Session, SessionStatus } from './entities/session.entity';
import { CreateSessionDto } from './dto';
import { EngineFactory } from '../../engine/engine.factory';
import {
  IWhatsAppEngine,
  EngineStatus,
  DisconnectInfo,
  InboundStats,
} from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';

interface ReconnectState {
  attempts: number;
  timer: NodeJS.Timeout | null;
  maxAttempts: number;
  baseDelay: number;
}

@Injectable()
export class SessionService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = createLogger('SessionService');

  // In-memory map of active engine instances
  private engines: Map<string, IWhatsAppEngine> = new Map();

  // Reconnection state per session
  private reconnectStates: Map<string, ReconnectState> = new Map();

  // Callers of GET /sessions/:id/qr parked until the engine emits its first QR
  private qrWaiters: Map<string, Array<(qr: string) => void>> = new Map();

  // Sessions with an initializeEngine() in flight, so concurrent start/restore
  // calls cannot spawn two Chromium instances on the same profile
  private starting: Set<string> = new Set();

  constructor(
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    @InjectDataSource('data')
    private readonly dataSource: DataSource,
    private readonly engineFactory: EngineFactory,
    private readonly eventsGateway: EventsGateway,
    private readonly webhookService: WebhookService,
    private readonly hookManager: HookManager,
    private readonly configService: ConfigService,
  ) {}

  /**
   * On backend startup, reset all active session statuses to disconnected
   * because the engines are not running yet after restart
   */
  async onModuleInit(): Promise<void> {
    const activeStatuses = [
      SessionStatus.READY,
      SessionStatus.INITIALIZING,
      SessionStatus.QR_READY,
      SessionStatus.AUTHENTICATING,
    ];

    // Capture the list BEFORE the reset: it is the only record of which
    // sessions were live when the process went down.
    const wasActive = await this.sessionRepository.find({
      where: { status: In(activeStatuses) },
    });

    const result = await this.sessionRepository.update(
      { status: In(activeStatuses) },
      { status: SessionStatus.DISCONNECTED },
    );

    if (result.affected && result.affected > 0) {
      this.logger.log(`Reset ${result.affected} session(s) to disconnected on startup`, {
        action: 'startup_reset',
        affected: result.affected,
      });
    }

    if (!this.configService.get<boolean>('engine.autoRestore', true)) {
      return;
    }

    // Only sessions that had actually paired are worth reopening: the stored
    // credentials let them come back without a QR. Sessions that died while
    // still showing a QR have nothing to restore.
    const restorable = wasActive.filter(session => !!session.phone);
    if (restorable.length === 0) return;

    const delay = this.configService.get<number>('engine.autoRestoreDelay', 3000);
    this.logger.log(`Restoring ${restorable.length} session(s) after restart in ${delay}ms`, {
      action: 'startup_restore_scheduled',
      count: restorable.length,
    });

    // Deferred and detached: a slow Chromium launch must not block bootstrap.
    this.restoreTimer = setTimeout(() => {
      void this.restoreSessions(restorable.map(session => session.id));
    }, delay);
    this.restoreTimer.unref?.();
  }

  private restoreTimer: NodeJS.Timeout | null = null;

  private async restoreSessions(ids: string[]): Promise<void> {
    for (const id of ids) {
      try {
        await this.start(id, { force: true, wait: true });
        this.logger.log(`Session restored after restart`, {
          sessionId: id,
          action: 'startup_restore',
        });
      } catch (error) {
        this.logger.error(
          'Failed to restore session after restart',
          error instanceof Error ? error.message : String(error),
          { sessionId: id, action: 'startup_restore_failed' },
        );
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Clean up all engines on shutdown
    for (const [sessionId, engine] of this.engines) {
      this.logger.log(`Destroying engine for session ${sessionId}`, {
        sessionId,
        action: 'shutdown',
      });
      await engine.destroy();
    }
    this.engines.clear();

    // Clear all reconnect timers
    for (const [, state] of this.reconnectStates) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
    this.reconnectStates.clear();

    if (this.restoreTimer) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
    this.qrWaiters.clear();
  }

  async create(dto: CreateSessionDto): Promise<Session> {
    // Check if session with same name exists
    const existing = await this.sessionRepository.findOne({
      where: { name: dto.name },
    });

    if (existing) {
      throw new ConflictException(`Session with name '${dto.name}' already exists`);
    }

    const session = this.sessionRepository.create({
      name: dto.name,
      config: dto.config || {},
      proxyUrl: dto.proxyUrl || null,
      proxyType: dto.proxyType || null,
      status: SessionStatus.CREATED,
    });

    const saved = await this.dataSource.transaction(async manager => {
      return await manager.save(session);
    });
    this.logger.log(`Session created: ${saved.name}`, {
      sessionId: saved.id,
      action: 'create',
    });

    // Execute hook after session created (outside transaction since hooks do external I/O)
    await this.hookManager.execute('session:created', saved, {
      sessionId: saved.id,
      source: 'SessionService',
    });

    return saved;
  }

  async findAll(): Promise<Session[]> {
    return this.sessionRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<Session> {
    const session = await this.sessionRepository.findOne({ where: { id } });
    if (!session) {
      throw new NotFoundException(`Session with id '${id}' not found`);
    }
    return session;
  }

  async findByName(name: string): Promise<Session> {
    const session = await this.sessionRepository.findOne({ where: { name } });
    if (!session) {
      throw new NotFoundException(`Session with name '${name}' not found`);
    }
    return session;
  }

  async delete(id: string): Promise<void> {
    const session = await this.findOne(id);

    // Cancel any reconnection attempts
    this.cancelReconnect(id);

    // Stop engine if running
    await this.teardownEngine(id);

    // Execute hook BEFORE delete so plugins can access session data
    await this.hookManager.execute(
      'session:deleted',
      {
        id: session.id,
        name: session.name,
        phone: session.phone,
        pushName: session.pushName,
      },
      {
        sessionId: id,
        source: 'SessionService',
      },
    );

    await this.dataSource.transaction(async manager => {
      await manager.remove(session);
    });

    // Remove the engine auth data on disk. LocalAuth keys its folder by session
    // name, so leaving it behind makes a later session reusing that name inherit
    // stale credentials and never produce a usable QR.
    await this.removeAuthData(session.name);

    this.logger.log(`Session deleted: ${session.name}`, {
      sessionId: id,
      action: 'delete',
    });
  }

  /**
   * Bring a session up.
   *
   * Initialization is deliberately NOT awaited by default: launching Chromium
   * and loading WhatsApp Web takes tens of seconds, and a slow or wedged
   * profile used to hold the HTTP request open until the client gave up - the
   * request looked frozen even though the engine was still working. The engine
   * is registered synchronously, so the session immediately reports
   * `initializing`; callers poll the status or block on GET /qr instead.
   */
  async start(id: string, options: { force?: boolean; wait?: boolean } = {}): Promise<Session> {
    const session = await this.findOne(id);

    if (this.starting.has(id)) {
      throw new ConflictException('Session start is already in progress');
    }

    const existing = this.engines.get(id);
    if (existing) {
      const engineStatus = existing.getStatus();
      const healthy =
        engineStatus === EngineStatus.READY ||
        engineStatus === EngineStatus.QR_READY ||
        engineStatus === EngineStatus.AUTHENTICATING ||
        engineStatus === EngineStatus.INITIALIZING;

      if (healthy && !options.force) {
        throw new BadRequestException('Session is already started');
      }

      // A dead or forced engine is torn down instead of blocking the restart.
      // Leaving it in the map is what used to make a session unrecoverable
      // ("Session is already started" forever) until it was recreated.
      this.logger.warn(`Replacing stale engine (status: ${engineStatus})`, {
        sessionId: id,
        action: 'engine_replace',
      });
      await this.teardownEngine(id);
    }

    // Execute hook before starting
    await this.hookManager.execute(
      'session:starting',
      { sessionId: id },
      {
        sessionId: id,
        source: 'SessionService',
      },
    );

    // Initialize reconnect state
    const config = session.config as {
      maxReconnectAttempts?: number;
      reconnectBaseDelay?: number;
    } | null;
    this.reconnectStates.set(id, {
      attempts: 0,
      timer: null,
      maxAttempts: config?.maxReconnectAttempts ?? 5,
      baseDelay: config?.reconnectBaseDelay ?? 5000,
    });

    await this.updateStatus(id, SessionStatus.INITIALIZING);

    const initialization = this.initializeEngine(id, session);

    if (options.wait) {
      await initialization;
    } else {
      initialization.catch((error: unknown) => {
        this.logger.error('Engine initialization failed', error instanceof Error ? error.message : String(error), {
          sessionId: id,
          action: 'engine_init_failed',
        });
      });
    }

    return this.findOne(id);
  }

  /**
   * Stop and start in one call. This is the endpoint to use when a session is
   * wedged: it always tears the engine down first, so it can never fail with
   * "Session is already started".
   */
  async restart(id: string, options: { clearAuth?: boolean } = {}): Promise<Session> {
    const session = await this.findOne(id);

    this.cancelReconnect(id);
    await this.teardownEngine(id);

    if (options.clearAuth) {
      await this.removeAuthData(session.name);
    }

    return this.start(id, { force: true });
  }

  /** Destroy the engine for a session and drop every trace of it from memory. */
  private async teardownEngine(id: string): Promise<void> {
    const engine = this.engines.get(id);
    this.engines.delete(id);
    this.rejectQrWaiters(id);

    if (!engine) return;

    try {
      await engine.destroy();
    } catch (error) {
      // Best effort: the entry is already gone from the map, so a failed
      // destroy cannot block the next start.
      this.logger.warn('Engine destroy failed during teardown', {
        sessionId: id,
        error: String(error),
      });
    }
  }

  private async initializeEngine(id: string, session: Session): Promise<void> {
    this.logger.log(`Initializing engine for session: ${session.name}`, {
      sessionId: id,
      action: 'engine_init',
      proxyEnabled: !!session.proxyUrl,
    });

    this.starting.add(id);

    const engine = this.engineFactory.create({
      sessionId: session.name,
      proxyUrl: session.proxyUrl || undefined,
      proxyType: session.proxyType || undefined,
    });
    this.engines.set(id, engine);

    // Must be set BEFORE initialize(): the engine emits the QR event while
    // initialize() is still pending, so setting it afterwards would overwrite
    // the QR_READY status the callback already applied.
    await this.updateStatus(id, SessionStatus.INITIALIZING);

    try {
      await engine.initialize({
        onQRCode: (qr: string): void => {
          this.logger.log('QR code generated', {
            sessionId: id,
            action: 'qr_generated',
          });

          this.resolveQrWaiters(id, qr);

          // Execute hook for QR event
          void this.hookManager.execute(
            'session:qr',
            { sessionId: id },
            {
              sessionId: id,
              source: 'Engine',
            },
          );

          void this.updateStatus(id, SessionStatus.QR_READY);
        },
        onReady: (phone: string, pushName: string): void => {
          this.logger.log(`Session ready: ${phone}`, {
            sessionId: id,
            phone,
            pushName,
            action: 'ready',
          });

          // Execute hook for ready event
          void this.hookManager.execute(
            'session:ready',
            { phone, pushName },
            {
              sessionId: id,
              source: 'Engine',
            },
          );

          // Reset reconnect attempts on successful connection
          const reconnectState = this.reconnectStates.get(id);
          if (reconnectState) {
            reconnectState.attempts = 0;
          }

          void this.sessionRepository.update(id, {
            status: SessionStatus.READY,
            phone,
            pushName,
            connectedAt: new Date(),
            lastActiveAt: new Date(),
          });
        },
        onMessage: (message): void => {
          this.logger.debug(`Message received from ${message.from}`, {
            sessionId: id,
            messageId: message.id,
            from: message.from,
            action: 'message_received',
          });
          // Update last active timestamp
          void this.sessionRepository.update(id, { lastActiveAt: new Date() });
          // Convert IncomingMessage to plain object for dispatch
          const messageData = { ...message };

          // Execute hook for message received - plugins can modify or stop processing
          void this.hookManager
            .execute('message:received', messageData, {
              sessionId: id,
              source: 'Engine',
            })
            .then(({ continue: shouldContinue, data: finalMessage }) => {
              if (!shouldContinue) {
                // Plugin stopped processing (e.g., auto-reply handled it)
                return;
              }

              // Dispatch to webhooks with potentially modified message
              void this.webhookService.dispatch(id, 'message.received', finalMessage);
              // Emit real-time event to WebSocket clients
              this.eventsGateway.emitMessage(id, finalMessage);
            });
        },
        onDisconnected: (reason: string, info?: DisconnectInfo): void => {
          this.logger.warn(`Session disconnected: ${reason}`, {
            sessionId: id,
            reason,
            requiresReauth: info?.requiresReauth ?? false,
            action: 'disconnected',
          });

          this.rejectQrWaiters(id);

          // Execute hook for disconnected event
          void this.hookManager.execute(
            'session:disconnected',
            { reason },
            {
              sessionId: id,
              source: 'Engine',
            },
          );

          void this.updateStatus(id, SessionStatus.DISCONNECTED);

          // Attempt to reconnect (wiping dead credentials first when WhatsApp
          // invalidated them, otherwise the retry restores a broken session and
          // never emits a QR).
          void this.handleDisconnect(id, session, info);
        },
        onStateChanged: (engineState: EngineStatus): void => {
          const statusMap: Record<EngineStatus, SessionStatus> = {
            [EngineStatus.DISCONNECTED]: SessionStatus.DISCONNECTED,
            [EngineStatus.INITIALIZING]: SessionStatus.INITIALIZING,
            [EngineStatus.QR_READY]: SessionStatus.QR_READY,
            [EngineStatus.AUTHENTICATING]: SessionStatus.AUTHENTICATING,
            [EngineStatus.READY]: SessionStatus.READY,
            [EngineStatus.FAILED]: SessionStatus.FAILED,
          };
          const newStatus = statusMap[engineState];
          if (newStatus) {
            void this.updateStatus(id, newStatus);
          }
        },
      });
    } catch (error) {
      // The engine was registered before initialize() so the QR callback could
      // find it. On failure it MUST come back out, or every later start() sees
      // a zombie and reports "Session is already started".
      await this.teardownEngine(id);
      await this.updateStatus(id, SessionStatus.FAILED);
      throw error;
    } finally {
      this.starting.delete(id);
    }
  }

  /**
   * Inbound counters for a running session: what was filtered, what was
   * downloaded, how deep the download queue is.
   *
   * @throws NotFoundException when the session does not exist.
   * @throws BadRequestException when it is not running - the counters live in
   *   the engine instance and reset with it, so there is nothing to report.
   */
  async getInboundStats(id: string): Promise<InboundStats> {
    const session = await this.sessionRepository.findOne({ where: { id } });
    if (!session) {
      throw new NotFoundException(`Session with ID ${id} not found`);
    }

    const engine = this.engines.get(id);
    if (!engine?.getInboundStats) {
      throw new BadRequestException('Session is not running');
    }

    return engine.getInboundStats();
  }

  /**
   * Decide what a disconnect means before retrying. A LOGOUT/UNPAIRED/banned
   * disconnect leaves unusable credentials on disk: whatsapp-web.js then
   * restores them on the next launch, stalls, and emits neither `ready` nor
   * `qr` - the "session dead, no QR, have to create a new one" case.
   */
  private async handleDisconnect(id: string, session: Session, info?: DisconnectInfo): Promise<void> {
    if (info?.requiresReauth) {
      this.logger.warn(`Credentials invalidated (${info.reason}); clearing auth data to force a new QR`, {
        sessionId: id,
        reason: info.reason,
        action: 'auth_reset',
      });

      await this.teardownEngine(id);
      await this.removeAuthData(session.name);
      await this.sessionRepository.update(id, { phone: null, pushName: null, connectedAt: null });

      // Re-pairing is a fresh start, not a continuation of the failed attempts.
      const state = this.reconnectStates.get(id);
      if (state) state.attempts = 0;
    }

    this.scheduleReconnect(id, session);
  }

  private resolveQrWaiters(id: string, qr: string): void {
    const waiters = this.qrWaiters.get(id);
    if (!waiters) return;
    this.qrWaiters.delete(id);
    for (const resolve of waiters) resolve(qr);
  }

  private rejectQrWaiters(id: string): void {
    // Waiters resolve with an empty string; getQRCode() turns that into the
    // usual 400 rather than hanging until its own timeout.
    const waiters = this.qrWaiters.get(id);
    if (!waiters) return;
    this.qrWaiters.delete(id);
    for (const resolve of waiters) resolve('');
  }

  private waitForQrCode(id: string, timeoutMs: number): Promise<string> {
    return new Promise<string>(resolve => {
      const waiters = this.qrWaiters.get(id) ?? [];
      let settled = false;

      const done = (qr: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(qr);
      };

      const timer = setTimeout(() => done(''), timeoutMs);
      timer.unref?.();

      waiters.push(done);
      this.qrWaiters.set(id, waiters);
    });
  }

  private scheduleReconnect(id: string, session: Session): void {
    const state = this.reconnectStates.get(id);
    if (!state) return;

    if (state.attempts >= state.maxAttempts) {
      this.logger.error(`Max reconnect attempts reached for session: ${session.name}`, undefined, {
        sessionId: id,
        attempts: state.attempts,
        action: 'reconnect_failed',
      });
      // Surface the dead end instead of leaving the session looking merely
      // disconnected: `failed` tells the dashboard and the API that a manual
      // POST /sessions/:id/restart is required.
      void this.teardownEngine(id).then(() => this.updateStatus(id, SessionStatus.FAILED));
      return;
    }

    // Exponential backoff: baseDelay * 2^attempts (with jitter)
    const delay = state.baseDelay * Math.pow(2, state.attempts) + Math.random() * 1000;
    state.attempts++;

    this.logger.log(
      `Scheduling reconnect attempt ${state.attempts}/${state.maxAttempts} in ${Math.round(delay / 1000)}s`,
      {
        sessionId: id,
        attempt: state.attempts,
        delayMs: delay,
        action: 'reconnect_scheduled',
      },
    );

    state.timer = setTimeout(() => {
      void this.executeReconnect(id, session, state);
    }, delay);
  }

  private async executeReconnect(id: string, session: Session, state: ReconnectState): Promise<void> {
    try {
      // Clean up old engine
      await this.teardownEngine(id);

      // Re-initialize with the current row: handleDisconnect may have cleared
      // the stored phone, and the session may have been renamed or deleted.
      const current = await this.sessionRepository.findOne({ where: { id } });
      if (!current) {
        this.logger.warn('Session no longer exists; aborting reconnect', { sessionId: id });
        this.cancelReconnect(id);
        return;
      }

      await this.initializeEngine(id, current);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Reconnect attempt ${state.attempts} failed`, errorMessage, {
        sessionId: id,
        action: 'reconnect_error',
      });
      // Schedule another attempt
      this.scheduleReconnect(id, session);
    }
  }

  private cancelReconnect(id: string): void {
    const state = this.reconnectStates.get(id);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.reconnectStates.delete(id);
  }

  async stop(id: string): Promise<Session> {
    const session = await this.findOne(id);

    // Cancel any reconnection attempts
    this.cancelReconnect(id);

    const engine = this.engines.get(id);

    if (engine) {
      // disconnect() closes Chromium but keeps the credentials, so a later
      // start() reconnects without a QR.
      await engine.disconnect().catch((error: unknown) => {
        this.logger.warn('Engine disconnect failed', { sessionId: id, error: String(error) });
      });
      this.engines.delete(id);
      this.rejectQrWaiters(id);
    }

    this.logger.log(`Session stopped: ${session.name}`, {
      sessionId: id,
      action: 'stop',
    });
    await this.updateStatus(id, SessionStatus.DISCONNECTED);
    return this.findOne(id);
  }

  /**
   * Returns the current QR, waiting for one if the engine is still booting.
   * Chromium needs several seconds before WhatsApp Web emits the first QR, so
   * returning 400 immediately forces every client (n8n included) into a retry
   * loop that usually gives up first.
   */
  async getQRCode(id: string, options: { waitMs?: number } = {}): Promise<{ qrCode: string; status: SessionStatus }> {
    const session = await this.findOne(id);
    let engine = this.engines.get(id);

    // Auto-start on demand: asking for a QR is an unambiguous request to bring
    // the session up, and the previous behaviour (400 until someone remembered
    // to call /start) is the main reason sessions looked permanently broken.
    if (!engine) {
      if (session.status === SessionStatus.READY) {
        throw new BadRequestException('Session is already authenticated, no QR code needed');
      }
      await this.start(id, { force: true });
      engine = this.engines.get(id);
      if (!engine) {
        throw new BadRequestException('Session could not be started. Check the logs.');
      }
    }

    let qrCode = engine.getQRCode();

    if (!qrCode) {
      if (engine.getStatus() === EngineStatus.READY) {
        throw new BadRequestException('Session is already authenticated, no QR code needed');
      }

      const waitMs = options.waitMs ?? this.configService.get<number>('engine.qrWaitTimeout', 30000);
      if (waitMs > 0) {
        qrCode = await this.waitForQrCode(id, waitMs);
      }
    }

    if (!qrCode) {
      const current = await this.findOne(id);
      if (current.status === SessionStatus.READY) {
        throw new BadRequestException('Session is already authenticated, no QR code needed');
      }
      throw new BadRequestException('QR code is not ready yet. Please wait...');
    }

    return {
      qrCode,
      status: (await this.findOne(id)).status,
    };
  }

  getEngine(id: string): IWhatsAppEngine | undefined {
    return this.engines.get(id);
  }

  async getGroups(id: string): Promise<{ id: string; name: string }[]> {
    await this.findOne(id); // Verify session exists
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started');
    }

    const groups = await engine.getGroups();
    return groups.map(g => ({
      id: g.id,
      name: g.name,
    }));
  }

  private async removeAuthData(sessionName: string): Promise<void> {
    const dataPath = this.configService.get<string>('engine.sessionDataPath') ?? './data/sessions';
    const authDir = path.resolve(dataPath, `session-${sessionName}`);

    try {
      await fs.rm(authDir, { recursive: true, force: true });
      this.logger.log(`Auth data removed: ${authDir}`, {
        action: 'auth_data_removed',
        sessionName,
      });
    } catch (error) {
      // Windows keeps Chromium profile locks around briefly after destroy();
      // the session row is already gone, so log and move on.
      this.logger.warn(`Could not remove auth data: ${authDir}`, {
        action: 'auth_data_remove_failed',
        sessionName,
        error: String(error),
      });
    }
  }

  private async updateStatus(id: string, status: SessionStatus): Promise<void> {
    await this.sessionRepository.update(id, { status });
    this.logger.debug(`Session status updated to ${status}`, {
      sessionId: id,
      status,
      action: 'status_update',
    });
    // Emit real-time event to connected WebSocket clients
    this.eventsGateway.emitSessionStatus(id, status);
  }

  /**
   * Get overall session statistics for multi-session monitoring
   */
  async getStats(): Promise<{
    total: number;
    active: number;
    ready: number;
    disconnected: number;
    byStatus: Record<string, number>;
    memoryUsage: { heapUsed: number; heapTotal: number; rss: number };
  }> {
    const sessions = await this.findAll();
    const byStatus: Record<string, number> = {};

    for (const session of sessions) {
      byStatus[session.status] = (byStatus[session.status] || 0) + 1;
    }

    const memory = process.memoryUsage();

    return {
      total: sessions.length,
      active: this.engines.size,
      ready: byStatus[SessionStatus.READY] || 0,
      disconnected: byStatus[SessionStatus.DISCONNECTED] || 0,
      byStatus,
      memoryUsage: {
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
        rss: Math.round(memory.rss / 1024 / 1024),
      },
    };
  }

  /**
   * Get count of currently active (running) sessions
   */
  getActiveCount(): number {
    return this.engines.size;
  }

  /**
   * Check if session is currently active (engine running)
   */
  isActive(id: string): boolean {
    return this.engines.has(id);
  }
}
