/**
 * Synthetic inbound load test.
 *
 * Answers the question the filters exist for: how much memory does a burst of
 * WhatsApp traffic cost, and how much of that does the configuration actually
 * remove? It drives the adapter's real inbound path - the same
 * processIncomingMessage the `message` event calls - with generated messages,
 * so no account, no Chromium and no network are involved.
 *
 * downloadMedia is stubbed to return base64 of the requested size, which is the
 * honest part of the simulation: that allocation is what whatsapp-web.js hands
 * over in one piece, and it is the cost this whole feature is built around.
 *
 * Run:
 *   node --expose-gc -r ts-node/register scripts/inbound-load-test.ts
 *   npm run loadtest:inbound
 *
 * Without --expose-gc the numbers still show the peak, but the "retained after
 * GC" column is guesswork, so the script says so rather than pretending.
 */
import { Message as WwebMessage } from 'whatsapp-web.js';
import type { WhatsAppWebJsAdapter as Adapter, MessageFilterConfig } from '../src/engine/adapters/whatsapp-web-js.adapter';

// A queue-full burst is the expected outcome in the bounded scenarios, and
// hundreds of warnings would bury the table. Set before the adapter module is
// loaded, which is why the import below is deferred rather than hoisted.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WhatsAppWebJsAdapter } = require('../src/engine/adapters/whatsapp-web-js.adapter') as {
  WhatsAppWebJsAdapter: new (config: {
    sessionId: string;
    sessionDataPath: string;
    messages?: MessageFilterConfig;
  }) => Adapter;
};

interface Scenario {
  name: string;
  description: string;
  messages?: MessageFilterConfig;
}

interface Result {
  scenario: string;
  delivered: number;
  ignored: number;
  downloads: number;
  downloadedMb: number;
  payloadMb: number;
  retainedHeapMb: number | null;
  seconds: number;
}

/** Roughly what an idle personal account receives in a quiet hour. */
const TRAFFIC = {
  statuses: 120, // contact stories, most carrying an image or video
  newsletters: 30, // channel posts
  broadcasts: 15, // broadcast lists
  groups: 60, // group chatter
  direct: 15, // the messages anyone actually wants
};

const MEDIA_SIZES = {
  image: 900 * 1024,
  video: 8 * 1024 * 1024,
  document: 2 * 1024 * 1024,
};

const MB = 1024 * 1024;

const toMb = (bytes: number): number => Math.round((bytes / MB) * 10) / 10;

/**
 * A fresh base64 payload of about `bytes` decoded size.
 *
 * Deliberately not pooled. Sharing one string across downloads would make the
 * heap look flat no matter how many attachments were fetched, which is exactly
 * the measurement this script exists to take - real downloads each allocate
 * their own.
 */
function payload(bytes: number): string {
  return Buffer.alloc(bytes, 0x61).toString('base64');
}

interface FakeSpec {
  from: string;
  type: string;
  isStatus?: boolean;
  broadcast?: boolean;
  mediaBytes?: number;
}

function fakeMessage(index: number, spec: FakeSpec): WwebMessage {
  const hasMedia = spec.mediaBytes !== undefined;

  return {
    id: { _serialized: `false_${spec.from}_${index}` },
    from: spec.from,
    to: '5215500000000@c.us',
    body: hasMedia ? '' : `synthetic message ${index}`,
    type: spec.type,
    timestamp: Math.floor(Date.now() / 1000),
    fromMe: false,
    hasMedia,
    hasQuotedMsg: false,
    isStatus: spec.isStatus ?? false,
    broadcast: spec.broadcast ?? false,
    _data: { size: spec.mediaBytes, mimetype: hasMedia ? 'application/octet-stream' : undefined },
    downloadMedia: () =>
      Promise.resolve({
        mimetype: 'application/octet-stream',
        filename: `file-${index}`,
        data: payload(spec.mediaBytes ?? 0),
      }),
  } as unknown as WwebMessage;
}

