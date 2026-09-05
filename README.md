<p align="center">
  <img src="docs/logo/openwa_logo.webp" alt="OpenWA Logo" width="200"/>
</p>

<h1 align="center">OpenWA</h1>
<p align="center">
  <strong>Open Source WhatsApp API Gateway</strong>
</p>

<p align="center">
  <a href="#-features">Features</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-documentation">Docs</a> •
  <a href="#-api-examples">API</a> •
  <a href="#-contributing">Contributing</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.6-blue.svg" alt="Version"/>
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License"/>
  <img src="https://img.shields.io/badge/node-22_LTS-brightgreen.svg" alt="Node"/>
  <img src="https://img.shields.io/badge/NestJS-11.x-red.svg" alt="NestJS"/>
  <img src="https://img.shields.io/badge/docker-ready-blue.svg" alt="Docker"/>
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6.svg" alt="TypeScript"/>
</p>

---

## ✨ Why OpenWA?

**OpenWA** is a free, open-source WhatsApp API Gateway designed for developers who need full control over their messaging infrastructure—without vendor lock-in or hidden paywalls.

Built on a **pluggable architecture**, OpenWA lets you swap database engines (SQLite/PostgreSQL), storage backends (Local/S3), and cache layers (Memory/Redis) without changing a single line of application code.

|                               |                                                              |
| ----------------------------- | ------------------------------------------------------------ |
| 🔓 **100% Open Source**       | No licensing fees, no feature locks, full source code access |
| 🏗️ **Pluggable Architecture** | Swap adapters for database, storage, and cache via config    |
| 🖥️ **Full Dashboard**         | Modern React UI for session, webhook, and API key management |
| 🔹 **Multi-Session Ready**    | Run multiple WhatsApp sessions concurrently on one instance  |
| 🐳 **Docker Native**          | Production-ready with zero configuration                     |
| 🔗 **n8n Integration**        | Community nodes for workflow automation                      |

---

## 🎯 Features

### Core Features

| Feature       | Status | Description                          |
| ------------- | ------ | ------------------------------------ |
| REST API      | ✅     | Full WhatsApp API via HTTP endpoints |
| Multi-Session | ✅     | Manage multiple WhatsApp accounts    |
| Webhooks      | ✅     | Real-time events with HMAC signature |
| Web Dashboard | ✅     | Visual management interface          |
| API Key Auth  | ✅     | Secure API authentication            |
| Swagger Docs  | ✅     | Interactive API documentation        |

### Messaging

| Feature           | Status | Description                      |
| ----------------- | ------ | -------------------------------- |
| Text Messages     | ✅     | Send/receive text messages       |
| Media Messages    | ✅     | Images, videos, documents, audio |
| Message Reactions | ✅     | React to messages with emoji     |
| Bulk Messaging    | ✅     | Send to multiple recipients      |
| Message Status    | ✅     | Track delivery and read receipts |

### Advanced

| Feature             | Status | Description                        |
| ------------------- | ------ | ---------------------------------- |
| Groups API          | ✅     | Create, manage, and message groups |
| Channels/Newsletter | ✅     | WhatsApp Channels support          |
| Labels Management   | ✅     | Organize chats with labels         |
| Proxy Support       | ✅     | Per-session proxy configuration    |
| Rate Limiting       | ✅     | Configurable request limits        |
| CIDR Whitelisting   | ✅     | IP-based access control            |
| Audit Logging       | ✅     | Track all API operations           |

### Infrastructure

| Feature          | Status | Description                    |
| ---------------- | ------ | ------------------------------ |
| SQLite           | ✅     | Zero-config embedded database  |
| PostgreSQL       | ✅     | Production-grade database      |
| Redis Cache      | ✅     | Optional performance caching   |
| S3/MinIO Storage | ✅     | Scalable media storage         |
| Docker           | ✅     | One-command deployment         |
| Health Checks    | ✅     | Kubernetes-ready probes        |
| Data Migration   | ✅     | Export/import between backends |

---

## 🚀 Quick Start

### Option A: Docker (Recommended)

```bash
# Clone and start
git clone https://github.com/rmyndharis/OpenWA.git
cd OpenWA
docker compose -f docker-compose.dev.yml up -d

# Access
# Dashboard: http://localhost:2886
# API: http://localhost:2785/api
# Swagger: http://localhost:2785/api/docs
```

### Option B: Local Development

