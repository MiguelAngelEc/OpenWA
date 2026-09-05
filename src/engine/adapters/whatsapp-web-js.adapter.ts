import { EventEmitter } from 'events';
import { Client, LocalAuth, MessageMedia, Message as WwebMessage } from 'whatsapp-web.js';
import * as qrcode from 'qrcode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import {
  IWhatsAppEngine,
  EngineStatus,
  EngineEventCallbacks,
  DisconnectInfo,
  MessageResult,
  MediaInput,
  IncomingMessage,
  Contact,
  Group,
  GroupInfo,
  GroupParticipant,
  LocationInput,
  ContactCard,
  MessageReaction,
  Label,
  Channel,
  ChannelMessage,
  Status,
  TextStatusOptions,
  StatusResult,
  Catalog,
  Product,
  ProductQueryOptions,
  PaginatedProducts,
} from '../interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import {
  GroupChat,
  MessageWithReactions,
  BusinessClient,
  WwjsChannelData,
  GroupCreateResult,
} from '../types/whatsapp-web-js.types';

export interface WhatsAppWebJsConfig {
  sessionId: string;
  sessionDataPath: string;
  puppeteer?: {
    headless?: boolean;
    args?: string[];
  };
  // Phase 3: Proxy per session
  proxy?: {
    url: string;
    type: 'http' | 'https' | 'socks4' | 'socks5';
  };
  /** Hard cap for initialize(); 0 disables the timeout. */
  initTimeout?: number;
}

export class WhatsAppWebJsAdapter extends EventEmitter implements IWhatsAppEngine {
  private client: Client | null = null;
  private status: EngineStatus = EngineStatus.DISCONNECTED;
  private qrCode: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  private callbacks: EngineEventCallbacks = {};
  private destroyed = false;
  private browserPid: number | null = null;
  private pidTracker: NodeJS.Timeout | null = null;

  constructor(private readonly config: WhatsAppWebJsConfig) {
    super();
  }

  private readonly logger = createLogger('WhatsAppWebJsAdapter');

  /**
   * Absolute folder LocalAuth uses for this session's Chromium profile.
   * Kept public so the session layer can wipe credentials after a logout
   * without having to re-derive the path (and get it wrong).
   */
  getAuthDir(): string {
    return path.resolve(this.config.sessionDataPath, `session-${this.config.sessionId}`);
  }

  /**
   * File holding the PID of the Chromium we spawned. Chromium outlives the API
   * whenever the process is killed without a clean shutdown (SIGKILL, a crash,
   * a watcher restart). The orphan keeps the profile locked, so the next launch
   * waits forever for a debug port it will never get - the session then sits in
   * `initializing` with no QR. Persisting the PID is what lets the next boot
   * kill it.
   */
  private getPidFile(): string {
    return path.resolve(this.config.sessionDataPath, `session-${this.config.sessionId}.pid`);
  }

  private static isAlive(pid: number): boolean {
    try {
      // Signal 0 performs the existence check without signalling.
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Image name of a running process, used to avoid killing a recycled PID. */
  private static getProcessName(pid: number): Promise<string> {
    const cmd = process.platform === 'win32' ? 'tasklist' : 'ps';
    const args =
      process.platform === 'win32' ? ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'] : ['-p', String(pid), '-o', 'comm='];

    return new Promise<string>(resolve => {
      execFile(cmd, args, { timeout: 5000 }, (error, stdout) => {
        resolve(error ? '' : String(stdout).toLowerCase());
      });
    });
  }

  private static killProcessTree(pid: number): Promise<void> {
    if (process.platform === 'win32') {
      // Chromium spawns renderer/GPU children; /T takes the whole tree.
      return new Promise<void>(resolve => {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10000 }, () => resolve());
      });
    }

    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
    return Promise.resolve();
  }

