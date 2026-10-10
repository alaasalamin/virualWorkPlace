// Making sure the owner notices when someone needs them: chime, notifications, tab title, waiting button.
import { setAlerts } from './world.js';

const $ = (id) => document.getElementById(id);
const KEY = 'agent-office-alerts';

let ctx = { approvals: () => [], teamOf: () => undefined, onJump: () => {} };
let enabled = false;
let audio = null;
let jumpIndex = 0;

function load() {
  try {
    enabled = localStorage.getItem(KEY) === 'on';
  } catch {
    enabled = false;
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, enabled ? 'on' : 'off');
  } catch {
    // Storage blocked; the setting lasts for this visit only.
  }
}

function renderToggle() {
  const btn = $('alerts-btn');
  btn.setAttribute('aria-pressed', String(enabled));
  btn.textContent = enabled ? 'Alerts on' : 'Turn on alerts';
}

// A soft two-note chime.
function chime() {
  if (!enabled) return;
  try {
    audio ??= new AudioContext();
    const now = audio.currentTime;
    for (const [i, freq] of [660, 880].entries()) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.18, now + i * 0.14 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.14 + 0.5);
      osc.connect(gain).connect(audio.destination);
      osc.start(now + i * 0.14);
      osc.stop(now + i * 0.14 + 0.55);
    }
  } catch {
    // Audio unavailable.
  }
}

function systemNotify(title, body) {
  if (!enabled || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body, tag: 'agent-office' });
  n.onclick = () => {
    window.focus();
    n.close();
  };
}

export function initAlerts(c) {
  ctx = { ...ctx, ...c };
  load();
  renderToggle();
  $('alerts-btn').addEventListener('click', async () => {
    enabled = !enabled;
    persist();
    renderToggle();
    if (enabled) {
      if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
      chime();
    }
  });
  $('waiting-btn').addEventListener('click', () => {
    const list = ctx.approvals();
    if (!list.length) return;
    const a = list[jumpIndex % list.length];
    jumpIndex++;
    ctx.onJump(a);
  });
}

// Something new needs the owner's OK.
export function alertApproval(a) {
  chime();
  systemNotify('Agent Office: your OK is needed', a.title);
}

// A task was stopped or hit an error.
export function alertProblem(title, body) {
  chime();
  systemNotify(title, body);
}

export function refreshAlerts() {
  const list = ctx.approvals();
  const n = list.length;
  document.title = n ? `(${n}) Agent Office` : 'Agent Office';
  const btn = $('waiting-btn');
  btn.hidden = n === 0;
  btn.textContent = `${n} waiting for you`;
  setAlerts(list.map((a) => ctx.teamOf(a)).filter(Boolean));
}
