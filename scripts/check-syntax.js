#!/usr/bin/env node
// ============================================================
// Syntax check every JavaScript file we ship or run.
//
// Replaces a hand-maintained `node --check a.js && node --check b.js ...`
// chain in package.json that silently went stale whenever a module was
// added. This walks the source roots instead, so a new file is covered the
// moment it exists.
// ============================================================
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Directories walked recursively, plus individual entrypoints at the root.
const DIRS = ['src/js', 'src/main', 'scripts', 'tests'];
const FILES = ['main.js', 'preload.js'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'mcps', '.git']);

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_e) {
    return out; // an optional root that doesn't exist yet
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const targets = [];
for (const file of FILES) {
  const full = path.join(ROOT, file);
  if (fs.existsSync(full)) targets.push(full);
}
for (const dir of DIRS) walk(path.join(ROOT, dir), targets);

let failed = 0;
for (const file of targets) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    const detail = (err.stderr || err.stdout || '').toString().trim();
    console.error(`✗ ${rel}\n${detail}\n`);
  }
}

if (failed) {
  console.error(`${failed} of ${targets.length} file(s) failed the syntax check.`);
  process.exit(1);
}
console.log(`✓ ${targets.length} file(s) passed the syntax check.`);