```bash
# Clone repository
git clone https://github.com/rmyndharis/OpenWA.git
cd OpenWA

# Install dependencies (includes dashboard)
npm install

# Start API + Dashboard (config is auto-generated on first run)
npm run dev

# Access
# Dashboard: http://localhost:2886
# API: http://localhost:2785/api
# Swagger: http://localhost:2785/api/docs
```

---

## 🏭 Production Deployment

For production, use the main `docker-compose.yml` with optional services:

```bash
# Basic production (SQLite, local storage)
docker compose up -d

# With PostgreSQL database
docker compose --profile postgres up -d

# Full stack (PostgreSQL, Redis, Dashboard, Traefik)
docker compose --profile full up -d
```

| Profile          | Services              |
| ---------------- | --------------------- |
| `postgres`       | PostgreSQL database   |
| `redis`          | Redis cache           |
| `minio`          | S3-compatible storage |
| `with-dashboard` | Web dashboard         |
| `with-proxy`     | Traefik reverse proxy |
| `full`           | All services above    |

> **Development vs Production**
>
> - Development (`docker-compose.dev.yml`): SQLite, local storage, both API & Dashboard included
> - Production (`docker-compose.yml`): Configurable database, profiles for optional services

### Railway

`railway.toml` sets the healthcheck and mounts a volume at `/app/data`, which is
what keeps sessions and the SQLite database across deploys. Without that volume
every deploy loses the WhatsApp login and asks for a new QR.

Set these variables on the service before the first deploy:

```bash
NODE_ENV=production
DATABASE_TYPE=sqlite
STORAGE_TYPE=local
STORAGE_LOCAL_PATH=/app/data/media
SESSION_DATA_PATH=/app/data/sessions

# Do not resume traffic on its own after a deploy
SESSION_AUTO_RESTORE=false

# Inbound profile (see below for what each one does)
IGNORE_GROUPS=true
MEDIA_MAX_BYTES=5242880
MEDIA_ALLOWED_TYPES=image,document
MEDIA_UNKNOWN_SIZE_POLICY=skip
MEDIA_DOWNLOAD_CONCURRENCY=1
MEDIA_DOWNLOAD_QUEUE_MAX=10
MEDIA_DELIVERY_MODE=storage

PUPPETEER_ARGS=--no-sandbox,--disable-setuid-sandbox,--disable-dev-shm-usage,--disable-gpu,--disable-extensions,--disable-background-networking,--mute-audio
NODE_OPTIONS=--max-old-space-size=512
CORS_ORIGINS=https://your-dashboard-domain
```

Railway sets `PORT` itself — do not override it.

A container running one session needs roughly 1 GB: Chromium is a few hundred MB
before a single message arrives, and `--max-old-space-size=512` caps what Node
adds on top rather than letting a burst decide.

After deploying, start the session explicitly (`SESSION_AUTO_RESTORE=false` means
it will not start itself), scan the QR, and check `inbound-stats` to confirm the
filters are doing their job before pointing anything at it.

## 🧹 Inbound Filtering & Memory

A linked session receives everything the phone does. Contact statuses, channel
posts and broadcast lists arrive on the same event as a real chat, and every one
of them costs a media download, a database write, a webhook POST and a WebSocket
frame. On a small container that traffic — not actual usage — is usually what
drives memory, because attachments are held as base64 (~33% larger than the file)
and copied again by each consumer.

Statuses, channels and broadcast lists are filtered by default. Groups are not,
since they carry real traffic for many deployments.

| Variable             | Default | Description                                |
| -------------------- | ------- | ------------------------------------------ |
| `IGNORE_STATUS`      | `true`  | Drop `status@broadcast` (contact stories)   |
| `IGNORE_NEWSLETTERS` | `true`  | Drop `@newsletter` (channel) posts          |
| `IGNORE_BROADCASTS`  | `true`  | Drop broadcast-list messages                |
| `IGNORE_GROUPS`      | `false` | Drop `@g.us` (group) messages               |

### Attachments

| Variable                          | Default    | Description                                                                                 |
| --------------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| `DOWNLOAD_MEDIA`                  | `true`     | Download attachments at all. **`false` is the lowest-RAM option**                            |
| `MEDIA_MAX_BYTES`                 | `16777216` | Per-file cap in bytes (16MB); `0` disables the cap                                           |
| `MEDIA_ALLOWED_TYPES`             | _(empty)_  | Comma-separated types to accept: `image,video,audio,ptt,document,sticker`; empty accepts all |
| `MEDIA_UNKNOWN_SIZE_POLICY`       | `skip`     | `skip` or `download` when WhatsApp reports no size                                           |
| `MEDIA_DOWNLOAD_CONCURRENCY`      | `1`        | Simultaneous downloads per session                                                           |
| `MEDIA_DOWNLOAD_QUEUE_MAX`        | `10`       | Downloads allowed to wait per session; `0` rejects anything that cannot start now            |
| `MEDIA_DOWNLOAD_QUEUE_TIMEOUT_MS` | `30000`    | How long a download may wait for a slot                                                      |

