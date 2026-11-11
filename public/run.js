// The play button in each room: shows what the team's project runs on, one row per process, and a log per process.

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const KIND = { laravel: 'Laravel', next: 'Next.js', vite: 'Vite', node: 'Node', none: '' };
const PLAY = '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M13 9 L31 20 L13 31 Z"/></svg>';
const STOP = '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="11" y="11" width="18" height="18" rx="3"/></svg>';

let ctx = { send: () => {}, getTeam: () => undefined, getRun: () => null };
let open = null; // { teamId, service } while the log dialog is showing

function statusText(s, running) {
  if (s.status === 'starting') return 'starting…';
  if (s.status === 'failed') return s.exitCode === null ? 'failed' : `exited (${s.exitCode})`;
  if (s.status === 'stopped') return running ? 'stopped' : '';
  if (s.url) return s.reachable === false ? 'not answering' : s.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return 'running';
}

function tone(s) {
  if (s.status === 'failed') return 'bad';
  if (s.status === 'starting') return 'wait';
  if (s.status === 'running') return s.reachable === false ? 'bad' : 'ok';
  return 'off';
}

// The "main" address: the web server for Laravel, the dev server otherwise.
export function runUrl(run) {
  if (!run?.running) return null;
  const main = run.services.find((s) => s.id === 'serve' || s.id === 'dev');
  return main?.url ?? null;
}

export function renderRun(room, run) {
  const box = room.querySelector('.run');
  if (!box) return;
  const btn = box.querySelector('.run-btn');
  const running = !!run?.running;
  const kind = run?.kind ?? 'none';
  box.dataset.state = running ? 'on' : kind === 'none' ? 'none' : 'off';
  btn.innerHTML = running ? STOP : PLAY;
  btn.setAttribute('aria-label', running ? 'Stop the project' : 'Run the project');
  btn.title = running
    ? 'Stop everything the play button started'
    : kind === 'none'
      ? (run?.note ?? 'Nothing to run yet') + ' Click to check again.'
      : `Run the ${KIND[kind]} project: ${run.services.map((s) => s.command).join(', ')}`;
  box.querySelector('.run-kind').textContent = kind === 'none' ? run?.note ?? 'Nothing to run yet' : running ? `${KIND[kind]} running` : KIND[kind];
  const anyBad = running && run.services.some((s) => s.status === 'failed' || s.reachable === false);
  box.classList.toggle('trouble', anyBad);
  box.querySelector('.run-services').innerHTML =
    kind === 'none'
      ? ''
      : run.services
          .map((s) => {
            const t = tone(s);
            const text = statusText(s, running);
            // Only web addresses open in a tab; a websocket address is just shown.
            const addr = running && s.url && /^https?:/.test(s.url) && s.status === 'running' && s.reachable !== false;
            return `<li class="${t}" data-service="${esc(s.id)}" title="${esc(s.command)}${s.lastLine ? '\n' + esc(s.lastLine) : ''}">
              <i></i><b>${esc(s.label)}</b>
              ${addr ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(text)}</a>` : `<span>${esc(text)}</span>`}
              <button class="run-log-btn" aria-label="Show the output of ${esc(s.label)}">Log</button>
            </li>`;
          })
          .join('');
}

// ---------- the log dialog ----------

function renderLogHead() {
  const run = ctx.getRun(open.teamId);
  const s = run?.services.find((x) => x.id === open.service);
  const team = ctx.getTeam(open.teamId);
  $('rl-title').textContent = `${team?.name ?? 'Team'}: ${s?.label ?? open.service}`;
  $('rl-cmd').textContent = s?.command ?? '';
  const st = s ? statusText(s, !!run?.running) : '';
  $('rl-status').textContent = st;
  $('rl-status').dataset.tone = s ? tone(s) : 'off';
  const link = $('rl-open');
  link.hidden = !(s?.url && /^https?:/.test(s.url) && run?.running);
  if (!link.hidden) link.href = s.url;
}

function appendLine(line) {
  const pre = $('rl-out');
  const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  pre.append(line + '\n');
  if (stick) pre.scrollTop = pre.scrollHeight;
}

export function openRunLog(teamId, service) {
  open = { teamId, service };
  $('rl-out').textContent = '';
  renderLogHead();
  ctx.send({ type: 'run_log', teamId, service });
  $('run-dialog').showModal();
}

// Server events about runs. Returns true when the room needs re-rendering.
export function onRunEvent(e) {
  if (e.type === 'run_log' && open && e.teamId === open.teamId && e.service === open.service) {
    $('rl-out').textContent = e.lines.length ? e.lines.join('\n') + '\n' : 'Nothing printed yet.\n';
    $('rl-out').scrollTop = $('rl-out').scrollHeight;
    return;
  }
  if (e.type === 'run_out' && open && e.teamId === open.teamId && e.service === open.service) {
    if ($('rl-out').textContent === 'Nothing printed yet.\n') $('rl-out').textContent = '';
    appendLine(e.line);
    return;
  }
  if (e.type === 'run' && open && e.run.teamId === open.teamId) renderLogHead();
}

export function initRun(c) {
  ctx = { ...ctx, ...c };
  $('rl-close').addEventListener('click', () => $('run-dialog').close());
  $('run-dialog').addEventListener('close', () => (open = null));
  $('rl-clear').addEventListener('click', () => ($('rl-out').textContent = ''));
}