/** The traffic mix, shuffled so bursts interleave the way they really do. */
function buildTraffic(): FakeSpec[] {
  const specs: FakeSpec[] = [];

  for (let i = 0; i < TRAFFIC.statuses; i += 1) {
    const video = i % 4 === 0;
    specs.push({
      from: 'status@broadcast',
      isStatus: true,
      type: video ? 'video' : 'image',
      mediaBytes: video ? MEDIA_SIZES.video : MEDIA_SIZES.image,
    });
  }
  for (let i = 0; i < TRAFFIC.newsletters; i += 1) {
    specs.push({ from: `12036300000000${i % 10}@newsletter`, type: 'image', mediaBytes: MEDIA_SIZES.image });
  }
  for (let i = 0; i < TRAFFIC.broadcasts; i += 1) {
    specs.push({ from: `52155123456${i % 10}@broadcast`, broadcast: true, type: 'chat' });
  }
  for (let i = 0; i < TRAFFIC.groups; i += 1) {
    const media = i % 3 === 0;
    specs.push({
      from: `12036300000000${i % 5}@g.us`,
      type: media ? 'image' : 'chat',
      mediaBytes: media ? MEDIA_SIZES.image : undefined,
    });
  }
  for (let i = 0; i < TRAFFIC.direct; i += 1) {
    const document = i % 3 === 0;
    specs.push({
      from: `521551234${(1000 + i).toString()}@c.us`,
      type: document ? 'document' : 'chat',
      mediaBytes: document ? MEDIA_SIZES.document : undefined,
    });
  }

  // Deterministic shuffle: the same mix every run, so two scenarios are
  // comparable and a regression is a real change rather than a reordering.
  let seed = 42;
  for (let i = specs.length - 1; i > 0; i -= 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [specs[i], specs[j]] = [specs[j], specs[i]];
  }

  return specs;
}

const gc = (global as unknown as { gc?: () => void }).gc;

async function settle(): Promise<void> {
  // Give the event loop a turn so pending microtasks release their references
  // before anything is measured.
  await new Promise(resolve => setTimeout(resolve, 50));
  if (gc) {
    gc();
    await new Promise(resolve => setTimeout(resolve, 50));
    gc();
  }
}

async function run(scenario: Scenario, specs: FakeSpec[]): Promise<Result> {
  const adapter = new WhatsAppWebJsAdapter({
    sessionId: 'loadtest',
    sessionDataPath: './data/sessions',
    messages: scenario.messages,
  });

  await settle();
  const baseline = process.memoryUsage();

  const started = Date.now();

  // Fired without awaiting, the way the `message` event does: the whole point
  // of the download queue is what happens when they overlap.
  const inFlight = specs.map((spec, index) => adapter.processIncomingMessage(fakeMessage(index, spec)));
  const messages = await Promise.all(inFlight);

  const seconds = Math.round(((Date.now() - started) / 1000) * 100) / 100;

  const stats = adapter.getInboundStats();
  const delivered = messages.filter(Boolean).length;
  const ignored = Object.values(stats.ignored).reduce((total, count) => total + count, 0);

  // The deterministic measure, and the one that matters: base64 still attached
  // to delivered messages once the burst settles. Every downstream consumer -
  // the hook chain, each webhook's JSON.stringify, the WebSocket frame - copies
  // this. Heap deltas depend on when V8 feels like collecting; this does not.
  const retainedPayloadBytes = messages.reduce(
    (total, message) => total + (message?.media?.data?.length ?? 0),
    0,
  );

  // Drop every reference to the delivered payloads before measuring what is
  // retained; anything still held after this is a leak, not working memory.
  messages.length = 0;
  await settle();
  const after = process.memoryUsage();

  await adapter.destroy().catch(() => undefined);

  return {
    scenario: scenario.name,
    delivered,
    ignored,
    downloads: stats.downloads.completed,
    downloadedMb: toMb(stats.downloads.bytes),
    payloadMb: toMb(retainedPayloadBytes),
    retainedHeapMb: gc ? toMb(Math.max(0, after.heapUsed - baseline.heapUsed)) : null,
    seconds,
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: 'unfiltered',
    description: 'what the pipeline did before any of this: every sender, every attachment, no bound',
    messages: {
      ignoreStatus: false,
      ignoreNewsletters: false,
      ignoreBroadcasts: false,
      ignoreGroups: false,
      media: { download: true, maxBytes: 0, concurrency: 1000, queueMax: 10000 },
    },
  },
  {
    name: 'defaults',
    description: 'shipped defaults: statuses, channels and broadcasts dropped, 16MB cap, one download at a time',
    messages: undefined,
  },
  {
    name: 'low-memory',
    description: 'the documented low-memory profile: direct chats only, 5MB cap, images and documents',
    messages: {
      ignoreGroups: true,
      media: { download: true, maxBytes: 5 * MB, allowedTypes: ['image', 'document'], concurrency: 1, queueMax: 10 },
    },
  },
  {
    name: 'no-media',
    description: 'DOWNLOAD_MEDIA=false: the floor, since no attachment ever enters the process',
    messages: { ignoreGroups: true, media: { download: false } },
  },
];

