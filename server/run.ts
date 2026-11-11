// The play button: runs a team's project the way a developer would in a terminal (Laravel: artisan serve,
// Vite, queue and Reverb; a Node project: npm run dev), reads the address each one prints, and keeps a
// status per process so the office can show whether they're running well.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { PROJECTS_DIR, getTeam } from './store.ts';

export type ProjectKind = 'laravel' | 'next' | 'vite' | 'node' | 'none';
export type ServiceStatus = 'starting' | 'running' | 'stopped' | 'failed';

export type Service = {
  id: string;
  label: string;
  command: string;
  status: ServiceStatus;
  // The address the process printed, once it has. Reverb's is a websocket.
  url: string | null;
  // Whether the port behind the URL answers; null until there's a URL.
  reachable: boolean | null;
  pid: number | null;
  exitCode: number | null;
  lastLine: string;
  startedAt: number | null;
};

export type RunState = {
  teamId: string;
  kind: ProjectKind;
  running: boolean;
  // Why nothing can run, when kind is none.
  note: string;
  services: Service[];
  updatedAt: number;
};

type Plan = { id: string; label: string; cmd: string; args: string[]; urlFrom?: (line: string) => string | null };

type Proc = { service: Service; child: ChildProcess; log: string[]; expectedExit: boolean };
// Output stays readable after a stop, until the next start.
const logs = new Map<string, Map<string, string[]>>(); // teamId -> service id -> lines

const LOG_LINES = 400;
const PROBE_MS = 4000;
const STOP_GRACE_MS = 4000;

const runs = new Map<string, RunState>();
const procs = new Map<string, Map<string, Proc>>(); // teamId -> service id -> process
const probes = new Map<string, NodeJS.Timeout>();
let onChange: (state: RunState) => void = () => {};
let onOutput: (teamId: string, service: string, line: string) => void = () => {};

export function onRunChange(fn: typeof onChange) {
  onChange = fn;
}
export function onRunOutput(fn: typeof onOutput) {
  onOutput = fn;
}

export const allRuns = () => Object.fromEntries(runs);
export const runOf = (teamId: string) => runs.get(teamId) ?? null;

export function runLog(teamId: string, service: string) {
  return logs.get(teamId)?.get(service) ?? [];
}

// ---------- what to run ----------

const projectDir = (project: string) => join(PROJECTS_DIR, project);

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// KEY=value lines from .env, quotes stripped. Enough for the handful of keys we read.
function readEnv(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try {
    text = readFileSync(join(dir, '.env'), 'utf8');
  } catch {
    return out;
  }
  for (const raw of text.split('\n')) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const clean = (s: string) => s.replace(ANSI, '').trim();

const httpUrl = (line: string) => {
  const m = clean(line).match(/https?:\/\/[a-z0-9.\-]+:\d+/i);
  return m ? m[0].replace('0.0.0.0', 'localhost').replace('[::]', 'localhost') : null;
};

// Laravel's serve, Vite and Next print their address as "http://host:port"; Reverb prints "on 0.0.0.0:8080".
const serveUrl = (line: string) => (/Server running on|Local:|localhost:|127\.0\.0\.1:/i.test(line) ? httpUrl(line) : null);
const reverbUrl = (line: string) => {
  const m = clean(line).match(/Starting server on ([a-z0-9.\-]+):(\d+)/i);
  return m ? `ws://${m[1] === '0.0.0.0' ? 'localhost' : m[1]}:${m[2]}` : null;
};

export function detect(project: string): { kind: ProjectKind; note: string; plans: Plan[] } {
  const dir = projectDir(project);
  if (!existsSync(dir)) return { kind: 'none', note: `There's no ${project} folder yet.`, plans: [] };
  const pkg = readJson(join(dir, 'package.json'));
  const hasDev = typeof pkg?.scripts?.dev === 'string';

  if (existsSync(join(dir, 'artisan'))) {
    const env = readEnv(dir);
    const composer = readJson(join(dir, 'composer.json'));
    const plans: Plan[] = [{ id: 'serve', label: 'Server', cmd: 'php', args: ['artisan', 'serve', '--host=127.0.0.1'], urlFrom: serveUrl }];
    if (hasDev) plans.push({ id: 'vite', label: 'Vite', cmd: 'npm', args: ['run', 'dev'], urlFrom: serveUrl });
    const queue = env.QUEUE_CONNECTION ?? 'sync';
    if (queue && queue !== 'sync' && queue !== 'null') {
      // queue:listen picks up code changes without a restart, which matters while agents are editing.
      plans.push({ id: 'queue', label: `Queue (${queue})`, cmd: 'php', args: ['artisan', 'queue:listen', '--tries=1', '--timeout=0'] });
    }
    const usesReverb = !!composer?.require?.['laravel/reverb'] || env.BROADCAST_CONNECTION === 'reverb';
    if (usesReverb) plans.push({ id: 'reverb', label: 'Reverb', cmd: 'php', args: ['artisan', 'reverb:start'], urlFrom: reverbUrl });
    return { kind: 'laravel', note: '', plans };
  }
  if (hasDev) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const kind: ProjectKind = deps.next ? 'next' : deps.vite ? 'vite' : 'node';
    const label = kind === 'next' ? 'Next.js' : kind === 'vite' ? 'Vite' : 'Dev server';
    return { kind, note: '', plans: [{ id: 'dev', label, cmd: 'npm', args: ['run', 'dev'], urlFrom: serveUrl }] };
  }
  if (pkg) return { kind: 'none', note: 'package.json has no "dev" script to run.', plans: [] };
  return { kind: 'none', note: `No artisan or package.json in ${project} yet.`, plans: [] };
}

