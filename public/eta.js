// Finish-time estimates for the hover card, from how long each agent's past task cards took.
// Free to compute: no agent is asked to guess.

const MIN_SAMPLES = 3;
const MINUTE = 60_000;

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Cards made before start times were recorded fall back to when the card was created,
// which also counts any time it sat in the queue.
const duration = (t) => t.updatedAt - (t.startedAt ?? t.createdAt);

// How long finished cards of this kind took: the agent's own history first, then the team's.
function histories(agent, kind, list) {
  const done = list.filter((t) => t.status === 'done' && t.kind === kind && !list.some((p) => p.parentId === t.id));
  const own = done.filter((t) => t.assigneeId === agent.id).map(duration);
  const team = done.filter((t) => t.teamId === agent.teamId).map(duration);
  return [
    ...(own.length >= MIN_SAMPLES ? [{ durations: own, basis: 'own' }] : []),
    ...(team.length >= MIN_SAMPLES ? [{ durations: team, basis: 'team' }] : []),
  ];
}

const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;

// Time left on a card that has run for `elapsed`, judged only by past cards that ran at least that long.
// Cards range from 30-second notes to hour-long builds, so one typical time would mislead either way.
function remaining(durations, elapsed) {
  const longer = durations.filter((d) => d > elapsed);
  if (longer.length < 2) return null;
  return median(longer.map((d) => d - elapsed));
}

export function formatDuration(ms) {
  const m = Math.round(ms / MINUTE);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// What a worker is on now and when their queue should clear. Null when they have no card in progress.
export function workerEstimate(agent, list, now = Date.now()) {
  const mine = list.filter((t) => t.assigneeId === agent.id && !list.some((p) => p.parentId === t.id));
  const current = mine.find((t) => t.status === 'doing' || t.status === 'review');
  if (!current) return null;
  const queued = mine.filter((t) => t.status === 'todo');
  const elapsed = now - (current.startedAt ?? current.createdAt);
  const pasts = histories(agent, current.kind, list);
  if (!pasts.length) return { current, elapsed, queued: queued.length, noHistory: true };
  // The agent's own history may have too few long tasks to judge a long one; the team's may have more.
  let left = null;
  let basis = pasts[0].basis;
  for (const p of pasts) {
    left = remaining(p.durations, elapsed);
    if (left !== null) {
      basis = p.basis;
      break;
    }
  }
  // Queued cards are counted at the average time for their kind, the expected cost of an unknown card.
  const queueMs = queued.reduce((sum, t) => sum + mean((histories(agent, t.kind, list)[0] ?? pasts[0]).durations), 0);
  return {
    current, elapsed, basis, queued: queued.length,
    left: left ?? 0,
    // Longer than almost every past card, so there's nothing left to compare it with.
    overdue: left === null,
    allDoneAt: now + (left ?? 0) + queueMs,
  };
}

// Lines for the hover card's "Task" and "Expected" rows.
export function describeWorker(est) {
  const rows = [['Task', est.current.title]];
  if (est.noHistory) {
    rows.push(['Expected', `Not enough finished tasks to estimate yet (${formatDuration(est.elapsed)} so far)`]);
  } else if (est.overdue) {
    rows.push(['Expected', `Running long: ${formatDuration(est.elapsed)} so far, longer than almost all recent tasks`]);
  } else {
    const from = est.basis === 'own' ? 'their past tasks' : "the team's past tasks";
    rows.push([
      'Expected',
      est.left < MINUTE ? `Almost done (from ${from})` : `About ${formatDuration(est.left)} left, around ${clock(Date.now() + est.left)} (from ${from})`,
    ]);
  }
  if (est.queued && !est.noHistory) rows.push(['Queue', `+${est.queued} more, all done around ${clock(est.allDoneAt)}`]);
  else if (est.queued) rows.push(['Queue', `+${est.queued} more`]);
  return rows;
}

// For an orchestrator: when everything their team is working on should be finished.
export function teamEstimate(members, list, now = Date.now()) {
  const ests = members.map((a) => workerEstimate(a, list, now)).filter(Boolean);
  if (!ests.length) return null;
  const known = ests.filter((e) => !e.noHistory);
  const busy = ests.length;
  if (!known.length) return [['Team', `${busy} working; not enough history to estimate yet`]];
  const last = Math.max(...known.map((e) => e.allDoneAt));
  const unknown = busy - known.length;
  return [['Team', `${busy} working, all done around ${clock(last)} (${formatDuration(last - now)})${unknown ? `; ${unknown} without an estimate` : ''}`]];
}
