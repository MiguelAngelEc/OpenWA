import { ConfigService } from '@nestjs/config';
import { StorageService } from '../../common/storage/storage.service';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import {
  InboundMediaService,
  MediaDeliveryMode,
  MediaExpiredError,
  MediaNotFoundError,
  MediaStorageFailurePolicy,
  StoredMediaMetadata,
} from './inbound-media.service';

/** In-memory stand-in for the real storage backends. */
class FakeStorage {
  readonly files = new Map<string, Buffer>();
  putFile = jest.fn((key: string, data: Buffer) => {
    this.files.set(key, data);
    return Promise.resolve();
  });
  getFile = jest.fn((key: string) => {
    const data = this.files.get(key);
    return data ? Promise.resolve(data) : Promise.reject(new Error('ENOENT'));
  });
  deleteFile = jest.fn((key: string) => {
    this.files.delete(key);
    return Promise.resolve();
  });
  listFiles = jest.fn(() => Promise.resolve([...this.files.keys()]));
}

describe('InboundMediaService', () => {
  const build = (
    options: {
      mode?: MediaDeliveryMode;
      ttlSeconds?: number;
      failurePolicy?: MediaStorageFailurePolicy;
      storage?: FakeStorage;
    } = {},
  ) => {
    const storage = options.storage ?? new FakeStorage();
    const config = {
      get: jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          'engine.messages.media.delivery.mode': options.mode ?? 'storage',
          'engine.messages.media.delivery.ttlSeconds': options.ttlSeconds ?? 86400,
          'engine.messages.media.delivery.failurePolicy': options.failurePolicy ?? 'skip',
          'engine.messages.media.delivery.cleanupIntervalSeconds': 3600,
        };
        return values[key];
      }),
    } as unknown as ConfigService;

    const service = new InboundMediaService(config, storage as unknown as StorageService);
    return { service, storage };
  };

  const message = (media?: IncomingMessage['media']): IncomingMessage => ({
    id: 'msg-1',
    from: '5215512345678@c.us',
    to: '5215500000000@c.us',
    chatId: '5215512345678@c.us',
    body: 'hola',
    type: 'image',
    timestamp: 1700000000,
    fromMe: false,
    isGroup: false,
    media,
  });

  const attachment = (): NonNullable<IncomingMessage['media']> => ({
    mimetype: 'image/jpeg',
    filename: 'photo.jpg',
    size: 1024,
    data: Buffer.from('file-bytes').toString('base64'),
  });

  const readMetadata = (storage: FakeStorage, storageKey: string): StoredMediaMetadata =>
    JSON.parse((storage.files.get(`${storageKey}.json`) as Buffer).toString('utf8')) as StoredMediaMetadata;

  // ── Delivery modes ────────────────────────────────────────────────

  describe('inline mode', () => {
    it('leaves the payload untouched, preserving the existing contract', async () => {
      const { service, storage } = build({ mode: 'inline' });
      const original = attachment().data;

      const result = await service.applyDeliveryMode('sess-1', message(attachment()));

      expect(result.media?.data).toBe(original);
      expect(storage.putFile).not.toHaveBeenCalled();
    });
  });

  describe('none mode', () => {
    it('drops the payload without storing anything', async () => {
      const { service, storage } = build({ mode: 'none' });

      const result = await service.applyDeliveryMode('sess-1', message(attachment()));

      expect(result.media?.data).toBeUndefined();
      expect(result.media).toMatchObject({ skipped: true, skipReason: 'disabled' });
      expect(storage.putFile).not.toHaveBeenCalled();
    });
  });

  describe('storage mode', () => {
    it('persists the file and removes the base64 from the payload', async () => {
      const { service, storage } = build();

      const result = await service.applyDeliveryMode('sess-1', message(attachment()));

      expect(result.media?.data).toBeUndefined();
      expect(result.media?.storageKey).toMatch(/^inbound\/sess-1\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{32}$/);
      expect(result.media?.url).toMatch(/^\/api\/media\/sess-1\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{32}$/);
      expect(result.media?.expiresAt).toEqual(expect.any(String));

      // Stored as the real file, not as base64 text.
      expect(storage.files.get(result.media?.storageKey ?? '')?.toString('utf8')).toBe('file-bytes');
    });

    it('keeps the metadata a consumer needs to decide what to do next', async () => {
      const { service, storage } = build();

      const result = await service.applyDeliveryMode('sess-1', message(attachment()));

      expect(result.media).toMatchObject({ mimetype: 'image/jpeg', filename: 'photo.jpg', size: 1024 });
      expect(readMetadata(storage, result.media?.storageKey ?? '')).toMatchObject({
        sessionId: 'sess-1',
        messageId: 'msg-1',
        mimetype: 'image/jpeg',
      });
    });

    it('gives every attachment an unpredictable key', async () => {
      const { service } = build();

      const first = await service.applyDeliveryMode('sess-1', message(attachment()));
      const second = await service.applyDeliveryMode('sess-1', message(attachment()));

      expect(first.media?.storageKey).not.toBe(second.media?.storageKey);
    });

    it('ignores a message whose attachment was already skipped upstream', async () => {
      const { service, storage } = build();

      const result = await service.applyDeliveryMode(
        'sess-1',
        message({ mimetype: 'video/mp4', skipped: true, skipReason: 'too-large' }),
      );

      expect(storage.putFile).not.toHaveBeenCalled();
      expect(result.media?.skipReason).toBe('too-large');
    });

    it('ignores a message with no attachment at all', async () => {
      const { service, storage } = build();

      await service.applyDeliveryMode('sess-1', message());

      expect(storage.putFile).not.toHaveBeenCalled();
    });
  });

  // ── Failure policy ────────────────────────────────────────────────

  describe('storage failures', () => {
    it('drops the payload under the default skip policy, rather than reintroducing the spike', async () => {
      const storage = new FakeStorage();
      storage.putFile.mockRejectedValue(new Error('disk full'));
      const { service } = build({ storage, failurePolicy: 'skip' });

      const result = await service.applyDeliveryMode('sess-1', message(attachment()));

      expect(result.media?.data).toBeUndefined();
      expect(result.media).toMatchObject({ skipped: true, skipReason: 'storage-failed' });
    });

    it('keeps base64 only when the operator explicitly opted in', async () => {
      const storage = new FakeStorage();
      storage.putFile.mockRejectedValue(new Error('disk full'));
      const { service } = build({ storage, failurePolicy: 'inline' });

      const result = await service.applyDeliveryMode('sess-1', message(attachment()));

      expect(result.media?.data).toBeDefined();
      expect(result.media?.skipped).toBeUndefined();
    });

    it('removes the file when its metadata could not be written', async () => {
      const storage = new FakeStorage();
      storage.putFile.mockImplementationOnce((key: string, data: Buffer) => {
        storage.files.set(key, data);
        return Promise.resolve();
      });
      storage.putFile.mockRejectedValueOnce(new Error('disk full'));
      const { service } = build({ storage });

      await service.applyDeliveryMode('sess-1', message(attachment()));

      // An orphan payload is unreadable and invisible to the sweep.
      expect(storage.files.size).toBe(0);
    });
  });

  // ── Download ──────────────────────────────────────────────────────

  describe('resolve', () => {
    const store = async () => {
      const { service, storage } = build();
      const result = await service.applyDeliveryMode('sess-1', message(attachment()));
      const [, , , sessionId, date, mediaId] = (result.media?.url ?? '').split('/');
      return { service, storage, sessionId, date, mediaId };
    };

    it('returns the file and its metadata before expiry', async () => {
      const { service, sessionId, date, mediaId } = await store();

      const resolved = await service.resolve(sessionId, date, mediaId);

      expect(resolved.data.toString('utf8')).toBe('file-bytes');
      expect(resolved.metadata.mimetype).toBe('image/jpeg');
    });

    it('rejects once the TTL has passed, even before the sweep runs', async () => {
      const { service, storage, sessionId, date, mediaId } = await store();

      const key = `inbound/${sessionId}/${date}/${mediaId}`;
      const metadata = readMetadata(storage, key);
      metadata.expiresAt = new Date(Date.now() - 1000).toISOString();
      storage.files.set(`${key}.json`, Buffer.from(JSON.stringify(metadata), 'utf8'));

      await expect(service.resolve(sessionId, date, mediaId)).rejects.toBeInstanceOf(MediaExpiredError);
    });

    it('refuses to serve another session’s attachment', async () => {
      const { service, date, mediaId } = await store();

      await expect(service.resolve('sess-2', date, mediaId)).rejects.toBeInstanceOf(MediaNotFoundError);
    });

    it.each([
      ['traversal in the session id', ['../../etc', '2024-01-01', 'a'.repeat(32)]],
      ['traversal in the date', ['sess-1', '../../..', 'a'.repeat(32)]],
      ['traversal in the media id', ['sess-1', '2024-01-01', '../../../etc/passwd']],
      ['a non-hex media id', ['sess-1', '2024-01-01', 'not-a-media-id']],
      ['a malformed date', ['sess-1', '2024-1-1', 'a'.repeat(32)]],
    ])('rejects %s without touching storage', async (_label, [sessionId, date, mediaId]) => {
      const { service, storage } = build();

      await expect(service.resolve(sessionId, date, mediaId)).rejects.toBeInstanceOf(MediaNotFoundError);
      expect(storage.getFile).not.toHaveBeenCalled();
    });

    it('rejects an unknown but well-formed reference', async () => {
      const { service } = build();

      await expect(service.resolve('sess-1', '2024-01-01', 'a'.repeat(32))).rejects.toBeInstanceOf(MediaNotFoundError);
    });
  });

  // ── TTL cleanup ───────────────────────────────────────────────────

  describe('cleanupExpired', () => {
    const expire = (storage: FakeStorage, storageKey: string) => {
      const metadata = readMetadata(storage, storageKey);
      metadata.expiresAt = new Date(Date.now() - 1000).toISOString();
      storage.files.set(`${storageKey}.json`, Buffer.from(JSON.stringify(metadata), 'utf8'));
    };

    it('removes expired attachments and keeps live ones', async () => {
      const { service, storage } = build();
      const stale = await service.applyDeliveryMode('sess-1', message(attachment()));
      const fresh = await service.applyDeliveryMode('sess-1', message(attachment()));
      expire(storage, stale.media?.storageKey ?? '');

      const removed = await service.cleanupExpired();

      expect(removed).toBe(1);
      expect(storage.files.has(stale.media?.storageKey ?? '')).toBe(false);
      expect(storage.files.has(`${stale.media?.storageKey ?? ''}.json`)).toBe(false);
      expect(storage.files.has(fresh.media?.storageKey ?? '')).toBe(true);
    });

    it('is safe to run repeatedly', async () => {
      const { service, storage } = build();
      const stored = await service.applyDeliveryMode('sess-1', message(attachment()));
      expire(storage, stored.media?.storageKey ?? '');

      expect(await service.cleanupExpired()).toBe(1);
      await expect(service.cleanupExpired()).resolves.toBe(0);
    });

    it('leaves unrelated files alone', async () => {
      const { service, storage } = build();
      storage.files.set('exports/backup.tar.gz', Buffer.from('unrelated'));

      await service.cleanupExpired();

      expect(storage.files.has('exports/backup.tar.gz')).toBe(true);
    });

    it('keeps sweeping past an unreadable record', async () => {
      const { service, storage } = build();
      const stored = await service.applyDeliveryMode('sess-1', message(attachment()));
      expire(storage, stored.media?.storageKey ?? '');
      storage.files.set('inbound/sess-1/2024-01-01/broken.json', Buffer.from('not json'));

      await expect(service.cleanupExpired()).resolves.toBe(1);
    });
  });
});
