import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { StorageService } from '../../common/storage/storage.service';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';

export type MediaDeliveryMode = 'inline' | 'storage' | 'none';
export type MediaStorageFailurePolicy = 'skip' | 'inline';

/** Sidecar record written next to every stored attachment. */
export interface StoredMediaMetadata {
  sessionId: string;
  messageId: string;
  mimetype?: string;
  filename?: string;
  size?: number;
  storedAt: string;
  expiresAt: string;
}

/** A stored attachment resolved for download. */
export interface ResolvedStoredMedia {
  data: Buffer;
  metadata: StoredMediaMetadata;
}

export class MediaNotFoundError extends Error {
  constructor() {
    super('Media not found');
    this.name = 'MediaNotFoundError';
  }
}

export class MediaExpiredError extends Error {
  constructor() {
    super('Media has expired');
    this.name = 'MediaExpiredError';
  }
}

/**
 * Path segments are rebuilt from validated parts rather than taken from the
 * request, so a key can never escape the inbound prefix. Anchored, and with no
 * dot allowed anywhere, `..` cannot appear in any segment.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MEDIA_ID_PATTERN = /^[a-f0-9]{32}$/;

const INBOUND_PREFIX = 'inbound';

/**
 * Takes base64 attachments out of the payload that fans out to hooks, webhooks,
 * the queue and the WebSocket.
 *
 * In `inline` mode a single attachment is copied by every consumer - the object
 * spread, the hook chain, one JSON.stringify per webhook, the WebSocket frame -
 * so one 5MB file can touch tens of MB of heap. In `storage` mode it is written
 * once, the base64 is dropped, and what travels is a reference.
 *
 * This bounds retention and copies after the download. It does not remove the
 * initial spike between Chromium and Node.js: whatsapp-web.js hands over the
 * whole file as base64, and that allocation happens before this code runs.
 */
