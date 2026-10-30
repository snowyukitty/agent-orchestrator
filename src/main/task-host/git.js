// Git operations for task worktrees and diff evidence.
//
// Every call is argv-only (no shell). Diff evidence stages the worktree into
// a temporary index, so the task's own index is never modified, and diffs the
// chosen base against that tree: commits since base, staged, unstaged and
// untracked-but-not-ignored content land in one complete patch.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { createHash } = require('crypto');

const MAX_PATCH_BYTES = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;

function git(cwd, args, { env = null, maxBuffer = 4 * 1024 * 1024, encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer,
      encoding,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...(env || {}) },
    }, (error, stdout) => {
      if (error) {
        const failure = new Error('git command failed');
        failure.code = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'git-output-too-large' : 'git-failed';
        reject(failure);
        return;
      }
      resolve(stdout);
    });
  });
}

async function isWorkTreeRoot(dir) {
  try {
    const top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    return path.resolve(top).toLowerCase() === path.resolve(dir).toLowerCase();
  } catch (_error) {
    return false;
  }
}

async function resolveCommit(repo, revision) {
  try {
    return (await git(repo, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])).trim();
  } catch (_error) {
    return null;
  }
}

async function createWorktree(repo, dir, branch, base) {
  await git(repo, ['worktree', 'add', '--no-track', '-b', branch, dir, base]);
}

/** Parse `git status --porcelain=v2 -z` into layer counts. */
function summarizeStatus(raw) {
  const summary = { staged: 0, unstaged: 0, untracked: 0, unmerged: 0, renamed: 0, submodules: 0 };
  const fields = raw.split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (!entry) continue;
    const kind = entry[0];
    if (kind === '?') { summary.untracked += 1; continue; }
    if (kind === 'u') { summary.unmerged += 1; continue; }
    if (kind !== '1' && kind !== '2') continue;
    const parts = entry.split(' ');
    const xy = parts[1] || '..';
    if (xy[0] !== '.') summary.staged += 1;
    if (xy[1] !== '.') summary.unstaged += 1;
    if ((parts[2] || '').startsWith('S')) summary.submodules += 1;
    if (kind === '2') {
      summary.renamed += 1;
      i += 1; // the original path follows as its own NUL field
    }
  }
  return summary;
}

/** Parse `git diff --numstat -z` (with -M) into file counts. */
function summarizeNumstat(raw) {
  const out = { files: 0, binaryFiles: 0, renames: 0, insertions: 0, deletions: 0 };
  const fields = raw.split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (!field) continue;
    const [added, deleted, pathPart] = field.split('\t');
    out.files += 1;
    if (added === '-' && deleted === '-') out.binaryFiles += 1;
    else {
      out.insertions += Number(added) || 0;
      out.deletions += Number(deleted) || 0;
    }
    if (pathPart === '') {
      // A rename: source and destination follow as two NUL fields.
      out.renames += 1;
      i += 2;
    }
  }
  return out;
}

/** Write the working tree, including untracked non-ignored files, as a tree id. */
async function snapshotTree(worktree) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-task-index-'));
  const index = path.join(scratch, 'index');
  try {
    const env = { GIT_INDEX_FILE: index };
    await git(worktree, ['read-tree', 'HEAD'], { env });
    await git(worktree, ['add', '--all', '--', '.'], { env });
    return (await git(worktree, ['write-tree'], { env })).trim();
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function collectDiffEvidence(worktree, base, { patchFile = null } = {}) {
  const collectedAt = new Date().toISOString();
  const head = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
  const commitsSinceBase = Number((await git(worktree, ['rev-list', '--count', `${base}..HEAD`])).trim()) || 0;
  const layers = summarizeStatus(await git(worktree, [
    'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none',
  ]));
  const tree = await snapshotTree(worktree);
  const numstat = summarizeNumstat(await git(worktree, ['diff', '--numstat', '-z', '-M', base, tree]));
  const submoduleStatus = (await git(worktree, ['submodule', 'status', '--recursive'])).trim();

  let patch = null;
  let complete = true;
  const omitted = [];
  try {
    patch = await git(worktree, ['diff', '--binary', '-M', '--full-index', base, tree], {
      maxBuffer: MAX_PATCH_BYTES, encoding: 'buffer',
    });
  } catch (error) {
    if (error.code !== 'git-output-too-large') throw error;
    complete = false;
    omitted.push('patch-exceeds-limit');
  }
  if (patch && patchFile) fs.writeFileSync(patchFile, patch);

  return {
    collectedAt,
    base,
    head,
    tree,
    commitsSinceBase,
    layers,
    ...numstat,
    submodules: submoduleStatus ? submoduleStatus.split('\n').length : 0,
    patchBytes: patch ? patch.length : null,
    patchSha256: patch ? createHash('sha256').update(patch).digest('hex') : null,
    complete,
    omitted,
    notDetected: ['ignored-files', 'writes-outside-worktree', 'global-configuration', 'external-effects'],
  };
}

/** The content of one file at a revision, or null when it does not exist. */
async function showFile(repo, revision, file) {
  try {
    return await git(repo, ['show', `${revision}:${file}`]);
  } catch (_error) {
    return null;
  }
}

module.exports = {
  MAX_PATCH_BYTES,
  collectDiffEvidence,
  createWorktree,
  git,
  isWorkTreeRoot,
  resolveCommit,
  showFile,
  snapshotTree,
  summarizeNumstat,
  summarizeStatus,
};