`MEDIA_MAX_BYTES` is a cap **on a size WhatsApp reported**, not a guarantee. The
size is the only signal available before the file is fetched, and WhatsApp does
not always send one. `MEDIA_UNKNOWN_SIZE_POLICY` decides what happens then:

- `skip` (default) — refuse what cannot be measured. This is what makes the cap
  an actual bound, at the cost of occasionally skipping a legitimate file.
- `download` — fetch it anyway. Permissive, and **able to exceed
  `MEDIA_MAX_BYTES`**, since the size is only known once the file has arrived.

The cap bounds one file; `MEDIA_DOWNLOAD_CONCURRENCY` is what bounds a burst of
them. Waiting downloads are memory too, so the queue is bounded as well: past
`MEDIA_DOWNLOAD_QUEUE_MAX` a download is refused outright rather than parked.

For a hard ceiling regardless of what arrives, set `DOWNLOAD_MEDIA=false`. No
attachment is ever pulled into the process, and messages still reach your
webhook as text.

Invalid values stop the boot with an error naming the variable —
`MEDIA_MAX_BYTES=16MB` will not quietly become a 16-byte or unlimited cap.

### Delivery: keeping base64 out of the payload

| Variable                                 | Default   | Description                                                   |
| ---------------------------------------- | --------- | ------------------------------------------------------------- |
| `MEDIA_DELIVERY_MODE`                    | `inline`  | `inline`, `storage` or `none`                                  |
| `MEDIA_STORAGE_TTL_SECONDS`              | `86400`   | How long a stored attachment stays downloadable                |
| `MEDIA_STORAGE_FAILURE_POLICY`           | `skip`    | `skip` or `inline` when persisting fails                       |
| `MEDIA_STORAGE_CLEANUP_INTERVAL_SECONDS` | `3600`    | How often expired attachments are swept                        |

The cap and the queue bound what is downloaded. This bounds what happens
**after**: in `inline` mode one attachment is copied by every consumer — the
object spread, the hook chain, one `JSON.stringify` per webhook, the WebSocket
frame — so a single 5MB file can touch tens of MB of heap.

- `inline` (default) — `media.data` carries base64. The existing contract.
- `storage` — the file is written once, the base64 is dropped, and the payload
  carries `storageKey`, `url` and `expiresAt` instead.
- `none` — the payload is dropped after downloading, arriving as
  `skipped: true, skipReason: "disabled"`.

In `storage` mode the payload looks like this:

```json
{
  "media": {
    "mimetype": "image/jpeg",
    "filename": "photo.jpg",
    "size": 123456,
    "storageKey": "inbound/my-session/2026-09-03/9f2c…",
    "url": "/api/media/my-session/2026-09-03/9f2c…",
    "expiresAt": "2026-09-04T18:00:00.000Z"
  }
}
```

`url` is an ordinary API endpoint: fetch it with the same `X-API-Key` you use
everywhere else. A key restricted with `allowedSessions` can only download that
session's attachments, and revoking a key revokes its attachments with it. Keys
are random, references expire, and expired files are swept on an interval and on
boot. Past `expiresAt` the endpoint answers `410 Gone`.

If persisting fails, `MEDIA_STORAGE_FAILURE_POLICY=skip` (the default) delivers
`skipReason: "storage-failed"` rather than falling back to base64 — a fallback
would reintroduce the memory spike exactly when the system is already unhealthy.
Set it to `inline` if losing the file is worse than the spike.

> This bounds retention and copies **after** the download. It does not remove the
> initial spike between Chromium and Node.js: whatsapp-web.js hands over the whole
> file as base64 in one piece. `DOWNLOAD_MEDIA=false` is the only setting that
> avoids that allocation entirely.

### Watching what a session actually does

`GET /api/sessions/:id/inbound-stats` reports counters for a running session:

```json
{
  "messagesDelivered": 12,
  "ignored": { "status": 431, "newsletter": 27, "group": 8 },
  "mediaSkipped": { "too-large": 3, "unknown-size": 1 },
  "downloads": { "active": 0, "waiting": 0, "concurrency": 1, "queueMax": 10, "completed": 9, "bytes": 4194304 }
}
```