async function main(): Promise<void> {
  const specs = buildTraffic();
  const withMedia = specs.filter(spec => spec.mediaBytes !== undefined);
  const offered = withMedia.reduce((total, spec) => total + (spec.mediaBytes ?? 0), 0);

  console.log('\nSynthetic inbound load test');
  console.log('─'.repeat(78));
  console.log(`Messages:    ${specs.length} (${withMedia.length} carrying an attachment)`);
  console.log(`Offered:     ${toMb(offered)} MB of attachments before any filtering`);
  console.log(`GC control:  ${gc ? 'available' : 'NOT available - rerun with --expose-gc for retained memory'}`);
  console.log('─'.repeat(78));

  const results: Result[] = [];
  for (const scenario of SCENARIOS) {
    process.stdout.write(`Running ${scenario.name}... `);
    results.push(await run(scenario, specs));
    console.log('done');
  }

  console.log('\nResults');
  console.log('─'.repeat(78));
  console.log(
    ['scenario'.padEnd(12), 'kept'.padStart(6), 'dropped'.padStart(8), 'files'.padStart(6), 'downloaded'.padStart(11), 'in payload'.padStart(11), 'retained'.padStart(9), 'secs'.padStart(6)].join(
      '',
    ),
  );
  for (const result of results) {
    console.log(
      [
        result.scenario.padEnd(12),
        String(result.delivered).padStart(6),
        String(result.ignored).padStart(8),
        String(result.downloads).padStart(6),
        `${result.downloadedMb} MB`.padStart(11),
        `${result.payloadMb} MB`.padStart(11),
        (result.retainedHeapMb === null ? 'n/a' : `${result.retainedHeapMb} MB`).padStart(9),
        String(result.seconds).padStart(6),
      ].join(''),
    );
  }
  console.log('─'.repeat(78));

  const [unfiltered] = results;
  for (const result of results.slice(1)) {
    const saved = unfiltered.payloadMb - result.payloadMb;
    const percent = unfiltered.payloadMb > 0 ? Math.round((saved / unfiltered.payloadMb) * 100) : 0;
    console.log(
      `${result.scenario.padEnd(12)} ${Math.round(Math.abs(saved))} MB less base64 in flight than unfiltered (${percent}% smaller)`,
    );
  }

  console.log(
    '\nNote: this measures the pipeline, not the process. Every active session also\n' +
      'runs its own Chromium, which costs a few hundred MB no matter what is filtered.\n',
  );

  if (gc) {
    // A burst that ends should give its memory back. Anything still holding a
    // meaningful share of its own peak after two GCs is retaining, not working.
    const leaking = results.filter(
      result => result.payloadMb >= 5 && (result.retainedHeapMb ?? 0) > result.payloadMb * 0.25,
    );
    if (leaking.length > 0) {
      console.log(`Memory not released after the burst in: ${leaking.map(r => r.scenario).join(', ')}\n`);
      process.exitCode = 1;
    }
  }
}

void main();