  /**
   * Kill a Chromium left behind by a previous run before touching the profile.
   * Only a process that is still alive AND still looks like a browser is
   * killed, so a recycled PID cannot take down something unrelated.
   */
  private async killStaleBrowser(): Promise<void> {
    const pidFile = this.getPidFile();

    let pid: number;
    try {
      pid = Number.parseInt(await fs.readFile(pidFile, 'utf8'), 10);
    } catch {
      return; // no previous run recorded
    }

    if (!Number.isInteger(pid) || pid <= 0 || !WhatsAppWebJsAdapter.isAlive(pid)) {
      await fs.rm(pidFile, { force: true }).catch(() => undefined);
      return;
    }

    const name = await WhatsAppWebJsAdapter.getProcessName(pid);
    if (!/chrom/.test(name)) {
      this.logger.warn(`PID ${pid} is not a browser (${name.trim() || 'unknown'}); leaving it alone`);
      await fs.rm(pidFile, { force: true }).catch(() => undefined);
      return;
    }

    this.logger.warn(`Killing orphaned browser from a previous run (pid ${pid})`);
    await WhatsAppWebJsAdapter.killProcessTree(pid);
    await fs.rm(pidFile, { force: true }).catch(() => undefined);
  }

  /**
   * whatsapp-web.js exposes the browser only after launch, so poll briefly to
   * record its PID. Without it a later hard kill has no target.
   */
  private trackBrowserPid(): void {
    const deadline = Date.now() + 60000;

    const poll = (): void => {
      const pid = this.client?.pupBrowser?.process()?.pid;
      if (pid) {
        this.browserPid = pid;
        void fs.writeFile(this.getPidFile(), String(pid), 'utf8').catch(() => undefined);
        return;
      }
      if (Date.now() > deadline || this.destroyed) return;
      this.pidTracker = setTimeout(poll, 250);
      this.pidTracker.unref?.();
    };

    poll();
  }

  /** Last resort when client.destroy() hangs or was never reached. */
  private async hardKillBrowser(): Promise<void> {
    if (this.pidTracker) {
      clearTimeout(this.pidTracker);
      this.pidTracker = null;
    }

    const pid = this.browserPid;
    this.browserPid = null;

    if (pid && WhatsAppWebJsAdapter.isAlive(pid)) {
      this.logger.warn(`Force killing browser process ${pid}`);
      await WhatsAppWebJsAdapter.killProcessTree(pid);
    }

    await fs.rm(this.getPidFile(), { force: true }).catch(() => undefined);
  }

  /**
   * Chromium refuses to reuse a profile that still holds the singleton locks a
   * previous run left behind. An API killed with SIGKILL (docker kill, crash,
   * a second Ctrl+C) always leaves them, and the next launch then hangs before
   * WhatsApp Web loads - so no `qr` and no `ready` event ever fires and the
   * session sits in `initializing` forever. Clearing them is safe: if another
   * live Chromium really owned this profile we would not be initializing.
   */
  private async clearProfileLocks(): Promise<void> {
    const authDir = this.getAuthDir();
    const locks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'];

    for (const lock of locks) {
      try {
        await fs.rm(path.join(authDir, lock), { force: true, recursive: true });
      } catch (error) {
        this.logger.debug(`Could not remove profile lock ${lock}: ${String(error)}`);
      }
    }
  }

  /** Delete the stored credentials so the next initialize() yields a fresh QR. */
  async clearAuthData(): Promise<void> {
    const authDir = this.getAuthDir();
    try {
      await fs.rm(authDir, { recursive: true, force: true });
      this.logger.log(`Auth data cleared: ${authDir}`);
    } catch (error) {
      this.logger.warn(`Could not clear auth data: ${authDir}`, String(error));
    }
  }

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.destroyed = false;
    this.qrCode = null;
    this.setStatus(EngineStatus.INITIALIZING);

