// The owner's Claude plan usage: current 5-hour session, weekly limit and per-model weekly limits.
// Fetched with the SDK's /usage call (no model runs), and kept fresh from the rate-limit
// events every agent run reports.
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { HQ_DIR } from './store.ts';

export type Window = { pct: number; resetsAt: string | null };
export type Usage = {
  session: Window | null;
  week: Window | null;
  models: (Window & { name: string })[];
  plan: string | null;
  updatedAt: number;
};

const POLL_MS = 3 * 60_000;
let current: Usage | null = null;
let onChange: (u: Usage) => void = () => {};
let inFlight: Promise<void> | null = null;
let timer: NodeJS.Timeout | null = null;

export const latestUsage = () => current;

export function onUsage(fn: typeof onChange) {
  onChange = fn;
}

function publish(next: Usage) {
  current = next;
  onChange(next);
}

function childEnv() {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.ANTHROPIC_API_KEY;
  return env;
}

const win = (w: { utilization: number | null; resets_at: string | null } | null | undefined): Window | null =>
  w && typeof w.utilization === 'number' ? { pct: w.utilization, resetsAt: w.resets_at } : null;

// Asks Claude Code for the same data as its /usage screen. The SDK marks this call
// experimental, so any failure just leaves the numbers from rate-limit events in place.
async function fetchNow() {
  let release: () => void = () => {};
  const idle = {
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((r) => (release = r));
    },
  };
  const q = query({ prompt: idle as AsyncIterable<never>, options: { settingSources: [], env: childEnv(), cwd: HQ_DIR } });
  try {
    const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    const rl = u.rate_limits;
    if (!u.rate_limits_available || !rl) return;
    publish({
      session: win(rl.five_hour),
      week: win(rl.seven_day),
      models: (rl.model_scoped ?? [])
        .filter((m) => typeof m.utilization === 'number')
        .map((m) => ({ name: m.display_name, pct: m.utilization as number, resetsAt: m.resets_at })),
      plan: u.subscription_type,
      updatedAt: Date.now(),
    });
  } catch (e) {
    console.warn(`Couldn't read plan usage: ${e instanceof Error ? e.message : e}`);
  } finally {
    release();
    q.close();
  }
}

export function refreshUsage() {
  inFlight ??= fetchNow().finally(() => (inFlight = null));
  return inFlight;
}

// Poll while someone has the office open.
export function startUsagePolling() {
  if (timer) return;
  refreshUsage();
  timer = setInterval(refreshUsage, POLL_MS);
}

export function stopUsagePolling() {
  if (timer) clearInterval(timer);
  timer = null;
}

// Agent runs report rate-limit info as they go: use it to keep the meter live between polls.
export function noteRateLimit(info: SDKRateLimitInfo) {
  const toWindow = (utilization: number | undefined, resetsAt: number | undefined): Window | null =>
    typeof utilization === 'number'
      ? { pct: Math.round(utilization * 100), resetsAt: resetsAt ? new Date(resetsAt * 1000).toISOString() : null }
      : null;
  // Recent CLIs include every window; older ones only the one that applied.
  const windows = (info as { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> }).unifiedWindows;
  const session = toWindow(windows?.five_hour?.utilization, windows?.five_hour?.resetsAt) ??
    (info.rateLimitType === 'five_hour' ? toWindow(info.utilization, info.resetsAt) : null);
  const week = toWindow(windows?.seven_day?.utilization, windows?.seven_day?.resetsAt) ??
    (info.rateLimitType === 'seven_day' ? toWindow(info.utilization, info.resetsAt) : null);
  if (!session && !week) return;
  const prev = current ?? { session: null, week: null, models: [], plan: null, updatedAt: 0 };
  publish({ ...prev, session: session ?? prev.session, week: week ?? prev.week, updatedAt: Date.now() });
}
