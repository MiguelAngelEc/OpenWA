// Fix for whatsapp-web.js media send error introduced by WhatsApp Web
// builds after 2026-09-17: "Data passed to getter must include an id
// property (it's how we memoize) but got undefined".
// Root cause: the media model carries an enumerable __x_id that
// overwrites the outgoing message id when spread into it.
// Upstream fix (unmerged): delete message.__x_id before the spread.
// See: https://github.com/wwebjs/whatsapp-web.js/pull/201923

const fs = require('fs');
const path = require('path');

const target = path.join(
  __dirname,
  '..',
  'node_modules',
  'whatsapp-web.js',
  'src',
  'util',
  'Injected',
  'Utils.js'
);

if (!fs.existsSync(target)) {
  console.warn('[fix-wwebjs-media-id] target file not found, skipping:', target);
  process.exit(0);
}

let content = fs.readFileSync(target, 'utf8');

const anchor = "Bot's won't reply if canonicalUrl is set (linking)";

if (!content.includes(anchor)) {
  console.warn('[fix-wwebjs-media-id] anchor comment not found, skipping (whatsapp-web.js version may differ)');
  process.exit(0);
}

if (content.includes('delete message.__x_id;')) {
  console.log('[fix-wwebjs-media-id] already applied, skipping.');
  process.exit(0);
}

const anchorIndex = content.indexOf(anchor);
const lineEnd = content.indexOf('\n', anchorIndex);

if (lineEnd === -1) {
  console.error('[fix-wwebjs-media-id] could not find line end after anchor, aborting.');
  process.exit(1);
}

const patched =
  content.slice(0, lineEnd + 1) +
  '        delete message.__x_id;\n' +
  content.slice(lineEnd + 1);

fs.writeFileSync(target, patched, 'utf8');
console.log('[fix-wwebjs-media-id] patch applied successfully.');