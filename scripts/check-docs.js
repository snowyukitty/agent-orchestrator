#!/usr/bin/env node
// Validate the static guide without adding a build system or DOM dependency.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const HTML_FILE = path.join(DOCS, 'index.html');
const SCRIPT_FILE = path.join(DOCS, 'app.js');
const STYLE_FILE = path.join(DOCS, 'styles.css');

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

const html = read(HTML_FILE);
const script = read(SCRIPT_FILE);
const styles = read(STYLE_FILE);

const requiredFiles = [
  path.join(DOCS, '.nojekyll'),
  path.join(DOCS, 'README.md'),
  path.join(DOCS, 'assets', 'icon.png'),
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
  if (/^https:\/\/github\.com\//.test(reference)) continue;
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
