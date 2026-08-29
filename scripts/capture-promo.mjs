import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const promoParent = path.join(projectRoot, 'docs', 'assets');
const promoDir = path.join(promoParent, 'promo');
const frameNames = Object.freeze([
  '01-workflow-editor.png',
  '01-workflow-editor-detail.png',
  '02-join-and-handoff.png',
  '02-join-and-handoff-detail.png',
  '03-run-journal.png',
  '03-run-journal-detail.png',
]);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function runElectron(outputDir) {
  const args = [
    '.',
    '--promo-capture',
    `--promo-output=${outputDir}`,
    '--promo-scale=2',
    '--promo-zoom=1.25',
    '--promo-details',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Promo capture exited with ${signal || `code ${code}`}`));
    });
  });
}

async function validateCapture(directory) {
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 2) throw new Error('Promo manifest schema is not v2');
  if (manifest.capture?.motion !== 'frozen') throw new Error('Promo capture did not freeze motion');
  if (manifest.capture?.detailDerivation !== 'lossless-parent-crop') {
    throw new Error('Promo capture did not declare lossless detail derivation');
  }
  if (!Array.isArray(manifest.frames) || manifest.frames.length !== frameNames.length) {
    throw new Error('Promo manifest does not contain the canonical six frames');
  }
  const actualNames = (await readdir(directory)).sort();
  const expectedNames = [...frameNames, 'manifest.json'].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error('Promo staging directory contains unexpected files');
  }
  for (const [index, frame] of manifest.frames.entries()) {
    if (frame.file !== frameNames[index]) throw new Error(`Unexpected promo frame order at ${index}`);
    const bytes = await readFile(path.join(directory, frame.file));
    if (sha256(bytes) !== frame.sha256) throw new Error(`Promo hash mismatch: ${frame.file}`);
    if (frame.file.endsWith('-detail.png')) {
      const crop = frame.derivation?.crop;
      if (
        frame.derivation?.method !== 'lossless-parent-crop'
        || !crop
        || crop.width !== frame.width
        || crop.height !== frame.height
        || !Array.isArray(frame.derivation.evidenceSelectors)
        || frame.derivation.evidenceSelectors.length === 0
      ) {
        throw new Error(`Promo detail receipt is incomplete: ${frame.file}`);
      }
    }
  }
  return manifest;
}

function deterministicReceipt(manifest) {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    capture: manifest.capture,
    disclosure: manifest.disclosure,
    viewport: manifest.viewport,
    frames: manifest.frames,
  });
}

function receiptDifferences(first, second) {
  const differences = [];
  for (const frame of first.frames) {
    const other = second.frames.find(candidate => candidate.file === frame.file);
    if (!other) {
      differences.push(`${frame.file}: missing from second capture`);
      continue;
    }
    for (const key of ['width', 'height', 'sha256']) {
      if (frame[key] !== other[key]) differences.push(`${frame.file}: ${key}`);
    }
    if (JSON.stringify(frame.state) !== JSON.stringify(other.state)) {
      differences.push(`${frame.file}: state`);
    }
    if (JSON.stringify(frame.derivation) !== JSON.stringify(other.derivation)) {
      differences.push(`${frame.file}: derivation`);
    }
  }
  return differences;
}

async function captureOnce(label) {
  const directory = await mkdtemp(path.join(promoParent, `.promo-${label}-`));
  await runElectron(directory);
  const manifest = await validateCapture(directory);
  return { directory, manifest };
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function promoteCapture(stagingDir) {
  const backupDir = path.join(promoParent, `.promo-backup-${crypto.randomUUID()}`);
  if (path.dirname(stagingDir) !== promoParent || path.dirname(backupDir) !== promoParent) {
    throw new Error('Promo promotion paths escaped the docs asset directory');
  }
  await rename(promoDir, backupDir);
  try {
    await rename(stagingDir, promoDir);
  } catch (error) {
    if (!(await pathExists(promoDir)) && await pathExists(backupDir)) {
      await rename(backupDir, promoDir);
    }
    throw error;
  }
  await rm(backupDir, { recursive: true, force: true });
}

let first = null;
let second = null;
try {
  first = await captureOnce('first');
  second = await captureOnce('second');
  if (deterministicReceipt(first.manifest) !== deterministicReceipt(second.manifest)) {
    const differences = receiptDifferences(first.manifest, second.manifest);
    throw new Error(`Two isolated promo captures produced different receipts: ${differences.join(', ')}`);
  }
  await promoteCapture(first.directory);
  first = null;
  console.log('✓ Promo capture: 6 deterministic frames promoted from two identical isolated runs.');
} finally {
  await Promise.all([first?.directory, second?.directory]
    .filter(Boolean)
    .map(directory => rm(directory, { recursive: true, force: true })));
}