export const kindLabel: Record<ProjectKind, string> = { laravel: 'Laravel', next: 'Next.js', vite: 'Vite', node: 'Node', none: '' };

// Looks at a project without starting anything, so the room can show what the play button would run.
export function describeRun(teamId: string): RunState | null {
  const team = getTeam(teamId);
  if (!team) return null;
  const existing = runs.get(teamId);
  if (existing?.running) return existing;
  const { kind, note, plans } = detect(team.project);
  const state: RunState = {
    teamId,
    kind,
    running: false,
    note,
    services: plans.map((p) => ({
      id: p.id,
      label: p.label,
      command: [p.cmd, ...p.args].join(' '),
      status: 'stopped',
      url: null,
      reachable: null,
      pid: null,
      exitCode: null,
      lastLine: '',
      startedAt: null,
    })),
    updatedAt: Date.now(),
  };
  runs.set(teamId, state);
  return state;
}

// ---------- starting and stopping ----------

// Apps opened from the Dock don't get the terminal's PATH, so add where php, composer and npm usually live.
function childEnv() {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', dirname(process.execPath), join(process.env.HOME ?? '', '.composer/vendor/bin')];
  env.PATH = [...new Set([...(env.PATH ?? '').split(':'), ...extra].filter(Boolean))].join(':');
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  delete env.ANTHROPIC_API_KEY;
  // The office's own port and host must not leak into Next or Vite, which read these.
  delete env.PORT;
  delete env.HOST;
  delete env.AGENT_OFFICE_DATA;
  return env;
}

function publish(teamId: string) {
  const state = runs.get(teamId);
  if (!state) return;
  state.updatedAt = Date.now();
  onChange(state);
}

