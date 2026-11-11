// Snapshots of a project folder before and after each task, so the owner sees everything a task
// changed (including what shell commands did) and can put it back.
// They live in a git repository of the office's own under data/snapshots, with the project as its
// work tree. The project's own .git, branch and index are never touched.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { DATA_DIR } from './store.ts';
import { realPath } from './paths.ts';

const DIR = join(DATA_DIR, 'snapshots');
const MAX_FILES = 80;
const MAX_PATCH = 40_000;

// Left out on top of the project's own .gitignore: dependencies, build caches, and secrets.
const EXCLUDES = [
  'node_modules/', 'vendor/', '.venv/', 'venv/', '__pycache__/', '.next/', '.nuxt/', '.turbo/', '.cache/',
  '.DS_Store', '*.log', '.env', '.env.*', '!.env.example',
];

export type FileChange = { path: string; status: 'A' | 'M' | 'D' };
export type FileDiff = FileChange & { patch: string };

const repoFor = (cwd: string) => join(DIR, createHash('sha1').update(realPath(cwd)).digest('hex').slice(0, 16) + '.git');

function git(cwd: string, args: string[]): Promise<Buffer> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GIT_')) env[k] = v;
  // The owner's git settings (hooks, global ignores, line endings) shouldn't shape the snapshots.
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  return new Promise((done, fail) => {
    execFile(
      'git',
      ['--git-dir', repoFor(cwd), '--work-tree', cwd, '-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', ...args],
      { cwd, env, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
      (err, stdout) => (err ? fail(err) : done(stdout)),
    );
  });
}

// One git command at a time per project: they share an index.
const queues = new Map<string, Promise<unknown>>();
function inTurn<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const key = repoFor(cwd);
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  queues.set(key, next);
  return next;
}

async function ensureRepo(cwd: string) {
  const repo = repoFor(cwd);
  if (existsSync(join(repo, 'HEAD'))) return;
  mkdirSync(DIR, { recursive: true });
  await git(cwd, ['init', '--quiet']);
  mkdirSync(join(repo, 'info'), { recursive: true });
  writeFileSync(join(repo, 'info', 'exclude'), EXCLUDES.join('\n') + '\n');
}

// Records how the folder looks now and returns an id for it, or null if that didn't work
// (no git, unreadable folder); callers then simply have no diff to show.
export function snapshot(cwd: string): Promise<string | null> {
  return inTurn(cwd, async () => {
    try {
      await ensureRepo(cwd);
      // A file that can't be read shouldn't cost the whole snapshot.
      await git(cwd, ['add', '-A', '--ignore-errors']).catch(() => {});
      const tree = (await git(cwd, ['write-tree'])).toString().trim();
      // Old snapshots nothing points at are cleaned up by git in its own time.
      git(cwd, ['gc', '--auto', '--quiet']).catch(() => {});
      return /^[0-9a-f]{40,64}$/.test(tree) ? tree : null;
    } catch {
      return null;
    }
  });
}

async function changed(cwd: string, base: string, end: string): Promise<FileChange[]> {
  const out = (await git(cwd, ['diff', '--no-renames', '--name-status', '-z', base, end])).toString();
  const parts = out.split('\0');
  const files: FileChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i][0];
    if (status === 'A' || status === 'D') files.push({ path: parts[i + 1], status });
    else files.push({ path: parts[i + 1], status: 'M' });
  }
  return files;
}

export function changedCount(cwd: string, base: string, end: string): Promise<number> {
  if (base === end) return Promise.resolve(0);
  return inTurn(cwd, async () => (await changed(cwd, base, end)).length).catch(() => 0);
}

// What changed between two snapshots, file by file, as unified diffs.
export function diffBetween(cwd: string, base: string, end: string): Promise<{ files: FileDiff[]; more: number }> {
  return inTurn(cwd, async () => {
    const all = await changed(cwd, base, end);
    const files: FileDiff[] = [];
    for (const f of all.slice(0, MAX_FILES)) {
      const raw = (await git(cwd, ['diff', '--no-renames', '--no-color', '-U3', base, end, '--', f.path])).toString();
      const at = raw.indexOf('\n@@');
      let patch = at < 0 ? '(binary file, or only its permissions changed)' : raw.slice(at + 1);
      if (patch.length > MAX_PATCH) patch = patch.slice(0, MAX_PATCH) + '\n… (cut off)';
      files.push({ ...f, patch });
    }
    return { files, more: Math.max(0, all.length - MAX_FILES) };
  });
}

type Entry = { mode: string; hash: string };

async function entries(cwd: string, tree: string): Promise<Map<string, Entry>> {
  const out = (await git(cwd, ['ls-tree', '-r', '-z', tree])).toString();
  const map = new Map<string, Entry>();
  for (const line of out.split('\0')) {
    const m = line.match(/^(\d+) \w+ ([0-9a-f]+)\t([\s\S]+)$/);
    if (m) map.set(m[3], { mode: m[1], hash: m[2] });
  }
  return map;
}

// Puts the files a task changed back to how they were before it. A file someone changed again
// since the task finished is left alone and reported, so later work is never overwritten.
export function revertBetween(cwd: string, base: string, end: string): Promise<{ reverted: string[]; skipped: string[] }> {
  return inTurn(cwd, async () => {
    const files = await changed(cwd, base, end);
    const before = await entries(cwd, base);
    const after = await entries(cwd, end);
    const root = realPath(cwd);
    const reverted: string[] = [];
    const skipped: string[] = [];
    for (const f of files) {
      const abs = join(cwd, f.path);
      const real = realPath(abs);
      const was = before.get(f.path);
      const became = after.get(f.path);
      // Links and anything that resolves outside the project are not ours to rewrite.
      if (!real.startsWith(root + sep) || was?.mode === '120000' || became?.mode === '120000' || was?.mode === '160000' || became?.mode === '160000') {
        skipped.push(f.path);
        continue;
      }
      let now: string | null = null;
      if (existsSync(abs)) {
        try {
          now = (await git(cwd, ['hash-object', '--', abs])).toString().trim();
        } catch {
          skipped.push(f.path);
          continue;
        }
      }
      if (now !== (became?.hash ?? null)) {
        skipped.push(f.path);
        continue;
      }
      if (!was) {
        rmSync(abs, { force: true });
      } else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, await git(cwd, ['cat-file', 'blob', was.hash]));
        chmodSync(abs, was.mode === '100755' ? 0o755 : 0o644);
      }
      reverted.push(f.path);
    }
    return { reverted, skipped };
  });
}
