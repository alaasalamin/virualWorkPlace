// A team's check command (tests, type check, build), run in a project folder after a task
// so a card only counts as done when it passes.
import { spawn } from 'node:child_process';

const TIMEOUT_MS = Number(process.env.AGENT_OFFICE_CHECK_TIMEOUT ?? 5 * 60_000);
const KEEP = 6000;

export type CheckResult = { ok: boolean; output: string; why: 'passed' | 'failed' | 'timeout' | 'stopped' };

// One check at a time per folder, so two finishing tasks don't run the tests on top of each other.
const queues = new Map<string, Promise<unknown>>();

export function runCheck(cwd: string, command: string, signal: AbortSignal): Promise<CheckResult> {
  const next = (queues.get(cwd) ?? Promise.resolve()).catch(() => {}).then(() => run(cwd, command, signal));
  queues.set(cwd, next);
  return next;
}

function run(cwd: string, command: string, signal: AbortSignal): Promise<CheckResult> {
  return new Promise((done) => {
    if (signal.aborted) return done({ ok: false, output: '', why: 'stopped' });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.CI = '1'; // test runners shouldn't wait for keys or start watching
    // Its own process group, so stopping it also stops whatever it started.
    const child = spawn(command, { cwd, env, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let why: CheckResult['why'] | null = null;
    const take = (b: Buffer) => {
      out += b.toString();
      if (out.length > KEEP * 2) out = out.slice(-KEEP);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const kill = (reason: CheckResult['why']) => {
      why ??= reason;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => kill('timeout'), TIMEOUT_MS);
    const onAbort = () => kill('stopped');
    signal.addEventListener('abort', onAbort, { once: true });
    const finish = (code: number | null, error?: string) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const output = (error ? `${error}\n` : '') + out.slice(-KEEP).trim();
      done({ ok: !why && code === 0, output, why: why ?? (code === 0 ? 'passed' : 'failed') });
    };
    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(code));
  });
}