export function startRun(teamId: string) {
  const team = getTeam(teamId);
  if (!team) return;
  if (runs.get(teamId)?.running) return;
  const state = describeRun(teamId)!;
  const { plans } = detect(team.project);
  if (!plans.length) {
    publish(teamId);
    return;
  }
  state.running = true;
  const mine = new Map<string, Proc>();
  procs.set(teamId, mine);
  const teamLogs = new Map<string, string[]>();
  logs.set(teamId, teamLogs);
  const cwd = projectDir(team.project);
  for (const plan of plans) {
    const service = state.services.find((s) => s.id === plan.id)!;
    Object.assign(service, { status: 'starting', url: null, reachable: null, exitCode: null, lastLine: '', startedAt: Date.now() });
    // Its own process group, so stopping npm also stops the node server it started.
    const child = spawn(plan.cmd, plan.args, { cwd, env: childEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    service.pid = child.pid ?? null;
    const proc: Proc = { service, child, log: [], expectedExit: false };
    mine.set(plan.id, proc);
    teamLogs.set(plan.id, proc.log);

    const onLine = (line: string) => {
      const text = clean(line);
      if (!text) return;
      proc.log.push(text);
      if (proc.log.length > LOG_LINES) proc.log.splice(0, proc.log.length - LOG_LINES);
      service.lastLine = text.slice(0, 200);
      onOutput(teamId, plan.id, text);
      if (!service.url && plan.urlFrom) {
        const url = plan.urlFrom(text);
        if (url) {
          service.url = url;
          service.status = 'running';
          publish(teamId);
        }
      }
    };
    for (const stream of [child.stdout, child.stderr]) {
      let buf = '';
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        buf += chunk;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? '';
        for (const l of lines) onLine(l);
      });
      stream?.on('end', () => buf && onLine(buf));
    }
    child.on('error', (e) => {
      service.status = 'failed';
      service.lastLine = e.message.includes('ENOENT') ? `Couldn't find ${plan.cmd}. Is it installed and on your PATH?` : e.message;
      proc.log.push(service.lastLine);
      publish(teamId);
    });
    child.on('exit', (code, signal) => {
      service.pid = null;
      service.exitCode = code;
      service.reachable = null;
      service.status = proc.expectedExit || code === 0 ? 'stopped' : 'failed';
      if (service.status === 'failed') service.lastLine = signal ? `Killed by ${signal}` : `Exited with code ${code}. ${service.lastLine}`.trim();
      // Everything gone (on its own or by us) means the run is over.
      if (![...mine.values()].some((p) => p.child.exitCode === null && p.child.signalCode === null)) finish(teamId);
      publish(teamId);
    });
    // A process that prints no address (the queue worker) counts as running once it has stayed up a moment.
    if (!plan.urlFrom) {
      setTimeout(() => {
        if (service.status === 'starting' && child.exitCode === null) {
          service.status = 'running';
          publish(teamId);
        }
      }, 1500);
    }
  }
  publish(teamId);
  probes.set(teamId, setInterval(() => probe(teamId), PROBE_MS));
}

function finish(teamId: string) {
  const state = runs.get(teamId);
  if (state) state.running = false;
  const t = probes.get(teamId);
  if (t) clearInterval(t);
  probes.delete(teamId);
  procs.delete(teamId);
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

export function stopRun(teamId: string) {
  const mine = procs.get(teamId);
  const state = runs.get(teamId);
  if (!mine || !state) return;
  for (const p of mine.values()) {
    p.expectedExit = true;
    if (p.child.exitCode === null) {
      p.service.status = 'stopped';
      killGroup(p.child, 'SIGTERM');
      const hard = setTimeout(() => p.child.exitCode === null && killGroup(p.child, 'SIGKILL'), STOP_GRACE_MS);
      p.child.once('exit', () => clearTimeout(hard));
    }
  }
  state.running = false;
  for (const s of state.services) s.reachable = null;
  publish(teamId);
}

export function toggleRun(teamId: string) {
  if (runs.get(teamId)?.running) stopRun(teamId);
  else startRun(teamId);
}

// Called before the office exits: nothing should keep running without it.
export function stopAllRuns() {
  for (const teamId of [...procs.keys()]) stopRun(teamId);
}

// ---------- is it answering? ----------

function probe(teamId: string) {
  const state = runs.get(teamId);
  if (!state?.running) return;
  for (const s of state.services) {
    if (!s.url || s.status !== 'running') continue;
    const u = new URL(s.url);
    const sock = connect({ host: u.hostname, port: Number(u.port), timeout: 1500 });
    const done = (ok: boolean) => {
      sock.destroy();
      if (s.reachable !== ok) {
        s.reachable = ok;
        publish(teamId);
      }
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  }
}
