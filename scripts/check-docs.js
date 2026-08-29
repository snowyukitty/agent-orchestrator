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
const PROMO_DIR = path.join(DOCS, 'assets', 'promo');
const PROMO_MANIFEST_FILE = path.join(PROMO_DIR, 'manifest.json');
const PROMO_FRAME_NAMES = [
  '01-workflow-editor.png',
  '01-workflow-editor-detail.png',
  '02-join-and-handoff.png',
  '02-join-and-handoff-detail.png',
  '03-run-journal.png',
  '03-run-journal-detail.png',
];
const PROMO_FULL_NAMES = PROMO_FRAME_NAMES.filter((name) => !name.endsWith('-detail.png'));
const PROMO_DETAIL_NAMES = PROMO_FRAME_NAMES.filter((name) => name.endsWith('-detail.png'));
// The outward face is proof-first: the social card and the README hero are the
// same authentic capture the field guide presents, never a conceptual render.
const SOCIAL_FRAME_NAME = PROMO_FULL_NAMES[0];
// Published frames must clear the legibility floor the capture tool documents:
// a 1x full-window frame scaled into a README column puts this UI's smallest
// labels under 6px, so the standard is a 2x capture, an enlarged UI, and a
// focus crop for every claim.
const PROMO_MIN_SCALE = 2;
const PROMO_MIN_ZOOM = 1.25;
const PROMO_MIN_DETAIL_WIDTH = 1200;
const CANONICAL_URL = 'https://snowyukitty.github.io/agent-orchestrator/';
const README_FILE = path.join(ROOT, 'README.md');

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
  const scale = manifest?.capture?.scale;
  const zoom = manifest?.capture?.zoom;
  if (!(scale >= PROMO_MIN_SCALE) || !(zoom >= PROMO_MIN_ZOOM)) {
    fail(
      `promo capture must stay at or above scale ${PROMO_MIN_SCALE} and zoom ${PROMO_MIN_ZOOM}`
      + ' so published UI text survives being scaled into a README column'
    );
  }
  const fullSize = {
    width: manifest?.viewport?.width * scale,
    height: manifest?.viewport?.height * scale,
  };
  if (
    !Array.isArray(manifest?.frames)
    || manifest.frames.length !== PROMO_FRAME_NAMES.length
    || manifest.frames.some((frame, index) => frame.file !== PROMO_FRAME_NAMES[index])
  ) {
    fail('promo capture manifest must name every canonical frame and its detail crop in order');
  } else {
    for (const frame of manifest.frames) {
      const file = path.join(PROMO_DIR, frame.file);
      const bytes = fs.readFileSync(file);
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      const dimensions = pngSize(file);
      const isDetail = PROMO_DETAIL_NAMES.includes(frame.file);
      if (frame.sha256 !== digest) fail(`promo frame SHA-256 mismatch: ${frame.file}`);
      if (frame.width !== dimensions.width || frame.height !== dimensions.height) {
        fail(`promo frame dimensions do not match their receipt: ${frame.file}`);
      }
      if (isDetail) {
        // A crop is the frame a reader can actually read, so it must be a real
        // crop of its own full frame and stay wide enough to carry the claim.
        if (frame.detailOf !== frame.file.replace('-detail.png', '.png')) {
          fail(`detail crop does not name its source frame: ${frame.file}`);
        }
        if (dimensions.width >= fullSize.width || dimensions.width < PROMO_MIN_DETAIL_WIDTH) {
          fail(`detail crop width must be between ${PROMO_MIN_DETAIL_WIDTH} and the full frame: ${frame.file}`);
        }
        if (!html.includes(`src="assets/promo/${frame.file}"`)) {
          fail(`field guide does not present detail crop: ${frame.file}`);
        }
      } else {
        if (dimensions.width !== fullSize.width || dimensions.height !== fullSize.height) {
          fail(`full frame must be exactly ${fullSize.width}x${fullSize.height}: ${frame.file}`);
        }
        if (!html.includes(`assets/promo/${frame.file}"`)) {
          fail(`field guide does not reference full frame: ${frame.file}`);
        }
      }
    }

    const social = manifest.frames.find((frame) => frame.file === SOCIAL_FRAME_NAME);
    const socialUrl = `${CANONICAL_URL}assets/promo/${SOCIAL_FRAME_NAME}`;
    if (
      !html.includes(`<meta property="og:image" content="${socialUrl}">`)
      || !html.includes(`<meta name="twitter:image" content="${socialUrl}">`)
    ) {
      fail('social preview images must point at the authentic capture frame');
    }
    if (
      !html.includes(`<meta property="og:image:width" content="${social?.width}">`)
      || !html.includes(`<meta property="og:image:height" content="${social?.height}">`)
    ) {
      fail('social metadata dimensions do not match the verified capture frame');
    }

    const readme = read(README_FILE);
    if (!readme.includes(`](docs/assets/promo/${SOCIAL_FRAME_NAME})`)) {
      fail('README hero must be the authentic capture frame');
    }
    // The README column is the surface where a full frame becomes unreadable,
    // so every product claim there is carried by its detail crop.
    for (const name of PROMO_DETAIL_NAMES) {
      if (!readme.includes(`](docs/assets/promo/${name})`)) {
        fail(`README must present the readable detail crop: ${name}`);
      }
    }
    if (/agent-orchestrator-key-art/.test(`${readme}\n${html}`)) {
      fail('the retired conceptual key art must not return to the outward face');
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
