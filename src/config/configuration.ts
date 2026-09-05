import { parseBoolean, parseEnum, parseInteger, parseList } from './env.parsers';

/**
 * whatsapp-web.js message types that can carry an attachment. Used to validate
 * MEDIA_ALLOWED_TYPES: a typo there would otherwise filter out the very type it
 * was meant to permit, and the only symptom would be attachments quietly going
 * missing.
 */
const MEDIA_MESSAGE_TYPES = ['image', 'video', 'audio', 'ptt', 'document', 'sticker'] as const;

export default () => ({
  port: parseInt(process.env.PORT || '2785', 10),

  // Redis configuration
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
  },

  // Queue configuration
  queue: {
    enabled: process.env.QUEUE_ENABLED === 'true',
  },

  // Cache configuration
  cache: {
    enabled: process.env.CACHE_ENABLED === 'true',
  },

  // Main Database configuration (always SQLite for boot config)
  database: {
    type: 'sqlite' as const,
    database: './data/main.sqlite',
    synchronize: true,
    logging: process.env.DATABASE_LOGGING === 'true',
  },

  // Data Storage Database configuration (pluggable: SQLite, PostgreSQL, etc.)
  dataDatabase: {
    type: process.env.DATABASE_TYPE || 'sqlite',
    // SQLite path (used when type is sqlite)
    database: process.env.DATABASE_NAME || './data/openwa.sqlite',
    // PostgreSQL/MySQL connection (used when type is postgres/mysql)
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    username: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    synchronize: process.env.DATABASE_SYNCHRONIZE === 'true',
    logging: process.env.DATABASE_LOGGING === 'true',
    // Connection pooling (PostgreSQL)
    poolSize: parseInt(process.env.DATABASE_POOL_SIZE || '10', 10),
    // SSL configuration
    ssl: process.env.DATABASE_SSL === 'true',
    sslRejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
  },

  // WhatsApp engine configuration
  engine: {
    type: process.env.ENGINE_TYPE || 'whatsapp-web.js',
    puppeteer: {
      headless: process.env.PUPPETEER_HEADLESS !== 'false',
      args: (process.env.PUPPETEER_ARGS || '--no-sandbox,--disable-setuid-sandbox').split(','),
    },
    sessionDataPath: process.env.SESSION_DATA_PATH || './data/sessions',
    // Re-open sessions that were connected before the process stopped, so an
    // API restart does not require a manual POST /sessions/:id/start.
    autoRestore: process.env.SESSION_AUTO_RESTORE !== 'false',
    // Delay before the restore sweep runs, giving the HTTP server time to bind.
    autoRestoreDelay: parseInt(process.env.SESSION_AUTO_RESTORE_DELAY || '3000', 10),
    // Hard cap for a single engine.initialize() call. Without it a Chromium
    // launch that never resolves leaves the session stuck in `initializing`.
    initTimeout: parseInt(process.env.SESSION_INIT_TIMEOUT || '90000', 10),
    // How long GET /sessions/:id/qr waits for the first QR before giving up.
    qrWaitTimeout: parseInt(process.env.SESSION_QR_WAIT_TIMEOUT || '30000', 10),

    // Inbound message filtering.
    //
    // A linked session receives everything the phone does: contact statuses,
    // channel posts and broadcast lists all arrive on the same event as a real
    // chat. None of them is a person writing to the session, but each one costs
    // a media download, a DB write, a webhook POST and a WebSocket frame. On a
    // small container that noise, not the actual usage, is what drives memory.
    //
    // Statuses, channels and broadcasts are filtered by default because they
    // are never a direct message. Groups are not - they carry real traffic for
    // plenty of deployments - so opt in with IGNORE_GROUPS=true.
    messages: {
      ignoreStatus: parseBoolean('IGNORE_STATUS', process.env.IGNORE_STATUS, true),
      ignoreNewsletters: parseBoolean('IGNORE_NEWSLETTERS', process.env.IGNORE_NEWSLETTERS, true),
      ignoreBroadcasts: parseBoolean('IGNORE_BROADCASTS', process.env.IGNORE_BROADCASTS, true),
      ignoreGroups: parseBoolean('IGNORE_GROUPS', process.env.IGNORE_GROUPS, false),
      media: {
        download: parseBoolean('DOWNLOAD_MEDIA', process.env.DOWNLOAD_MEDIA, true),
        // Attachments are held in memory as base64 (~33% larger than the file)
        // and copied again by every consumer, so an unbounded download is the
        // single largest memory risk in the pipeline. 0 disables the cap.
        maxBytes: parseInteger('MEDIA_MAX_BYTES', process.env.MEDIA_MAX_BYTES, 16777216, { min: 0 }),
        // Empty accepts every type.
        allowedTypes: parseList('MEDIA_ALLOWED_TYPES', process.env.MEDIA_ALLOWED_TYPES, MEDIA_MESSAGE_TYPES),
        // WhatsApp does not always report an attachment size, and the size is
        // the only thing available before downloading. `skip` refuses to
        // download what it cannot measure, which is the only way the cap is a
        // real bound; `download` restores the permissive behaviour for
        // deployments that would rather risk the memory than lose a file.
        unknownSizePolicy: parseEnum(
          'MEDIA_UNKNOWN_SIZE_POLICY',
          process.env.MEDIA_UNKNOWN_SIZE_POLICY,
          ['skip', 'download'] as const,
          'skip',
        ),
        // Downloads run one at a time by default. The cap bounds a single
        // file; concurrency is what bounds a burst of them, and a status flood
        // arrives as exactly that.
        concurrency: parseInteger('MEDIA_DOWNLOAD_CONCURRENCY', process.env.MEDIA_DOWNLOAD_CONCURRENCY, 1, { min: 1 }),
        // Waiting downloads are themselves memory. An unbounded queue only
        // moves the problem from Chromium into the event loop.
        queueMax: parseInteger('MEDIA_DOWNLOAD_QUEUE_MAX', process.env.MEDIA_DOWNLOAD_QUEUE_MAX, 10, { min: 0 }),
        queueTimeoutMs: parseInteger(
          'MEDIA_DOWNLOAD_QUEUE_TIMEOUT_MS',
          process.env.MEDIA_DOWNLOAD_QUEUE_TIMEOUT_MS,
          30000,
          { min: 1 },
        ),
      },
    },
  },

  // Webhook configuration
  webhook: {
    timeout: parseInt(process.env.WEBHOOK_TIMEOUT || '10000', 10),
    maxRetries: parseInt(process.env.WEBHOOK_MAX_RETRIES || '3', 10),
    retryDelay: parseInt(process.env.WEBHOOK_RETRY_DELAY || '5000', 10),
  },

  // API configuration
  api: {
    rateLimit: {
      // Short burst protection: 10 requests per second
      shortTtl: parseInt(process.env.RATE_LIMIT_SHORT_TTL || '1000', 10),
      shortLimit: parseInt(process.env.RATE_LIMIT_SHORT_LIMIT || '10', 10),
      // Medium protection: 100 requests per minute
      mediumTtl: parseInt(process.env.RATE_LIMIT_MEDIUM_TTL || '60000', 10),
      mediumLimit: parseInt(process.env.RATE_LIMIT_MEDIUM_LIMIT || '100', 10),
      // Long protection: 1000 requests per hour
      longTtl: parseInt(process.env.RATE_LIMIT_LONG_TTL || '3600000', 10),
      longLimit: parseInt(process.env.RATE_LIMIT_LONG_LIMIT || '1000', 10),
    },
  },

  // Storage configuration
  storage: {
    type: process.env.STORAGE_TYPE || 'local',
    localPath: process.env.STORAGE_LOCAL_PATH || './data/media',
    s3: {
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      endpoint: process.env.S3_ENDPOINT,
    },
  },
});