Counts and categories only — no ids, addresses or content — so it is safe to log
and graph. Counters live in the engine instance and reset when the session
restarts. `ignored` is the number to watch: on an account that receives normal
WhatsApp traffic it will dwarf `messagesDelivered`, and that gap is the work no
longer being done.

### What a consumer receives

A filtered sender is dropped before any processing happens: no download, no
database write, no webhook, no WebSocket frame.

A filtered **attachment** is different. The message still reaches your webhook,
carrying `media.skipped: true` plus a stable `media.skipReason`, so a consumer
can ask the sender for the file another way instead of silently losing it:

| `skipReason`       | Meaning                                              |
| ------------------ | ---------------------------------------------------- |
| `disabled`         | `DOWNLOAD_MEDIA=false`                               |
| `too-large`        | Reported size exceeded `MEDIA_MAX_BYTES`             |
| `type-not-allowed` | Type outside `MEDIA_ALLOWED_TYPES`                   |
| `unknown-size`     | No size reported and policy is `skip`                |
| `queue-full`       | Too many downloads already waiting                   |
| `queue-timeout`    | No slot became free within the timeout               |
| `download-failed`  | WhatsApp refused the file or returned nothing        |
| `storage-failed`   | Downloaded, but could not be persisted               |

### Recommended for a small container

Only direct chats, text plus lightweight attachments:

```bash
IGNORE_GROUPS=true
DOWNLOAD_MEDIA=true
MEDIA_MAX_BYTES=5242880
MEDIA_ALLOWED_TYPES=image,document
MEDIA_UNKNOWN_SIZE_POLICY=skip
MEDIA_DOWNLOAD_CONCURRENCY=1
MEDIA_DOWNLOAD_QUEUE_MAX=10
MEDIA_DELIVERY_MODE=storage
MEDIA_STORAGE_FAILURE_POLICY=skip
SESSION_AUTO_RESTORE=false
PUPPETEER_ARGS=--no-sandbox,--disable-setuid-sandbox,--disable-dev-shm-usage,--disable-gpu,--disable-extensions,--disable-background-networking,--mute-audio
```

This profile is also what `.env.minimal` ships.

`SESSION_AUTO_RESTORE=false` matters after a redeploy: with the default `true`,
sessions reconnect on their own and start consuming again before anyone asks
them to. With it off, a session only runs after an explicit
`POST /api/sessions/:id/start`.

Register webhooks with the exact events you consume rather than `*`, or every
session state change, delivery receipt and QR refresh will hit your endpoint too:

```json
{ "url": "https://your-server.com/webhook", "events": ["message.received"] }
```

### Measuring it yourself

```bash
npm run loadtest:inbound
```

Drives the real inbound path with a generated hour of traffic — contact
statuses, channel posts, broadcast lists, group chatter and a handful of direct
messages — with no account, no Chromium and no network. It reports how much
base64 each configuration leaves in flight:

```
scenario      kept dropped files downloaded in payload retained  secs
unfiltered     240       0   175     373 MB   497.4 MB     0 MB  0.57
defaults        75     165    11    11.9 MB    15.9 MB     0 MB  0.01
low-memory      15     225     5      10 MB    13.3 MB     0 MB  0.03
no-media        15     225     0       0 MB       0 MB     0 MB     0
```

The gap between `downloaded` and `in payload` is the base64 overhead: 373 MB of
files become 497 MB of string. `retained` is what survives a GC once the burst
ends — it should stay near zero, and the script exits non-zero if it does not.

Use it to check a config change before deploying it, or as a regression guard:
the numbers are deterministic, so a jump means something actually changed.

### Verifying a live session

Counters, not logs, are the reliable check — they do not depend on the log level:

```bash
curl -H "X-API-Key: $API_KEY" http://localhost:2785/api/sessions/$SESSION_ID/inbound-stats
```

`ignored.status` climbing while `downloads.completed` stays at 0 is the proof:
statuses arrived, were dropped, and nothing was fetched. Test it with a status
posted by someone else — WhatsApp does not send your own back to you.

For the per-message detail, raise the level:

```bash
LOG_LEVEL=debug
```

Then each filtered message logs `Ignored inbound status message` (category only,
never the address). Leave it at `info` in production; a busy account makes that
line very frequent.

### The floor these settings cannot lower

Every active session runs its own Chromium: whatsapp-web.js drives a real
browser, so a connected session costs a few hundred MB before a single message
arrives. Filtering removes the spikes and the growth, not the baseline — sizing a
container means budgeting per active session, and `SESSION_AUTO_RESTORE=false` is
what keeps idle sessions from claiming that baseline unasked.

