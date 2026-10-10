// Agents walking to each other's desks and talking in speech bubbles.
import { walkerSVG } from './characters.js';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const station = (id) => document.querySelector(`.station[data-id="${id}"]`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let getAgent = () => undefined;
const visitQueues = new Map(); // senderId -> promise, so one person makes one trip at a time
const idleWaiters = new Map(); // agentId -> callbacks run when that agent goes idle
const talking = new Map(); // agentId -> text they're saying in a teammate conversation

export function initVisits(lookup) {
  getAgent = lookup;
}

// Position of el inside floor f, in the floor's own (unzoomed) pixels.
function rect(el, f) {
  const r = el.getBoundingClientRect();
  const fr = f.getBoundingClientRect();
  const k = fr.width / f.offsetWidth || 1;
  return { x: (r.left - fr.left) / k, y: (r.top - fr.top) / k, w: r.width / k, h: r.height / k };
}

function head(text, max = 170) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function tail(text, max = 170) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? '…' + t.slice(-(max - 1)) : t;
}

function setSpeech(host, text, cls = '') {
  cls = [cls, host.dataset.lean ? `lean-${host.dataset.lean}` : ''].join(' ').trim();
  let b = host.querySelector(':scope > .speech');
  if (!text) {
    b?.remove();
    host.classList.remove('speaking');
    return;
  }
  if (!b) {
    b = document.createElement('div');
    b.className = `speech ${cls}`;
    host.appendChild(b);
  }
  b.textContent = text;
  host.classList.add('speaking');
}

function waitForIdle(agentId, timeoutMs) {
  return new Promise((resolve) => {
    const list = idleWaiters.get(agentId) ?? [];
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      idleWaiters.set(agentId, (idleWaiters.get(agentId) ?? []).filter((f) => f !== done));
      resolve();
    }, timeoutMs);
    list.push(done);
    idleWaiters.set(agentId, list);
  });
}

function move(el, from, to) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const duration = reduceMotion ? 0 : Math.max(700, dist * 2.2);
  return el.animate(
    [{ transform: `translate(${from.x}px, ${from.y}px)` }, { transform: `translate(${to.x}px, ${to.y}px)` }],
    { duration, easing: 'ease-in-out', fill: 'forwards' },
  ).finished;
}

async function visit({ fromId, toId, mode, text }) {
  const from = station(fromId);
  const to = station(toId);
  const who = getAgent(fromId);
  if (!from || !to || !who) return;
  const floor = to.closest('.floor');
  if (!floor || from.closest('.floor') !== floor) return; // different teams: no walking between buildings

  // Start listening before the walk, so a quick answer isn't missed.
  const answered = mode === 'ask' ? waitForIdle(toId, 180_000) : null;

  const s = rect(from, floor);
  const t = rect(to, floor);
  const width = (s.w * 120) / 160;
  const walker = document.createElement('div');
  walker.className = 'walker';
  walker.style.width = `${width}px`;
  walker.innerHTML = walkerSVG(who.name, who.isOrchestrator);
  floor.appendChild(walker);

  const start = { x: s.x + s.w / 2 - width / 2, y: s.y + s.h * 0.05 };
  const roomRight = t.x + t.w + width * 0.7 < floor.offsetWidth;
  const end = { x: roomRight ? t.x + t.w - width * 0.25 : t.x - width * 0.75, y: t.y + t.h * 0.02 };

  // The visitor stands on one side of the host; their bubbles lean away from each other.
  walker.dataset.lean = roomRight ? 'right' : 'left';
  to.dataset.lean = roomRight ? 'left' : 'right';
  from.classList.add('away');
  walker.classList.add('walking');
  await move(walker, start, end);
  walker.classList.remove('walking');

  setSpeech(walker, head(text), mode);
  if (answered) {
    await answered;
    await sleep(1500);
  } else {
    await sleep(Math.min(7000, Math.max(2800, text.length * 45)));
  }
  setSpeech(walker, '');

  walker.classList.add('walking');
  await move(walker, end, start);
  walker.remove();
  from.classList.remove('away');
  delete to.dataset.lean;
}

export function onPeer(e) {
  const prev = visitQueues.get(e.fromId) ?? Promise.resolve();
  const next = prev.then(() => visit(e)).catch(() => {});
  visitQueues.set(e.fromId, next);
}

// A teammate's message has started a turn: show what this agent says while handling it.
export function onMessage(m) {
  if (m.from === 'peer') {
    talking.set(m.agentId, '');
  } else if (m.from === 'agent' && talking.has(m.agentId)) {
    talking.set(m.agentId, m.text);
    const el = station(m.agentId);
    if (el) setSpeech(el, tail(m.text));
  }
}

export function onDelta(agentId, text) {
  if (!talking.has(agentId)) return;
  const said = talking.get(agentId) + text;
  talking.set(agentId, said);
  const el = station(agentId);
  if (el) setSpeech(el, tail(said));
}

export function onStatus(agentId, status) {
  if (status !== 'idle' && status !== 'error') return;
  for (const done of idleWaiters.get(agentId) ?? []) done();
  idleWaiters.delete(agentId);
  if (talking.has(agentId)) {
    talking.delete(agentId);
    // Let the last words linger a moment before the bubble goes.
    setTimeout(() => {
      const el = station(agentId);
      if (el && !talking.has(agentId)) setSpeech(el, '');
    }, 5000);
  }
}
