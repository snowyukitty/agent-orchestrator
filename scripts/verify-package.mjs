import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, listPackage } from '@electron/asar';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(projectRoot, 'dist', 'AgentOrchestrator-win32-x64');
const asarPath = path.join(packageRoot, 'resources', 'app.asar');
const executablePath = path.join(packageRoot, 'AgentOrchestrator.exe');

if (!fs.existsSync(asarPath) || !fs.existsSync(executablePath)) {
  throw new Error('Packaged singular runtime is incomplete. Run npm run build first.');
}

const entries = listPackage(asarPath, { isPack: false }).map((entry) => {
  const normalized = entry.replaceAll('\\', '/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
});
const forbidden = [
  /^\/.*\.log$/i,
  /^\/(?:docs|mcps|scripts|tests)(?:\/|$)/,
  /^\/\.git(?:\/|$)/,
  /^\/(?:AGENTS|README)\.md$/,
  /^\/package-lock\.json$/,
  /^\/src\/assets\/icon-source\.png$/,
];
const required = [
  '/main.js',
  '/preload.js',
  '/package.json',
  '/src/index.html',
  '/src/js/app.js',
  '/src/js/engine.js',
  '/src/js/sessions.js',
  '/src/js/selftest.js',
  '/src/main/agents.js',
  '/src/main/sessions.js',
  '/src/main/settings.js',
  '/src/main/store.js',
  '/src/main/user-data.js',
  '/src/styles/main.css',
];

const leakedEntries = entries.filter(entry => forbidden.some(pattern => pattern.test(entry)));
const missingEntries = required.filter(entry => !entries.includes(entry));
if (leakedEntries.length > 0) {
  throw new Error(`Package contains forbidden files: ${leakedEntries.join(', ')}`);
}
if (missingEntries.length > 0) {
  throw new Error(`Package is missing runtime files: ${missingEntries.join(', ')}`);
}

const archivePath = (entry) => entry.replace(/^\//, '').replaceAll('/', path.sep);
const authoredText = entries.filter(entry =>
  entry === '/main.js' ||
  entry === '/preload.js' ||
  entry === '/package.json' ||
  entry === '/src/index.html' ||
  entry.startsWith('/src/js/') ||
  entry.startsWith('/src/main/')
);
const privatePathPattern = /(?:[A-Za-z]:\\(?:[^\\\r\n]+\\)+|\/(?:home|Users)\/[A-Za-z0-9._-]+\/)/i;
for (const entry of authoredText) {
  const content = extractFile(asarPath, archivePath(entry)).toString('utf8');
  if (privatePathPattern.test(content)) {
    throw new Error(`Package privacy gate found a machine-specific path in ${entry}.`);
  }
}

const manifest = JSON.parse(extractFile(asarPath, archivePath('/package.json')).toString('utf8'));
const sourceManifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
if (
  sourceManifest.private !== true ||
  manifest.name !== 'agent-orchestrator' ||
  manifest.productName !== 'Agent Orchestrator' ||
  manifest.version !== sourceManifest.version ||
  manifest.repository?.url !== 'https://github.com/snowyukitty/agent-orchestrator.git' ||
  manifest.main !== 'main.js'
) {
  throw new Error('Packaged application identity is inconsistent.');
}

const unpackedPty = path.join(packageRoot, 'resources', 'app.asar.unpacked', 'node_modules', 'node-pty');
if (!fs.existsSync(unpackedPty)) {
  throw new Error('Packaged node-pty native runtime is missing from app.asar.unpacked.');
}

const looseEntries = fs.readdirSync(packageRoot, { recursive: true, encoding: 'utf8' });
const forbiddenLoose = looseEntries.filter((entry) => {
  const normalized = entry.replaceAll('\\', '/');
  return /(?:^|\/).*\.log$/i.test(normalized) ||
    /^(?:docs|mcps|scripts|tests)(?:\/|$)/i.test(normalized);
});
if (forbiddenLoose.length > 0) {
  throw new Error(`Package contains forbidden loose files: ${forbiddenLoose.join(', ')}`);
}

console.log(`Package identity and privacy verification passed (${entries.length} archive entries).`);