---

## 🔌 Ports

| Service   | Port            | Description              |
| --------- | --------------- | ------------------------ |
| API       | `2785`          | REST API endpoints       |
| Dashboard | `2886`          | Web management interface |
| Swagger   | `2785/api/docs` | Interactive API docs     |

---

## 📡 API Examples

### Create a Session

```bash
curl -X POST http://localhost:2785/api/sessions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"name": "my-bot"}'
```

### Start Session & Get QR Code

```bash
# Start the session
curl -X POST http://localhost:2785/api/sessions/{sessionId}/start \
  -H "X-API-Key: YOUR_API_KEY"

# Get QR code (scan with WhatsApp)
curl http://localhost:2785/api/sessions/{sessionId}/qr \
  -H "X-API-Key: YOUR_API_KEY"
```

### Send a Message

```bash
curl -X POST http://localhost:2785/api/sessions/{sessionId}/messages/send-text \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "chatId": "628123456789@c.us",
    "text": "Hello from OpenWA!"
  }'
```

### Setup Webhook

```bash
curl -X POST http://localhost:2785/api/sessions/{sessionId}/webhooks \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "url": "https://your-server.com/webhook",
    "events": ["message.received", "session.status"],
    "secret": "your-hmac-secret"
  }'
```

---

## 🛠 Tech Stack

| Layer         | Technology              |
| ------------- | ----------------------- |
| **Runtime**   | Node.js 22 LTS          |
| **Framework** | NestJS 11.x             |
| **Language**  | TypeScript 5.x          |
| **WA Engine** | whatsapp-web.js         |
| **Database**  | SQLite / PostgreSQL     |
| **Cache**     | Redis (optional)        |
| **Storage**   | Local / S3 / MinIO      |
| **ORM**       | TypeORM                 |
| **Container** | Docker + Docker Compose |

---

## 📁 Project Structure

```
openwa/
├── src/
│   ├── main.ts                 # Application entry point
│   ├── app.module.ts           # Root module
│   ├── config/                 # Configuration
│   ├── common/                 # Shared utilities
│   │   ├── cache/              # Redis caching
│   │   └── storage/            # File storage (Local/S3)
│   ├── core/                   # Core systems
│   │   ├── hooks/              # Plugin hooks
│   │   └── plugins/            # Plugin system
│   ├── engine/                 # WhatsApp engine abstraction
│   └── modules/
│       ├── session/            # Session management
│       ├── message/            # Message handling
│       ├── webhook/            # Webhook management
│       ├── group/              # Groups API
│       ├── contact/            # Contacts API
│       ├── auth/               # API key authentication
│       ├── infra/              # Infrastructure management
│       └── health/             # Health checks
├── dashboard/                  # React web dashboard
├── docs/                      # Documentation
├── docker-compose.yml
├── Dockerfile
└── package.json
```

---

## 📚 Documentation

Comprehensive documentation is available in the `docs/` folder:

| Document                                                | Description                  |
| ------------------------------------------------------- | ---------------------------- |
| [Project Overview](./docs/01-project-overview.md)       | Introduction and goals       |
| [Requirements](./docs/02-requirements-specification.md) | Feature specifications       |
| [Architecture](./docs/03-system-architecture.md)        | System design                |
| [Security](./docs/04-security-design.md)                | Security implementation      |
| [Database](./docs/05-database-design.md)                | Data models and migrations   |
| [API Spec](./docs/06-api-specification.md)              | Complete API reference       |
| [Development](./docs/08-development-guidelines.md)      | Coding standards             |
| [Migration Guide](./docs/14-migration-guide.md)         | Database & storage migration |

---

## 🤝 Contributing

We welcome contributions! Here's how to get started:

1. **Fork** the repository
2. **Create** your feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

Please read our [Development Guidelines](./docs/08-development-guidelines.md) for coding standards and best practices.

---

## 📄 License

This project is licensed under the **MIT License** – free for personal and commercial use.

See [LICENSE](./LICENSE) for details.

---

<div align="center">

**OpenWA** – Free, Open Source WhatsApp API Gateway

[📖 Documentation](./docs/README.md) · [🔌 API Docs](http://localhost:2785/api/docs) · [🐛 Report Bug](https://github.com/rmyndharis/OpenWA/issues) · [💡 Request Feature](https://github.com/rmyndharis/OpenWA/issues)

<br/>

<sub>Made with ❤️ by <a href="https://github.com/rmyndharis">Yudhi Armyndharis</a> and the OpenWA Community</sub>

</div>