@Injectable()
export class InboundMediaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('InboundMediaService');
  private readonly mode: MediaDeliveryMode;
  private readonly ttlSeconds: number;
  private readonly failurePolicy: MediaStorageFailurePolicy;
  private readonly cleanupIntervalMs: number;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly storageService: StorageService,
  ) {
    this.mode = this.configService.get<MediaDeliveryMode>('engine.messages.media.delivery.mode') ?? 'inline';
    this.ttlSeconds = this.configService.get<number>('engine.messages.media.delivery.ttlSeconds') ?? 86400;
    this.failurePolicy =
      this.configService.get<MediaStorageFailurePolicy>('engine.messages.media.delivery.failurePolicy') ?? 'skip';
    this.cleanupIntervalMs =
      (this.configService.get<number>('engine.messages.media.delivery.cleanupIntervalSeconds') ?? 3600) * 1000;
  }

  onModuleInit(): void {
    if (this.mode !== 'storage') return;

    // Sweep on boot as well: a process that was down past a TTL window would
    // otherwise keep expired files until the first interval elapses.
    void this.cleanupExpired();

    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired();
    }, this.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  getMode(): MediaDeliveryMode {
    return this.mode;
  }

  /**
   * Applies the delivery mode to a message before it fans out.
   *
   * Mutates and returns the same message: the caller is on the hot path for
   * every inbound message, and cloning here would add the copy this whole
   * service exists to avoid.
   */
  async applyDeliveryMode(sessionId: string, message: IncomingMessage): Promise<IncomingMessage> {
    const media = message.media;

    // Nothing to do for a message with no attachment, one that was already
    // skipped upstream, or the compatibility mode.
    if (!media?.data || media.skipped || this.mode === 'inline') {
      return message;
    }

    if (this.mode === 'none') {
      delete media.data;
      media.skipped = true;
      media.skipReason = 'disabled';
      return message;
    }

    try {
      const stored = await this.store(sessionId, message.id, media);

      // Dropped before anything downstream can capture a reference to it.
      delete media.data;
      media.storageKey = stored.storageKey;
      media.url = stored.url;
      media.expiresAt = stored.expiresAt;
    } catch (error) {
      this.logger.error(
        `Failed to persist inbound media for session ${sessionId}`,
        error instanceof Error ? error.message : String(error),
      );

      if (this.failurePolicy === 'inline') {
        // Explicit opt-in: the payload keeps base64 rather than losing the file.
        return message;
      }

      delete media.data;
      media.skipped = true;
      media.skipReason = 'storage-failed';
    }

    return message;
  }

  /**
   * Reads a stored attachment back.
   *
   * @throws MediaNotFoundError for an unknown or malformed reference.
   * @throws MediaExpiredError once past its TTL, even if the sweep has not run.
   */
  async resolve(sessionId: string, date: string, mediaId: string): Promise<ResolvedStoredMedia> {
    const key = InboundMediaService.buildKey(sessionId, date, mediaId);
    if (!key) throw new MediaNotFoundError();

    let metadata: StoredMediaMetadata;
    try {
      const raw = await this.storageService.getFile(`${key}.json`);
      metadata = JSON.parse(raw.toString('utf8')) as StoredMediaMetadata;
    } catch {
      throw new MediaNotFoundError();
    }

    // Checked against the record rather than the URL, so a reference cannot be
    // re-pointed at another session's file by editing the path.
    if (metadata.sessionId !== sessionId) throw new MediaNotFoundError();

    if (new Date(metadata.expiresAt).getTime() <= Date.now()) {
      throw new MediaExpiredError();
    }

    try {
      return { data: await this.storageService.getFile(key), metadata };
    } catch {
      throw new MediaNotFoundError();
    }
  }

  /**
   * Deletes every stored attachment whose TTL has passed.
   *
   * Driven by the sidecar records rather than file timestamps, so a changed TTL
   * applies to files already on disk.
   */
  async cleanupExpired(): Promise<number> {
    let removed = 0;

    let files: string[];
    try {
      files = await this.storageService.listFiles();
    } catch (error) {
      this.logger.warn('Media cleanup could not list storage', { error: String(error) });
      return 0;
    }

    const now = Date.now();

    for (const file of files) {
      const normalised = file.split('\\').join('/');
      if (!normalised.startsWith(`${INBOUND_PREFIX}/`) || !normalised.endsWith('.json')) continue;

      try {
        const raw = await this.storageService.getFile(normalised);
        const metadata = JSON.parse(raw.toString('utf8')) as StoredMediaMetadata;
        if (new Date(metadata.expiresAt).getTime() > now) continue;

        const key = normalised.slice(0, -'.json'.length);
        await this.storageService.deleteFile(key);
        await this.storageService.deleteFile(normalised);
        removed += 1;
      } catch (error) {
        // One unreadable record must not abort the sweep.
        this.logger.debug(`Media cleanup skipped ${normalised}`, { error: String(error) });
      }
    }

    if (removed > 0) {
      this.logger.log(`Media cleanup removed ${removed} expired ${removed === 1 ? 'attachment' : 'attachments'}`);
    }

    return removed;
  }

  private async store(
    sessionId: string,
    messageId: string,
    media: NonNullable<IncomingMessage['media']>,
  ): Promise<{ storageKey: string; url: string; expiresAt: string }> {
    // Unpredictable by construction: a message id is guessable, a storage key
    // must not be, because it is what the download endpoint addresses.
    const mediaId = randomBytes(16).toString('hex');
    const date = new Date().toISOString().slice(0, 10);

    const key = InboundMediaService.buildKey(sessionId, date, mediaId);
    if (!key) {
      throw new Error(`Session id "${sessionId}" cannot be used as a storage path segment`);
    }

    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000).toISOString();
    const metadata: StoredMediaMetadata = {
      sessionId,
      messageId,
      mimetype: media.mimetype,
      filename: media.filename,
      size: media.size,
      storedAt: new Date().toISOString(),
      expiresAt,
    };

    await this.storageService.putFile(key, Buffer.from(media.data ?? '', 'base64'));
    try {
      await this.storageService.putFile(`${key}.json`, Buffer.from(JSON.stringify(metadata), 'utf8'));
    } catch (error) {
      // Without its record the payload is unreadable and invisible to the
      // sweep, so it is removed rather than left behind.
      await this.storageService.deleteFile(key);
      throw error;
    }

    return {
      storageKey: key,
      url: `/api/media/${sessionId}/${date}/${mediaId}`,
      expiresAt,
    };
  }

  /** Returns the storage key, or null when any segment is not well-formed. */
  private static buildKey(sessionId: string, date: string, mediaId: string): string | null {
    if (!SESSION_ID_PATTERN.test(sessionId)) return null;
    if (!DATE_PATTERN.test(date)) return null;
    if (!MEDIA_ID_PATTERN.test(mediaId)) return null;

    return `${INBOUND_PREFIX}/${sessionId}/${date}/${mediaId}`;
  }
}
