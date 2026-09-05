import { Message as WwebMessage } from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter, MessageFilterConfig } from './whatsapp-web-js.adapter';

/**
 * These drive `processIncomingMessage` - the real path the `message` event
 * takes - rather than the private predicates behind it. That matters here: the
 * filters exist to stop work happening, so the assertion that carries the value
 * is "downloadMedia was never called", which only the full path can show.
 *
 * No Chromium is launched; the adapter is constructed with config alone.
 */
describe('WhatsAppWebJsAdapter.processIncomingMessage', () => {
  const build = (messages?: MessageFilterConfig): WhatsAppWebJsAdapter =>
    new WhatsAppWebJsAdapter({
      sessionId: 'test-session',
      sessionDataPath: './data/sessions',
      messages,
    });

  interface FakeMessageOptions {
    from?: string;
    type?: string;
    hasMedia?: boolean;
    size?: number;
    mimetype?: string;
    isStatus?: boolean;
    broadcast?: boolean;
    fromMe?: boolean;
    downloadMedia?: jest.Mock;
  }

  const fakeMessage = (options: FakeMessageOptions = {}): { message: WwebMessage; downloadMedia: jest.Mock } => {
    const downloadMedia =
      options.downloadMedia ??
      jest.fn().mockResolvedValue({ mimetype: 'image/jpeg', filename: 'photo.jpg', data: 'BASE64' });

    const message = {
      id: { _serialized: 'msg-1' },
      from: options.from ?? '5215512345678@c.us',
      to: '5215500000000@c.us',
      body: 'hola',
      type: options.type ?? 'chat',
      timestamp: 1700000000,
      fromMe: options.fromMe ?? false,
      hasMedia: options.hasMedia ?? false,
      hasQuotedMsg: false,
      isStatus: options.isStatus ?? false,
      broadcast: options.broadcast ?? false,
      _data: { size: options.size, mimetype: options.mimetype },
      downloadMedia,
    } as unknown as WwebMessage;

    return { message, downloadMedia };
  };

  // ── Sender filtering ──────────────────────────────────────────────

  describe('sender filtering', () => {
    it.each([
      ['status', { from: 'status@broadcast', isStatus: true }],
      ['newsletter', { from: '120363000000000000@newsletter' }],
      ['broadcast list', { from: '5215512345678@broadcast', broadcast: true }],
    ])('drops %s traffic without downloading anything', async (_label, options) => {
      const adapter = build();
      const { message, downloadMedia } = fakeMessage({ ...options, hasMedia: true, type: 'image', size: 1024 });

      await expect(adapter.processIncomingMessage(message)).resolves.toBeNull();
      expect(downloadMedia).not.toHaveBeenCalled();
    });

    it('detects a status by its flag even when the address is a normal chat', async () => {
      const { message, downloadMedia } = fakeMessage({ from: '5215512345678@c.us', isStatus: true, hasMedia: true });

      await expect(build().processIncomingMessage(message)).resolves.toBeNull();
      expect(downloadMedia).not.toHaveBeenCalled();
    });

    it('passes a direct chat through', async () => {
      const result = await build().processIncomingMessage(fakeMessage().message);

      expect(result).not.toBeNull();
      expect(result?.from).toBe('5215512345678@c.us');
      expect(result?.isGroup).toBe(false);
    });

    it('does not discard an unfamiliar address format such as @lid', async () => {
      const { message } = fakeMessage({ from: '5215512345678@lid' });

      await expect(build().processIncomingMessage(message)).resolves.not.toBeNull();
    });

    it('passes groups by default and drops them when opted in', async () => {
      const groupMessage = () => fakeMessage({ from: '120363000000000000@g.us' }).message;

      const passed = await build().processIncomingMessage(groupMessage());
      expect(passed?.isGroup).toBe(true);

      await expect(build({ ignoreGroups: true }).processIncomingMessage(groupMessage())).resolves.toBeNull();
    });

    it('keeps statuses when only they are re-enabled, without leaking the @broadcast suffix', async () => {
      const adapter = build({ ignoreStatus: false });

      const status = fakeMessage({ from: 'status@broadcast', isStatus: true }).message;
      await expect(adapter.processIncomingMessage(status)).resolves.not.toBeNull();

      const list = fakeMessage({ from: '5215512345678@broadcast', broadcast: true }).message;
      await expect(adapter.processIncomingMessage(list)).resolves.toBeNull();
    });

    it('drops the session’s own messages', async () => {
      await expect(build().processIncomingMessage(fakeMessage({ fromMe: true }).message)).resolves.toBeNull();
    });
  });

  // ── Media policy ──────────────────────────────────────────────────

  describe('media policy', () => {
    const mediaMessage = (options: FakeMessageOptions = {}) =>
      fakeMessage({ hasMedia: true, type: 'image', size: 1024, mimetype: 'image/jpeg', ...options });

    it('downloads an attachment under the cap', async () => {
      const { message, downloadMedia } = mediaMessage();

      const result = await build({ media: { maxBytes: 5 * 1024 * 1024 } }).processIncomingMessage(message);

      expect(downloadMedia).toHaveBeenCalledTimes(1);
      expect(result?.media?.data).toBe('BASE64');
      expect(result?.media?.skipped).toBeUndefined();
    });

    it('skips every attachment when downloads are disabled', async () => {
      const { message, downloadMedia } = mediaMessage();

      const result = await build({ media: { download: false } }).processIncomingMessage(message);

      expect(downloadMedia).not.toHaveBeenCalled();
      expect(result?.media).toMatchObject({ skipped: true, skipReason: 'disabled' });
    });

    it('skips an attachment over the cap but still delivers the message', async () => {
      const { message, downloadMedia } = mediaMessage({ size: 6 * 1024 * 1024 });

      const result = await build({ media: { maxBytes: 5 * 1024 * 1024 } }).processIncomingMessage(message);

      expect(downloadMedia).not.toHaveBeenCalled();
      expect(result?.body).toBe('hola');
      expect(result?.media).toMatchObject({ skipped: true, skipReason: 'too-large', size: 6 * 1024 * 1024 });
    });

    it('treats the cap as inclusive', async () => {
      const { message, downloadMedia } = mediaMessage({ size: 5 * 1024 * 1024 });

      await build({ media: { maxBytes: 5 * 1024 * 1024 } }).processIncomingMessage(message);

      expect(downloadMedia).toHaveBeenCalledTimes(1);
    });

    it('ignores the cap entirely when it is 0', async () => {
      const { message, downloadMedia } = mediaMessage({ size: 500 * 1024 * 1024 });

      await build({ media: { maxBytes: 0 } }).processIncomingMessage(message);

      expect(downloadMedia).toHaveBeenCalledTimes(1);
    });

    describe('unknown size', () => {
      it('skips by default, because an unmeasurable file cannot honour the cap', async () => {
        const { message, downloadMedia } = mediaMessage({ size: undefined });

        const result = await build({ media: { maxBytes: 1024 } }).processIncomingMessage(message);

        expect(downloadMedia).not.toHaveBeenCalled();
        expect(result?.media).toMatchObject({ skipped: true, skipReason: 'unknown-size' });
      });

      it('downloads when the policy opts into the permissive behaviour', async () => {
        const { message, downloadMedia } = mediaMessage({ size: undefined });

        const result = await build({
          media: { maxBytes: 1024, unknownSizePolicy: 'download' },
        }).processIncomingMessage(message);

        expect(downloadMedia).toHaveBeenCalledTimes(1);
        expect(result?.media?.data).toBe('BASE64');
      });
    });

    describe('allowed types', () => {
      it('accepts a listed type and skips an unlisted one', async () => {
        const allowed = build({ media: { allowedTypes: ['image', 'document'] } });

        const image = mediaMessage({ type: 'image' });
        await allowed.processIncomingMessage(image.message);
        expect(image.downloadMedia).toHaveBeenCalledTimes(1);

        const video = mediaMessage({ type: 'video' });
        const result = await allowed.processIncomingMessage(video.message);
        expect(video.downloadMedia).not.toHaveBeenCalled();
        expect(result?.media).toMatchObject({ skipReason: 'type-not-allowed' });
      });

      it('normalises casing and whitespace on the incoming type', async () => {
        const { message, downloadMedia } = mediaMessage({ type: ' Image ' });

        await build({ media: { allowedTypes: ['image'] } }).processIncomingMessage(message);

        expect(downloadMedia).toHaveBeenCalledTimes(1);
      });

      it('accepts every type when the list is empty', async () => {
        const { message, downloadMedia } = mediaMessage({ type: 'sticker' });

        await build({ media: { allowedTypes: [] } }).processIncomingMessage(message);

        expect(downloadMedia).toHaveBeenCalledTimes(1);
      });
    });

    describe('failed downloads', () => {
      it('reports a thrown download as download-failed', async () => {
        const { message } = mediaMessage({ downloadMedia: jest.fn().mockRejectedValue(new Error('boom')) });

        const result = await build().processIncomingMessage(message);

        expect(result?.media).toMatchObject({ skipped: true, skipReason: 'download-failed' });
      });

      it('reports an undefined result the same way as a throw', async () => {
        const { message } = mediaMessage({ downloadMedia: jest.fn().mockResolvedValue(undefined) });

        const result = await build().processIncomingMessage(message);

        expect(result?.media).toMatchObject({ skipped: true, skipReason: 'download-failed' });
      });
    });
  });

  // ── Download queue ────────────────────────────────────────────────

  describe('download queue', () => {
    /** A download that only settles when the returned resolve is called. */
    const pendingDownload = () => {
      let release!: () => void;
      const started = jest.fn();
      const downloadMedia = jest.fn().mockImplementation(() => {
        started();
        return new Promise(resolve => {
          release = () => resolve({ mimetype: 'image/jpeg', data: 'BASE64' });
        });
      });
      return { downloadMedia, started, release: () => release() };
    };

    const mediaMessage = (downloadMedia: jest.Mock) =>
      fakeMessage({ hasMedia: true, type: 'image', size: 1024, downloadMedia }).message;

    it('never runs more downloads at once than the configured concurrency', async () => {
      const first = pendingDownload();
      const second = pendingDownload();
      const adapter = build({ media: { concurrency: 1, queueMax: 5 } });

      const firstRun = adapter.processIncomingMessage(mediaMessage(first.downloadMedia));
      const secondRun = adapter.processIncomingMessage(mediaMessage(second.downloadMedia));
      await Promise.resolve();

      expect(first.downloadMedia).toHaveBeenCalledTimes(1);
      expect(second.downloadMedia).not.toHaveBeenCalled();
      expect(adapter.getMediaDownloadStats()).toMatchObject({ active: 1, waiting: 1 });

      first.release();
      await firstRun;
      second.release();
      await secondRun;

      expect(second.downloadMedia).toHaveBeenCalledTimes(1);
      expect(adapter.getMediaDownloadStats()).toMatchObject({ active: 0, waiting: 0 });
    });

    it('rejects with queue-full instead of growing the queue', async () => {
      const running = pendingDownload();
      const queued = pendingDownload();
      const rejected = pendingDownload();
      const adapter = build({ media: { concurrency: 1, queueMax: 1 } });

      const runningRun = adapter.processIncomingMessage(mediaMessage(running.downloadMedia));
      const queuedRun = adapter.processIncomingMessage(mediaMessage(queued.downloadMedia));
      await Promise.resolve();

      const result = await adapter.processIncomingMessage(mediaMessage(rejected.downloadMedia));

      expect(rejected.downloadMedia).not.toHaveBeenCalled();
      expect(result?.media).toMatchObject({ skipped: true, skipReason: 'queue-full' });

      running.release();
      await runningRun;
      queued.release();
      await queuedRun;
    });

    it('gives up with queue-timeout rather than waiting forever', async () => {
      jest.useFakeTimers();
      try {
        const running = pendingDownload();
        const waiting = pendingDownload();
        const adapter = build({ media: { concurrency: 1, queueMax: 5, queueTimeoutMs: 1000 } });

        const runningRun = adapter.processIncomingMessage(mediaMessage(running.downloadMedia));
        const waitingRun = adapter.processIncomingMessage(mediaMessage(waiting.downloadMedia));
        await Promise.resolve();

        jest.advanceTimersByTime(1001);
        const result = await waitingRun;

        expect(waiting.downloadMedia).not.toHaveBeenCalled();
        expect(result?.media).toMatchObject({ skipped: true, skipReason: 'queue-timeout' });

        running.release();
        await runningRun;
      } finally {
        jest.useRealTimers();
      }
    });

    it('releases the slot after a failed download', async () => {
      const adapter = build({ media: { concurrency: 1 } });
      const failing = fakeMessage({
        hasMedia: true,
        type: 'image',
        size: 1024,
        downloadMedia: jest.fn().mockRejectedValue(new Error('boom')),
      });

      await adapter.processIncomingMessage(failing.message);

      expect(adapter.getMediaDownloadStats()).toMatchObject({ active: 0, waiting: 0 });
    });

    it('cancels queued downloads when the session is destroyed', async () => {
      const running = pendingDownload();
      const queued = pendingDownload();
      const adapter = build({ media: { concurrency: 1, queueMax: 5 } });

      const runningRun = adapter.processIncomingMessage(mediaMessage(running.downloadMedia));
      const queuedRun = adapter.processIncomingMessage(mediaMessage(queued.downloadMedia));
      await Promise.resolve();

      await adapter.destroy();
      const result = await queuedRun;

      expect(queued.downloadMedia).not.toHaveBeenCalled();
      expect(result?.media).toMatchObject({ skipped: true, skipReason: 'download-failed' });

      running.release();
      await runningRun;
    });
  });
});