    try {
      // Order matters: kill the previous browser BEFORE deleting the lock
      // files, otherwise a live Chromium keeps owning the profile while its
      // evidence is gone, and the new launch blocks on the debug port.
      await this.killStaleBrowser();
      await this.clearProfileLocks();

      // Build puppeteer args, including proxy if configured
      const puppeteerArgs = this.config.puppeteer?.args || [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ];

      // Add proxy configuration if provided
      if (this.config.proxy) {
        puppeteerArgs.push(`--proxy-server=${this.config.proxy.url}`);
        this.logger.log(
          `Using proxy: ${this.config.proxy.type}://${this.config.proxy.url.replace(/:[^:@]*@/, ':***@')}`,
        );
      }

      this.client = new Client({
        authStrategy: new LocalAuth({
          clientId: this.config.sessionId,
          dataPath: path.resolve(this.config.sessionDataPath),
        }),
        puppeteer: {
          headless: this.config.puppeteer?.headless ?? true,
          args: puppeteerArgs,
        },
        // Reclaim the WhatsApp Web slot instead of dying when the same account
        // is open elsewhere - otherwise a stale tab keeps the session offline.
        takeoverOnConflict: true,
        takeoverTimeoutMs: 10000,
      });

      this.setupEventHandlers();
      const initPromise = this.client.initialize();
      this.trackBrowserPid();
      await this.withInitTimeout(initPromise);

      if (this.pidTracker) {
        clearTimeout(this.pidTracker);
        this.pidTracker = null;
      }
    } catch (error) {
      this.setStatus(EngineStatus.FAILED);
      // A half-open Chromium keeps the profile locked and blocks every retry.
      await this.destroy().catch(() => undefined);
      throw error;
    }
  }

  /**
   * client.initialize() can hang indefinitely (dead profile, no network to
   * web.whatsapp.com, Chromium that never exposes its debug port). Fail loudly
   * instead, so the caller can clean up and retry.
   */
  private async withInitTimeout<T>(promise: Promise<T>): Promise<T> {
    const timeout = this.config.initTimeout ?? 90000;
    if (timeout <= 0) return promise;

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Engine initialize timed out after ${timeout}ms`)), timeout);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on('qr', async (qr: string) => {
      try {
        this.qrCode = await qrcode.toDataURL(qr);
        this.setStatus(EngineStatus.QR_READY);
        this.callbacks.onQRCode?.(this.qrCode);
      } catch (error) {
        this.logger.error('Error generating QR code', String(error));
      }
    });

    this.client.on('authenticated', () => {
      this.setStatus(EngineStatus.AUTHENTICATING);
      this.qrCode = null;
    });

    this.client.on('ready', () => {
      try {
        const info = this.client?.info;
        this.phoneNumber = info?.wid?.user || null;
        this.pushName = info?.pushname || null;
        this.setStatus(EngineStatus.READY);
        this.callbacks.onReady?.(this.phoneNumber || '', this.pushName || '');
      } catch (error) {
        this.logger.error('Error getting client info', String(error));
        this.setStatus(EngineStatus.READY);
        this.callbacks.onReady?.('', '');
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on('message', async msg => {
      try {
        const incomingMessage: IncomingMessage = {
          id: msg.id._serialized,
          from: msg.from,
          to: msg.to,
          chatId: msg.from,
          body: msg.body,
          type: msg.type,
          timestamp: msg.timestamp,
          fromMe: msg.fromMe,
          isGroup: msg.from.endsWith('@g.us'),
        };

        // Handle media
        if (msg.hasMedia) {
          try {
            const media = await msg.downloadMedia();
            if (media) {
              incomingMessage.media = {
                mimetype: media.mimetype,
                filename: media.filename || undefined,
                data: media.data,
              };
            }
          } catch (error) {
            this.logger.error('Error downloading media', String(error));
          }
        }

        // Handle quoted message
        if (msg.hasQuotedMsg) {
          try {
            const quoted = await msg.getQuotedMessage();
            incomingMessage.quotedMessage = {
              id: quoted.id._serialized,
              body: quoted.body,
            };
          } catch (error) {
            this.logger.error('Error getting quoted message', String(error));
          }
        }

        this.callbacks.onMessage?.(incomingMessage);
      } catch (error) {
        this.logger.error('Error processing incoming message', String(error));
      }
    });

    this.client.on('message_ack', (msg, ack) => {
      this.callbacks.onMessageAck?.(msg.id._serialized, ack);
    });

    this.client.on('loading_screen', (percent, message) => {
      this.logger.debug(`Loading WhatsApp Web: ${String(percent)}% ${String(message)}`);
    });

    this.client.on('change_state', state => {
      this.logger.debug(`Client state changed: ${String(state)}`);
    });

    this.client.on('disconnected', reason => {
      const info: DisconnectInfo = {
        reason: String(reason),
        requiresReauth: WhatsAppWebJsAdapter.isReauthReason(String(reason)),
      };
      this.qrCode = null;
      this.setStatus(EngineStatus.DISCONNECTED);
      // The Chromium instance survives a `disconnected` event and keeps the
      // profile locked, which is what makes the next start() produce no QR.
      void this.destroy().catch(() => undefined);
      this.callbacks.onDisconnected?.(info.reason, info);
    });

    this.client.on('auth_failure', message => {
      this.qrCode = null;
      this.setStatus(EngineStatus.FAILED);
      void this.destroy().catch(() => undefined);
      this.callbacks.onDisconnected?.(`Authentication failed: ${String(message ?? '')}`.trim(), {
        reason: 'AUTH_FAILURE',
        requiresReauth: true,
      });
    });
  }

  /**
   * Reasons whatsapp-web.js reports when the stored credentials are no longer
   * usable. Reconnecting with the same LocalAuth folder then silently stalls,
   * so these must trigger an auth wipe rather than a plain retry.
   */
  private static isReauthReason(reason: string): boolean {
    const upper = reason.toUpperCase();
    return ['LOGOUT', 'UNPAIRED', 'UNPAIRED_IDLE', 'UNLAUNCHED', 'BANNED', 'CONFLICT'].some(r => upper.includes(r));
  }

  private setStatus(status: EngineStatus): void {
    this.status = status;
    this.callbacks.onStateChanged?.(status);
    this.emit('stateChanged', status);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        // Use destroy instead of logout to preserve session data
        // This allows reconnecting without needing to scan QR again
        await this.client.destroy();
      } catch (error) {
        this.logger.warn('Destroy client failed:', String(error));
        // Already destroyed or not initialized - ignore
      }
      this.client = null;
      this.destroyed = true;
      await this.hardKillBrowser();
      this.setStatus(EngineStatus.DISCONNECTED);
    }
  }

  async logout(): Promise<void> {
    if (this.client) {
      try {
        // Logout clears session data - user will need to scan QR again
        await this.client.logout();
      } catch (error) {
        this.logger.warn('Logout failed:', String(error));
        // Fall back to destroy if logout fails
        try {
          await this.client.destroy();
        } catch (destroyError) {
          this.logger.warn('Client destroy also failed during logout fallback', String(destroyError));
        }
      }
      this.client = null;
      this.destroyed = true;
      await this.hardKillBrowser();
      this.setStatus(EngineStatus.DISCONNECTED);
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    const client = this.client;
    this.client = null;
    this.qrCode = null;

    if (client) {
      try {
        // client.destroy() talks to a page that may already be unresponsive;
        // without a bound it hangs and takes the whole teardown with it.
        await Promise.race([
          client.destroy(),
          new Promise<void>(resolve => {
            const timer = setTimeout(resolve, 10000);
            timer.unref?.();
          }),
        ]);
      } catch (error) {
        // Chromium may already be gone; the hard kill below is the backstop.
        this.logger.warn('Client destroy failed', String(error));
      }
      this.setStatus(EngineStatus.DISCONNECTED);
    }

    await this.hardKillBrowser();
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getQRCode(): string | null {
    return this.qrCode;
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getPushName(): string | null {
    return this.pushName;
  }

  /**
   * whatsapp-web.js can resolve sendMessage() with an undefined model even when
   * the message was delivered, which used to surface as a 500 on every send
   * endpoint. Treat a missing model as a successful send with an unknown id.
   */
  private toMessageResult(msg?: WwebMessage): MessageResult {
    const id = msg?.id?._serialized;

    if (!id) {
      this.logger.warn('sendMessage resolved without a message model; reporting send as accepted');
      return { id: '', timestamp: Math.floor(Date.now() / 1000) };
    }

    return { id, timestamp: msg.timestamp };
  }

  async sendTextMessage(chatId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    const msg = await this.client!.sendMessage(chatId, text);
    return this.toMessageResult(msg);
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  private async sendMediaMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();

    let messageMedia: MessageMedia;

    if (typeof media.data === 'string') {
      if (media.data.startsWith('http://') || media.data.startsWith('https://')) {
        // URL
        messageMedia = await MessageMedia.fromUrl(media.data);
      } else {
        // Base64
        messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
      }
    } else {
      // Buffer
      messageMedia = new MessageMedia(media.mimetype, media.data.toString('base64'), media.filename);
    }

    const msg = await this.client!.sendMessage(chatId, messageMedia, {
      caption: media.caption,
    });

    return this.toMessageResult(msg);
  }

  async getContacts(): Promise<Contact[]> {
    this.ensureReady();
    const contacts = await this.client!.getContacts();

    return contacts.map(c => ({
      id: c.id._serialized,
      name: c.name || undefined,
      pushName: c.pushname || undefined,
      number: c.number,
      isMyContact: c.isMyContact,
      isBlocked: c.isBlocked,
    }));
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    this.ensureReady();
    try {
      const contact = await this.client!.getContactById(contactId);
      return {
        id: contact.id._serialized,
        name: contact.name || undefined,
        pushName: contact.pushname || undefined,
        number: contact.number,
        isMyContact: contact.isMyContact,
        isBlocked: contact.isBlocked,
      };
    } catch (error) {
      this.logger.warn(`Failed to get contact: ${contactId}`, String(error));
      return null;
    }
  }

  async checkNumberExists(number: string): Promise<boolean> {
    this.ensureReady();
    const numberId = await this.client!.getNumberId(number);
    return numberId !== null;
  }

  async getGroups(): Promise<Group[]> {
    this.ensureReady();

    let chats;
    try {
      chats = await this.client!.getChats();
    } catch (error) {
      // client.getChats() serializes EVERY chat through one Promise.all, so a
      // single unserializable chat (a group whose metadata lookup hits
      // "Failed to execute 'get' on 'IDBObjectStore'") fails the whole listing
      // and the endpoint answers 500. Fall back to reading the group chats
      // straight off the collection, tolerating the bad ones.
      this.logger.warn(`getChats failed, falling back to direct group enumeration: ${String(error)}`);
      return this.getGroupsFallback();
    }

    // Filter only group chats
    const groups = chats.filter(chat => chat.isGroup);

    return groups.map(g => {
      const groupChat = g as unknown as GroupChat;
      return {
        id: g.id._serialized,
        name: g.name,
        participantsCount: groupChat.participants?.length,
        isAdmin: groupChat.participants?.some(
          p => p.isAdmin && p.id._serialized === this.client?.info?.wid?._serialized,
        ),
      };
    });
  }

  /**
   * Minimal, failure-tolerant group listing read directly from WhatsApp Web's
   * chat collection. Chats that cannot be read are skipped instead of taking
   * the whole response down with them.
   */
  private async getGroupsFallback(): Promise<Group[]> {
    const page = this.client?.pupPage;
    if (!page) {
      throw new Error('WhatsApp client is not ready');
    }

    const groups = await page.evaluate(() => {
      const collections = (window as unknown as { require: (m: string) => unknown }).require('WAWebCollections') as {
        Chat: { getModelsArray: () => unknown[] };
      };

      const result: Array<{ id: string; name: string; participantsCount?: number }> = [];

      for (const raw of collections.Chat.getModelsArray()) {
        try {
          const chat = raw as {
            id?: { _serialized?: string; server?: string };
            name?: string;
            formattedTitle?: string;
            groupMetadata?: { participants?: { getModelsArray?: () => unknown[] } };
          };

          const id = chat.id?._serialized;
          if (!id || chat.id?.server !== 'g.us') continue;

          result.push({
            id,
            name: chat.name || chat.formattedTitle || id,
            participantsCount: chat.groupMetadata?.participants?.getModelsArray?.().length,
          });
        } catch {
          // skip the chat we cannot read
        }
      }

      return result;
    });

    this.logger.log(`Group fallback returned ${groups.length} group(s)`);
    return groups;
  }

  // ============= Phase 3: Extended Messaging =============

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    this.ensureReady();
    // Import Location class dynamically from whatsapp-web.js
    const { Location } = await import('whatsapp-web.js');
    const loc = new Location(location.latitude, location.longitude, {
      name: location.description || '',
      address: location.address || '',
    });
    const msg = await this.client!.sendMessage(chatId, loc);
    return this.toMessageResult(msg);
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    this.ensureReady();
    // Create vCard format
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${contact.name}`,
      `TEL;type=CELL;type=VOICE;waid=${contact.number}:+${contact.number}`,
      'END:VCARD',
    ].join('\n');

    const msg = await this.client!.sendMessage(chatId, vcard, {
      parseVCards: true,
    });
    return this.toMessageResult(msg);
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    let messageMedia: MessageMedia;

    if (typeof media.data === 'string') {
      if (media.data.startsWith('http://') || media.data.startsWith('https://')) {
        messageMedia = await MessageMedia.fromUrl(media.data);
      } else {
        messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
      }
    } else {
      messageMedia = new MessageMedia(media.mimetype, media.data.toString('base64'), media.filename);
    }

    const msg = await this.client!.sendMessage(chatId, messageMedia, {
      sendMediaAsSticker: true,
    });
    return this.toMessageResult(msg);
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    // Find the message to quote
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const quotedMsg = messages.find(m => m.id._serialized === quotedMsgId);

    if (!quotedMsg) {
      throw new Error(`Message ${quotedMsgId} not found`);
    }

    const msg = await quotedMsg.reply(text);
    return this.toMessageResult(msg);
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    this.ensureReady();
    const chat = await this.client!.getChatById(fromChatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const msgToForward = messages.find(m => m.id._serialized === messageId);

    if (!msgToForward) {
      throw new Error(`Message ${messageId} not found`);
    }

    await msgToForward.forward(toChatId);
    // forward() returns void, so we generate a result based on original message
    return {
      id: `fwd_${messageId}`,
      timestamp: Date.now(),
    };
  }

  // ============= Phase 3: Group Management =============

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    this.ensureReady();
    try {
      const chat = await this.client!.getChatById(groupId);
      if (!chat.isGroup) {
        return null;
      }
      const groupChat = chat as unknown as GroupChat;
      const participants: GroupParticipant[] = (groupChat.participants || []).map(p => ({
        id: String(p.id._serialized),
        number: String(p.id.user),
        name: p.name ? String(p.name) : undefined,
        isAdmin: Boolean(p.isAdmin),
        isSuperAdmin: Boolean(p.isSuperAdmin),
      }));

      return {
        id: chat.id._serialized,
        name: chat.name,
        description: groupChat.description ? String(groupChat.description) : undefined,
        owner: groupChat.owner?._serialized ? String(groupChat.owner._serialized) : undefined,
        createdAt: groupChat.createdAt,
        participants,
        isReadOnly: Boolean(groupChat.isReadOnly),
        isAnnounce: Boolean(groupChat.isAnnounce),
      };
    } catch (error) {
      this.logger.warn(`Failed to get group: ${groupId}`, String(error));
      return null;
    }
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    this.ensureReady();
    // Ensure participant IDs are in correct format
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    const result = await this.client!.createGroup(name, participantIds);

    const groupId = String((result as unknown as GroupCreateResult).gid._serialized);
    return {
      id: groupId,
      name: name,
      participantsCount: participants.length,
    };
  }

  async addParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).addParticipants(participantIds);
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).removeParticipants(participantIds);
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).promoteParticipants(participantIds);
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).demoteParticipants(participantIds);
  }

  async leaveGroup(groupId: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).leave();
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).setSubject(subject);
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).setDescription(description);
  }

  // Reactions (Phase 3)
  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in chat ${chatId}`);
    }
    await (message as MessageWithReactions).react(emoji);
    this.logger.log(`Reacted to message ${messageId} with ${emoji || '(removed)'}`);
  }

  async getMessageReactions(chatId: string, messageId: string): Promise<MessageReaction[]> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in chat ${chatId}`);
    }
    const msgWithReactions = message as MessageWithReactions;
    if (!msgWithReactions.hasReaction) {
      return [];
    }
    const reactions = await msgWithReactions.getReactions();
    if (!reactions) {
      return [];
    }
    // Map reactions to our interface format
    const result: MessageReaction[] = [];

    for (const r of reactions) {
      result.push({
        emoji: String(r.id),
        senders: (r.senders || []).map(s => ({
          senderId: String(s.senderId),
          emoji: String(s.reaction),
          timestamp: Number(s.timestamp),
        })),
      });
    }
    return result;
  }

  // Labels (Phase 3) - WhatsApp Business only
  async getLabels(): Promise<Label[]> {
    this.ensureReady();
    const labels = await (this.client as unknown as BusinessClient).getLabels();
    if (!labels) {
      return [];
    }

    return labels.map(label => ({
      id: String(label.id),
      name: String(label.name),
      hexColor: String(label.hexColor),
    }));
  }

  async getLabelById(labelId: string): Promise<Label | null> {
    this.ensureReady();
    const label = await (this.client as unknown as BusinessClient).getLabelById(labelId);
    if (!label) {
      return null;
    }
    return {
      id: String(label.id),
      name: String(label.name),
      hexColor: String(label.hexColor),
    };
  }

  async getChatLabels(chatId: string): Promise<Label[]> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const labels = await (chat as unknown as GroupChat).getLabels();
    if (!labels) {
      return [];
    }

    return labels.map(label => ({
      id: String(label.id),
      name: String(label.name),
      hexColor: String(label.hexColor),
    }));
  }

  async addLabelToChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    await (chat as unknown as GroupChat).addLabel(labelId);
    this.logger.log(`Added label ${labelId} to chat ${chatId}`);
  }

  async removeLabelFromChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    await (chat as unknown as GroupChat).removeLabel(labelId);
    this.logger.log(`Removed label ${labelId} from chat ${chatId}`);
  }

  // Channels/Newsletter (Phase 3)
  async getSubscribedChannels(): Promise<Channel[]> {
    this.ensureReady();
    const channels = await (this.client as unknown as BusinessClient).getChannels();
    if (!channels) {
      return [];
    }
    return channels.map((ch: WwjsChannelData) => ({
      id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
      name: String(ch.name || ''),
      description: ch.description ? String(ch.description) : undefined,
      inviteCode: ch.inviteCode ? String(ch.inviteCode) : undefined,
      subscriberCount: ch.subscriberCount ? Number(ch.subscriberCount) : undefined,
      verified: ch.verified ? Boolean(ch.verified) : undefined,
    }));
  }

  async getChannelById(channelId: string): Promise<Channel | null> {
    this.ensureReady();
    try {
      const ch = await (this.client as unknown as BusinessClient).getChannelById(channelId);
      if (!ch) {
        return null;
      }
      return {
        id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
        name: String(ch.name || ''),
        description: ch.description ? String(ch.description) : undefined,
        inviteCode: ch.inviteCode ? String(ch.inviteCode) : undefined,
        subscriberCount: ch.subscriberCount ? Number(ch.subscriberCount) : undefined,
        verified: ch.verified ? Boolean(ch.verified) : undefined,
      };
    } catch (error) {
      this.logger.warn(`Failed to get channel: ${channelId}`, String(error));
      return null;
    }
  }

  async subscribeToChannel(inviteCode: string): Promise<Channel> {
    this.ensureReady();
    const ch = await (this.client as unknown as BusinessClient).subscribeToChannel(inviteCode);
    this.logger.log(`Subscribed to channel with invite code: ${inviteCode}`);
    return {
      id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
      name: String(ch.name || ''),
      description: ch.description ? String(ch.description) : undefined,
    };
  }

  async unsubscribeFromChannel(channelId: string): Promise<void> {
    this.ensureReady();
    await (this.client as unknown as BusinessClient).unsubscribeFromChannel(channelId);
    this.logger.log(`Unsubscribed from channel: ${channelId}`);
  }

  async getChannelMessages(channelId: string, limit: number = 50): Promise<ChannelMessage[]> {
    this.ensureReady();
    try {
      const ch = await (this.client as unknown as BusinessClient).getChannelById(channelId);
      if (!ch) {
        throw new Error(`Channel ${channelId} not found`);
      }
      const messages = await ch.fetchMessages({ limit });
      if (!messages) {
        return [];
      }
      return messages.map(msg => ({
        id: String(typeof msg.id === 'object' ? msg.id._serialized : msg.id),
        body: String(msg.body || ''),
        timestamp: Number(msg.timestamp),
        hasMedia: Boolean(msg.hasMedia),
        mediaUrl: msg.mediaUrl ? String(msg.mediaUrl) : undefined,
      }));
    } catch (error) {
      this.logger.error(`Failed to get channel messages: ${String(error)}`);
      return [];
    }
  }

  // ========== Gap Quick Wins Implementation ==========

  // Delete Message
  async deleteMessage(chatId: string, messageId: string, forEveryone: boolean = true): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId || m.id.id === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in chat ${chatId}`);
    }
    await message.delete(forEveryone);
    this.logger.log(`Deleted message ${messageId} from chat ${chatId} (forEveryone: ${forEveryone})`);
  }

  // Get Profile Picture
  async getProfilePicture(contactId: string): Promise<string | null> {
    this.ensureReady();
    try {
      const url = await this.client!.getProfilePicUrl(contactId);
      return url || null;
    } catch (error) {
      this.logger.warn(`Failed to get profile picture for ${contactId}: ${String(error)}`);
      return null;
    }
  }

  // Block Contact
  async blockContact(contactId: string): Promise<void> {
    this.ensureReady();
    const contact = await this.client!.getContactById(contactId);
    await contact.block();
    this.logger.log(`Blocked contact ${contactId}`);
  }

  // Unblock Contact
  async unblockContact(contactId: string): Promise<void> {
    this.ensureReady();
    const contact = await this.client!.getContactById(contactId);
    await contact.unblock();
    this.logger.log(`Unblocked contact ${contactId}`);
  }

  // Get Group Invite Code
  async getGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error(`${groupId} is not a group`);
    }
    const inviteCode = await (chat as unknown as GroupChat).getInviteCode();
    this.logger.log(`Got invite code for group ${groupId}`);
    return String(inviteCode);
  }

  // Revoke Group Invite Code
  async revokeGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error(`${groupId} is not a group`);
    }
    const newCode = await (chat as unknown as GroupChat).revokeInvite();
    this.logger.log(`Revoked invite code for group ${groupId}, new code generated`);
    return String(newCode);
  }

  // ========== Status/Stories (Phase 3) ==========
  // Note: These are stub implementations - whatsapp-web.js has limited Status API support
  /* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */

  async getContactStatuses(): Promise<Status[]> {
    this.ensureReady();
    // whatsapp-web.js has limited Status API support
    // This is a stub that can be enhanced when the library adds support
    this.logger.warn('getContactStatuses not fully implemented in whatsapp-web.js');
    return [];
  }

  async getContactStatus(_contactId: string): Promise<Status[]> {
    this.ensureReady();
    this.logger.warn('getContactStatus not fully implemented in whatsapp-web.js');
    return [];
  }

  async postTextStatus(_text: string, _options?: TextStatusOptions): Promise<StatusResult> {
    this.ensureReady();
    // whatsapp-web.js doesn't have native status posting
    // This would require using the underlying WhatsApp Web API directly
    throw new Error('postTextStatus not yet implemented in whatsapp-web.js adapter');
  }

  async postImageStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {
    this.ensureReady();
    throw new Error('postImageStatus not yet implemented in whatsapp-web.js adapter');
  }

  async postVideoStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {
    this.ensureReady();
    throw new Error('postVideoStatus not yet implemented in whatsapp-web.js adapter');
  }

  async deleteStatus(_statusId: string): Promise<void> {
    this.ensureReady();
    throw new Error('deleteStatus not yet implemented in whatsapp-web.js adapter');
  }

  // ========== Catalog (Phase 3) ==========

  async getCatalog(): Promise<Catalog | null> {
    this.ensureReady();
    // whatsapp-web.js doesn't have native Catalog API support
    this.logger.warn('getCatalog not implemented in whatsapp-web.js adapter');
    return null;
  }

  async getProducts(_options?: ProductQueryOptions): Promise<PaginatedProducts> {
    this.ensureReady();
    this.logger.warn('getProducts not implemented in whatsapp-web.js adapter');
    return {
      products: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    };
  }

  async getProduct(_productId: string): Promise<Product | null> {
    this.ensureReady();
    this.logger.warn('getProduct not implemented in whatsapp-web.js adapter');
    return null;
  }

  async sendProduct(_chatId: string, _productId: string, _body?: string): Promise<MessageResult> {
    this.ensureReady();
    throw new Error('sendProduct not yet implemented in whatsapp-web.js adapter');
  }

  async sendCatalog(_chatId: string, _body?: string): Promise<MessageResult> {
    this.ensureReady();
    throw new Error('sendCatalog not yet implemented in whatsapp-web.js adapter');
  }

  /* eslint-enable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */

  private ensureReady(): void {
    if (this.status !== EngineStatus.READY || !this.client) {
      throw new Error('WhatsApp client is not ready');
    }
  }
}
