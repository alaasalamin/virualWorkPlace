// How busy this Mac is right now: CPU and memory as 0-100%, sampled while someone has the office open.
import { cpus, freemem, totalmem, platform } from 'node:os';
import { execFile } from 'node:child_process';

export type SystemLoad = { cpu: number; mem: number; cores: number; memUsedGb: number; memTotalGb: number; updatedAt: number };

const SAMPLE_MS = 2000;
let current: SystemLoad | null = null;
let onChange: (s: SystemLoad) => void = () => {};
let timer: NodeJS.Timeout | null = null;
let last = cpuTotals();

export const latestSystem = () => current;

export function onSystem(fn: typeof onChange) {
  onChange = fn;
}

function cpuTotals() {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    idle += c.times.idle;
    for (const v of Object.values(c.times)) total += v;
  }
  return { idle, total };
}

// CPU busy share since the previous sample.
function cpuPct() {
  const now = cpuTotals();
  const dTotal = now.total - last.total;
  const dIdle = now.idle - last.idle;
  last = now;
  return dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0;
}

// On macOS os.freemem() counts file cache as used, so read Activity Monitor's numbers from vm_stat instead:
// memory used = active + wired + compressed pages.
function memUsedBytes(): Promise<number> {
  if (platform() !== 'darwin') return Promise.resolve(totalmem() - freemem());
  return new Promise((resolve) => {
    execFile('vm_stat', { timeout: 1500 }, (err, out) => {
      if (err) return resolve(totalmem() - freemem());
      const pageSize = Number(/page size of (\d+)/.exec(out)?.[1] ?? 16384);
      const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
      const used = pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor');
      resolve(used * pageSize);
    });
  });
}

async function sample() {
  const cpu = cpuPct();
  const total = totalmem();
  const used = Math.min(await memUsedBytes(), total);
  current = {
    cpu: Math.max(0, Math.min(100, cpu)),
    mem: Math.round((used / total) * 100),
    cores: cpus().length,
    memUsedGb: Math.round((used / 2 ** 30) * 10) / 10,
    memTotalGb: Math.round((total / 2 ** 30) * 10) / 10,
    updatedAt: Date.now(),
  };
  onChange(current);
}

export function startSystemPolling() {
  if (timer) return;
  last = cpuTotals();
  timer = setInterval(() => sample().catch(() => {}), SAMPLE_MS);
}

export function stopSystemPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}
