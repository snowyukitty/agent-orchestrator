#!/usr/bin/env node
// Validate the static guide without adding a build system or DOM dependency.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const HTML_FILE = path.join(DOCS, 'index.html');
const SCRIPT_FILE = path.join(DOCS, 'app.js');
const STYLE_FILE = path.join(DOCS, 'styles.css');
const KEY_ART_FILE = path.join(DOCS, 'assets', 'agent-orchestrator-key-art.png');
const KEY_ART_METADATA_FILE = `${KEY_ART_FILE}.metadata.json`;
const KEY_ART_PROMPT_FILE = `${KEY_ART_FILE}.prompt.txt`;
const KEY_ART_NEGATIVE_FILE = `${KEY_ART_FILE}.negative.txt`;
const PROMO_DIR = path.join(DOCS, 'assets', 'promo');
const PROMO_MANIFEST_FILE = path.join(PROMO_DIR, 'manifest.json');
const PROMO_FRAME_NAMES = [
  '01-workflow-editor.png',
  '02-join-and-handoff.png',
  '03-run-journal.png',
];
const CANONICAL_URL = 'https://snowyukitty.github.io/agent-orchestrator/';

const failures = [];

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    failures.push(`missing or unreadable: ${path.relative(ROOT, file)}`);
    return '';
  }
}

function fail(message) {
  failures.push(message);
}

function readProvenanceText(file) {
  // The stager writes text sidecars as conventional newline-terminated files;
  // metadata retains the exact submitted value without that file terminator.
  return fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
}

function pngSize(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length < 24 || bytes.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error('not a PNG');
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const html = read(HTML_FILE);
const script = read(SCRIPT_FILE);
const styles = read(STYLE_FILE);

const requiredFiles = [
  path.join(DOCS, '.nojekyll'),
  path.join(DOCS, 'README.md'),
  path.join(DOCS, 'assets', 'icon.png'),
  KEY_ART_FILE,
  KEY_ART_METADATA_FILE,
  KEY_ART_PROMPT_FILE,
  KEY_ART_NEGATIVE_FILE,
  PROMO_MANIFEST_FILE,
  ...PROMO_FRAME_NAMES.map((name) => path.join(PROMO_DIR, name)),
];
for (const file of requiredFiles) {
  if (!fs.existsSync(file)) fail(`missing: ${path.relative(ROOT, file)}`);
}

if (!/connect-src\s+'none'/.test(html)) {
  fail('docs/index.html must keep connect-src disabled');
}
if (!/<html\s+lang="en"/i.test(html)) {
  fail('docs/index.html must declare its content language');
}
if (!/class="skip-link"/.test(html)) {
  fail('docs/index.html must retain a keyboard skip link');
}
if (!html.includes(`<link rel="canonical" href="${CANONICAL_URL}">`)) {
  fail('docs/index.html must retain its exact canonical URL');
}

try {
  const metadata = JSON.parse(fs.readFileSync(KEY_ART_METADATA_FILE, 'utf8'));
  const imageHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(KEY_ART_FILE))
    .digest('hex');
  if (metadata?.status !== 'completed' || metadata?.route !== 'interactive-browser-control') {
    fail('key art metadata must describe one completed interactive-browser result');
  }
  if (metadata?.result?.fileName !== path.basename(KEY_ART_FILE)) {
    fail('key art metadata filename does not match the staged asset');
  }
  if (metadata?.result?.sha256 !== imageHash) {
    fail('key art SHA-256 does not match its metadata sidecar');
  }
  if (readProvenanceText(KEY_ART_PROMPT_FILE) !== metadata?.prompt) {
    fail('key art prompt sidecar does not match metadata');
  }
  if (readProvenanceText(KEY_ART_NEGATIVE_FILE) !== metadata?.negative_prompt) {
    fail('key art negative-prompt sidecar does not match metadata');
  }
  if (
    !html.includes(`<meta property="og:image:width" content="${metadata?.result?.width}">`)
    || !html.includes(`<meta property="og:image:height" content="${metadata?.result?.height}">`)
  ) {
    fail('key art social metadata dimensions do not match the verified asset');
  }
} catch (_error) {
  fail('key art or its provenance sidecars are unreadable');
}

try {
  const manifest = JSON.parse(fs.readFileSync(PROMO_MANIFEST_FILE, 'utf8'));
  if (
    manifest?.viewport?.width !== 1600
    || manifest?.viewport?.height !== 1000
    || !/inert fixture/i.test(manifest?.disclosure || '')
    || !/no PTY or agent was launched/i.test(manifest?.disclosure || '')
    || !/no account or production data was read/i.test(manifest?.disclosure || '')
  ) {
    fail('promo capture manifest must retain its exact viewport and inert-data disclosure');
  }
  if (
    !Array.isArray(manifest?.frames)
    || manifest.frames.length !== PROMO_FRAME_NAMES.length
    || manifest.frames.some((frame, index) => frame.file !== PROMO_FRAME_NAMES[index])
  ) {
    fail('promo capture manifest must name the three canonical frames in order');
  } else {
    for (const frame of manifest.frames) {
      const file = path.join(PROMO_DIR, frame.file);
      const bytes = fs.readFileSync(file);
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      const dimensions = pngSize(file);
      if (frame.sha256 !== digest) fail(`promo frame SHA-256 mismatch: ${frame.file}`);
      if (
        frame.width !== dimensions.width
        || frame.height !== dimensions.height
        || dimensions.width !== 1600
        || dimensions.height !== 1000
      ) {
        fail(`promo frame dimensions must be exactly 1600x1000: ${frame.file}`);
      }
      if (!html.includes(`src="assets/promo/${frame.file}"`)) {
        fail(`field guide does not present promo frame: ${frame.file}`);
      }
    }
  }
} catch (_error) {
  fail('promo capture manifest or frame provenance is unreadable');
}

const networkPatterns = [
  [/\bfetch\s*\(/, 'fetch'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bWebSocket\b/, 'WebSocket'],
  [/\bEventSource\b/, 'EventSource'],
  [/\bsendBeacon\s*\(/, 'sendBeacon'],
  [/<form\b/i, 'form submission'],
];
for (const [pattern, label] of networkPatterns) {
  if (pattern.test(`${html}\n${script}`)) {
    fail(`static guide must not use ${label}`);
  }
}

if (/url\(\s*['"]?https?:/i.test(styles)) {
  fail('docs/styles.css must not load remote assets');
}

const ids = new Set(Array.from(html.matchAll(/\sid="([^"]+)"/g), (match) => match[1]));
const references = Array.from(
  html.matchAll(/\s(?:href|src)="([^"]+)"/g),
  (match) => match[1],
);

for (const reference of references) {
  if (reference.startsWith('#')) {
    const target = decodeURIComponent(reference.slice(1));
    if (target && !ids.has(target)) fail(`missing anchor target: ${reference}`);
    continue;
  }
  if (/^https:\/\/github\.com\//.test(reference) || reference === CANONICAL_URL) continue;
  if (/^[a-z][a-z\d+.-]*:/i.test(reference)) {
    fail(`unsupported external reference: ${reference}`);
    continue;
  }

  const localPart = reference.split(/[?#]/, 1)[0];
  const resolved = path.resolve(DOCS, localPart);
  const relative = path.relative(DOCS, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`reference escapes docs/: ${reference}`);
  } else if (!fs.existsSync(resolved)) {
    fail(`missing local reference: ${reference}`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  console.error(`${failures.length} static guide contract check(s) failed.`);
  process.exit(1);
}

console.log(`✓ Static guide: ${references.length} references, ${ids.size} anchors, no backend calls.`);
