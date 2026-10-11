import { stationSVG, portraitSVG } from './characters.js';
import { initWorld, renderRooms, roomFor, focusTeam, refreshCamera } from './world.js';
import { initBoard, openBoard, refreshBoard, renderWhiteboard } from './board.js';
import { initAlerts, alertApproval, alertProblem, refreshAlerts } from './alerts.js';
import { initPreview, openPreview, renderWork, setPreviewPort } from './work.js';
import { initSafe, openSafe, onSafeEvent } from './safe.js';
import { initVisits, onPeer, onMessage as visitMessage, onDelta as visitDelta, onStatus as visitStatus } from './visits.js';

const $ = (id) => document.getElementById(id);
const teams = new Map();
const tasks = new Map();
let panelTab = 'chat';
const agents = new Map();
const statuses = {};
const approvals = new Map();
let chats = {};
let skillCatalog = [];
const streaming = {};
let selected = null;
let ws = null;

// ---------- connection ----------

function connect(delay = 500) {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    $('offline').hidden = true;
    delay = 500;
  };
  ws.onmessage = (e) => onEvent(JSON.parse(e.data));
  ws.onclose = () => {
    $('offline').hidden = false;
    setTimeout(() => connect(Math.min(delay * 2, 8000)), delay);
  };
}

function sendWS(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function onEvent(e) {
  switch (e.type) {
    case 'snapshot':
      teams.clear();
      for (const t of e.teams ?? []) teams.set(t.id, t);
      agents.clear();
      for (const a of e.agents) agents.set(a.id, a);
      chats = e.chats;
      skillCatalog = e.skills ?? [];
      Object.assign(statuses, e.statuses);
      approvals.clear();
      for (const a of e.approvals) approvals.set(a.id, a);
      tasks.clear();
      for (const t of e.tasks ?? []) tasks.set(t.id, t);
      if (e.previewPort) setPreviewPort(e.previewPort);
      renderUsage(e.usage);
      renderOffice();
      renderMemos();
      refreshAlerts();
      if (!cameraRestored) {
        cameraRestored = true;
        const first = [...teams.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
        if (first) focusTeam(first.id, false);
      }
      setTimeout(runDemo, 600);
      if (selected && agents.has(selected)) openChat(selected);
      else if (selected) closeChat();
      break;
    case 'agent':
      agents.set(e.agent.id, e.agent);
      chats[e.agent.id] ??= [];
      renderOffice();
      if (hoverId === e.agent.id) renderHover();
      if (selected === e.agent.id) {
        renderHead();
        renderSkills();
      }
      break;
    case 'team':
      teams.set(e.team.id, e.team);
      renderOffice();
      if (selected) renderHead();
      break;
    case 'usage':
      renderUsage(e.usage);
      break;
    case 'task': {
      const before = tasks.get(e.task.id);
      tasks.set(e.task.id, e.task);
      const room = roomFor(e.task.teamId);
      if (room) renderWhiteboard(room, e.task.teamId);
      refreshBoard(e.task.teamId);
      if (e.task.status === 'blocked' && before?.status !== 'blocked') {
        alertProblem(`Agent Office: a task stopped`, `${agents.get(e.task.assigneeId)?.name ?? 'Someone'}: ${e.task.title}`);
      }
      break;
    }
    case 'task_removed': {
      const t = tasks.get(e.taskId);
      tasks.delete(e.taskId);
      if (t) {
        const room = roomFor(t.teamId);
        if (room) renderWhiteboard(room, t.teamId);
        refreshBoard(t.teamId);
      }
      break;
    }
    case 'change':
      if (selected === e.agentId && panelTab === 'work') renderWork(agents.get(e.agentId), $('work'));
      break;
    case 'vault':
    case 'vault_value':
    case 'vault_json':
    case 'vault_error':
      onSafeEvent(e);
      break;
    case 'vault_changed': {
      onSafeEvent(e);
      // A little turn of the dial when someone puts something in.
      const dial = roomFor(e.teamId)?.querySelector('.safe');
      dial?.classList.remove('spin');
      void dial?.offsetWidth;
      dial?.classList.add('spin');
      break;
    }
    case 'team_created':
      $('team-dialog').close();
      openChat(e.orchestratorId);
      // Center once the chat panel has slid in and the map has its final size.
      setTimeout(() => focusTeam(e.teamId), 300);
      break;
    case 'team_error':
      $('td-error').textContent = e.error;
      $('td-error').hidden = false;
      $('td-submit').disabled = false;
      break;
    case 'removed':
      agents.delete(e.agentId);
      document.querySelector(`.station[data-id="${e.agentId}"]`)?.remove();
      if (selected === e.agentId) closeChat();
      renderOffice();
      break;
    case 'status':
      statuses[e.agentId] = { status: e.status, detail: e.detail };
      updateStation(e.agentId);
      visitStatus(e.agentId, e.status);
      if (selected === e.agentId) renderComposer();
      if (hoverId === e.agentId) renderHover();
      break;
    case 'delta':
      streaming[e.agentId] = (streaming[e.agentId] ?? '') + e.text;
      visitDelta(e.agentId, e.text);
      if (selected === e.agentId) renderStreaming();
      break;
    case 'message': {
      const m = e.msg;
      (chats[m.agentId] ??= []).push(m);
      if (m.from === 'agent') delete streaming[m.agentId];
      visitMessage(m);
      if (selected === m.agentId) {
        if (m.from === 'agent') document.querySelector('.msg.streaming')?.remove();
        appendMsg(m);
      }
      break;
    }
    case 'peer':
      onPeer(e);
      break;
    case 'approval':
      approvals.set(e.approval.id, e.approval);
      renderMemos();
      refreshAlerts();
      alertApproval(e.approval);
      break;
    case 'approval_resolved':
      approvals.delete(e.id);
      renderMemos();
      refreshAlerts();
      break;
  }
}

// ---------- office ----------

const orchOf = (teamId) => [...agents.values()].find((a) => a.teamId === teamId && a.isOrchestrator);

function statusLine(a) {
  const s = statuses[a.id] ?? { status: 'idle', detail: '' };
  switch (s.status) {
    case 'thinking': return 'Thinking…';
    case 'working':
      if (s.detail === 'typing') return 'Typing…';
      if (s.detail === 'message_teammate') return 'Messaging a teammate';
      if (s.detail === 'ask_teammate') return 'Asking a teammate';
      if (s.detail === 'assign_task') return 'Briefing the team';
      return `Using ${s.detail}`;
    case 'waiting': return 'Needs your OK';
    case 'error': return 'Hit an error';
    default: return a.role;
  }
}

function bubbleContent(status) {
  if (status === 'thinking') return '<span class="dots"><i></i><i></i><i></i></span>';
  if (status === 'waiting') return '!';
  if (status === 'error') return '?';
  return '';
}

function makeStation(a) {
  const el = document.createElement('button');
  el.className = 'station' + (a.isOrchestrator ? ' boss' : '');
  el.dataset.id = a.id;
  el.dataset.name = a.name;
  el.innerHTML = `${stationSVG(a.name, a.isOrchestrator)}<span class="bubble"></span><span class="plaque"><b></b><small></small></span>`;
  // Clicking the laptop shows the files they've changed; anywhere else opens the chat.
  el.addEventListener('click', (e) => openChat(a.id, e.target.closest('.laptop') && !a.isOrchestrator ? 'work' : 'chat'));
  el.addEventListener('pointerenter', () => showHover(a.id));
  el.addEventListener('pointerleave', hideHover);
  el.addEventListener('focus', () => showHover(a.id));
  el.addEventListener('blur', hideHover);
  return el;
}

// ---------- hover card ----------

let hoverId = null;

function renderHover() {
  const a = agents.get(hoverId);
  const card = $('hovercard');
  if (!a) return hideHover();
  const used = a.costUsd ? `≈ $${a.costUsd.toFixed(2)}` : '$0.00';
  card.innerHTML = `
    <b>${esc(a.name)}</b>
    <span>${esc(a.role)}</span>
    <dl>
      <dt>Usage</dt><dd>${used}</dd>
      <dt>Model</dt><dd>${esc(MODEL_NAMES[a.model] ?? a.model)}</dd>
      ${a.project ? `<dt>Project</dt><dd>${esc(a.project)}</dd>` : ''}
      ${a.skills?.length ? `<dt>Skills</dt><dd>${a.skills.length}</dd>` : ''}
      <dt>Now</dt><dd>${esc((statuses[a.id]?.status ?? 'idle') === 'idle' ? 'Free' : statusLine(a))}</dd>
    </dl>`;
}

function showHover(id) {
  hoverId = id;
  renderHover();
  const card = $('hovercard');
  const el = document.querySelector(`.station[data-id="${id}"]`);
  if (!el) return;
  card.hidden = false;
  const r = el.getBoundingClientRect();
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  let left = r.right + 8;
  if (left + cw > innerWidth - 8) left = r.left - cw - 8;
  left = Math.max(8, left);
  const top = Math.min(Math.max(8, r.top + r.height * 0.15), innerHeight - ch - 8);
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function hideHover() {
  hoverId = null;
  $('hovercard').hidden = true;
}

function updateStation(id) {
  const a = agents.get(id);
  const el = document.querySelector(`.station[data-id="${id}"]`);
  if (!a || !el) return;
  if (el.dataset.name !== a.name) {
    el.querySelector('.char').outerHTML = stationSVG(a.name, a.isOrchestrator);
    el.dataset.name = a.name;
  }
  const status = statuses[id]?.status ?? 'idle';
  el.dataset.status = status;
  el.querySelector('.bubble').innerHTML = bubbleContent(status);
  el.querySelector('.plaque b').textContent = a.name;
  el.querySelector('.plaque small').textContent = statusLine(a);
  el.classList.toggle('selected', selected === id);
  el.setAttribute('aria-label', `${a.name}, ${a.role}. ${statusLine(a)}. Open chat`);
}

function emptyDesk(teamId) {
  const boss = orchOf(teamId);
  const el = document.createElement('button');
  el.className = 'station empty';
  el.dataset.id = `empty-${teamId}`;
  el.innerHTML = `<svg viewBox="0 0 160 190" class="char" aria-hidden="true">
      <rect x="44" y="84" width="72" height="80" rx="16" fill="#3D4B63" stroke="#1E2A3A" stroke-width="3" stroke-dasharray="7 6"/>
      <rect x="4" y="146" width="152" height="40" rx="6" fill="#2F5D62" stroke="#1E2A3A" stroke-width="3" stroke-dasharray="7 6"/>
    </svg><span class="plaque"><b>Open desk</b><small>Ask ${esc(boss?.name ?? 'the orchestrator')} to hire</small></span>`;
  el.addEventListener('click', () => {
    if (!boss) return;
    openChat(boss.id);
    $('input').value = 'I need someone to help with ';
    $('input').focus();
  });
  return el;
}

function renderOffice() {
  const list = [...teams.values()].sort((a, b) => a.createdAt - b.createdAt);
  renderRooms(list);

  for (const el of document.querySelectorAll('.station[data-id]')) {
    if (!el.classList.contains('empty') && !agents.has(el.dataset.id)) el.remove();
  }
  for (const t of list) {
    const room = roomFor(t.id);
    const row = room.querySelector('.team');
    const front = room.querySelector('.front');
    const members = [...agents.values()].filter((a) => a.teamId === t.id);
    const workers = members.filter((a) => !a.isOrchestrator).sort((x, y) => x.createdAt - y.createdAt);
    for (const a of workers) {
      if (!row.querySelector(`[data-id="${a.id}"]`)) row.appendChild(makeStation(a));
    }
    row.querySelector('.station.empty')?.remove();
    row.appendChild(emptyDesk(t.id));
    const boss = members.find((a) => a.isOrchestrator);
    if (boss && !front.querySelector(`[data-id="${boss.id}"]`)) front.appendChild(makeStation(boss));
    fitStage(room);
    renderWhiteboard(room, t.id);
  }
  for (const a of agents.values()) updateStation(a.id);
  const people = agents.size;
  $('team-count').textContent = `${list.length} ${list.length === 1 ? 'team' : 'teams'}, ${people} ${people === 1 ? 'person' : 'people'}`;
}

// Shrink a team's desks until they all fit inside its room.
function fitStage(room) {
  const stage = room.querySelector('.stage');
  const floor = room.querySelector('.floor');
  stage.style.zoom = 1;
  const cs = getComputedStyle(floor);
  const availH = floor.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const availW = floor.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  stage.style.zoom = Math.max(0.35, Math.min(1, availH / stage.scrollHeight, availW / stage.scrollWidth));
}

// ---------- plan usage meter ----------

let usageWarned = false;

function resetText(iso, withDay) {
  if (!iso) return '';
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return withDay ? `resets ${d.toLocaleDateString([], { weekday: 'short' })} ${time}` : `resets ${time}`;
}

function meterRow(label, w, withDay) {
  const pct = Math.max(0, Math.min(100, Math.round(w.pct)));
  const level = pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low';
  return `<span class="um-row ${level}">
      <span class="um-top"><b>${esc(label)}</b><span>${pct}%</span></span>
      <span class="um-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(label)}"><i style="width:${pct}%"></i></span>
      <small>${esc(resetText(w.resetsAt, withDay))}</small>
    </span>`;
}

function renderUsage(u) {
  const el = $('usage-meter');
  if (!u || (!u.session && !u.week)) return;
  el.hidden = false;
  el.classList.remove('refreshing');
  el.innerHTML = [
    u.session && meterRow('Current session', u.session, false),
    u.week && meterRow('This week', u.week, true),
    ...u.models.map((m) => meterRow(`${m.name} this week`, m, true)),
  ]
    .filter(Boolean)
    .join('');
  // One heads-up when the current session is nearly used up.
  const pct = u.session?.pct ?? 0;
  if (pct >= 90 && !usageWarned) {
    usageWarned = true;
    alertProblem('Agent Office: usage almost used up', `Current session is at ${Math.round(pct)}%. ${resetText(u.session.resetsAt, false)}.`);
  } else if (pct < 80) usageWarned = false;
}

$('usage-meter').addEventListener('click', () => {
  $('usage-meter').classList.add('refreshing');
  sendWS({ type: 'refresh_usage' });
});

// ---------- teams: build and rename ----------

const NAME_IDEAS = ['Sofia', 'Noah', 'Amira', 'Lucas', 'Hana', 'Elias', 'Zara', 'Felix', 'Lina', 'Jonas', 'Nora', 'Adam', 'Mila', 'Rami', 'Ines', 'Theo'];
let dialogMode = null; // { kind: 'new', col, row } or { kind: 'rename', teamId }

function openTeamDialog(mode) {
  dialogMode = mode;
  const f = $('team-form');
  const isNew = mode.kind === 'new';
  f.reset();
  f.classList.toggle('renaming', !isNew);
  for (const el of f.querySelectorAll('.new-only input')) el.required = isNew;
  $('td-title').textContent = isNew ? 'Build a new team' : 'Rename team';
  $('td-submit').textContent = isNew ? 'Build team' : 'Save name';
  $('td-submit').disabled = false;
  $('td-error').hidden = true;
  if (isNew) {
    const taken = new Set([...agents.values()].map((a) => a.name.toLowerCase()));
    f.orchestratorName.value = NAME_IDEAS.find((n) => !taken.has(n.toLowerCase())) ?? '';
  } else {
    f.name.value = teams.get(mode.teamId)?.name ?? '';
  }
  $('team-dialog').showModal();
  f.name.focus();
}

$('team-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  if (dialogMode?.kind === 'new') {
    $('td-submit').disabled = true;
    sendWS({
      type: 'create_team',
      col: dialogMode.col,
      row: dialogMode.row,
      name: f.name.value,
      project: f.project.value,
      orchestratorName: f.orchestratorName.value,
      model: f.model.value,
    });
  } else if (dialogMode?.kind === 'rename') {
    sendWS({ type: 'rename_team', teamId: dialogMode.teamId, name: f.name.value });
    $('team-dialog').close();
  }
});
$('td-cancel').addEventListener('click', () => $('team-dialog').close());

// ---------- memos ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const MODEL_NAMES = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };

function renderMemos() {
  const box = $('memos');
  const existing = new Set([...box.children].map((c) => c.dataset.id));
  for (const el of [...box.children]) if (!approvals.has(el.dataset.id)) el.remove();
  for (const a of approvals.values()) {
    if (existing.has(a.id)) continue;
    const el = document.createElement('section');
    el.className = 'memo';
    el.dataset.id = a.id;
    if (a.kind === 'hire') {
      const d = a.data;
      el.innerHTML = `
        <h3>${esc(a.title)}</h3>
        ${teamLine(a)}
        <div class="hire">
          ${portraitSVG(d.name)}
          <div><b>${esc(d.name)}</b>${esc(d.role)}<br><span class="chip">${esc(MODEL_NAMES[d.model] ?? d.model)}</span> <span class="chip">${esc(d.project)}</span>${d.team ? ` <span class="chip">${esc(d.team)}</span>` : ''}</div>
        </div>
        ${skillChips(d.skills)}
        <p>${esc(a.detail)}</p>
        <input placeholder="Note for ${esc(agents.get(a.agentId)?.name ?? 'the orchestrator')} (optional)" aria-label="Note">
        <div class="actions">
          <button class="btn go" data-act="yes">Hire ${esc(d.name)}</button>
          <button class="btn no" data-act="no">Not now</button>
        </div>`;
    } else if (a.kind === 'skills') {
      el.innerHTML = `
        <h3>${esc(a.title)}</h3>
        ${teamLine(a)}
        ${skillChips(a.data.skills)}
        <p>${esc(a.detail)}</p>
        <input placeholder="Note for ${esc(agents.get(a.agentId)?.name ?? 'the orchestrator')} (optional)" aria-label="Note">
        <div class="actions">
          <button class="btn go" data-act="yes">Give skills</button>
          <button class="btn no" data-act="no">Not now</button>
        </div>`;
    } else {
      el.innerHTML = `
        <h3>${esc(a.title)}</h3>
        ${teamLine(a)}
        <pre>${esc(a.detail)}</pre>
        <input placeholder="Reason, if you deny (optional)" aria-label="Reason">
        <div class="actions">
          <button class="btn go" data-act="yes">Allow</button>
          <button class="btn" data-act="always">Always allow ${esc(a.toolName)}</button>
          <button class="btn no" data-act="no">Deny</button>
        </div>`;
    }
    el.addEventListener('click', (ev) => {
      const act = ev.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'goto') return jumpTo(a);
      const note = el.querySelector('input').value.trim() || undefined;
      sendWS({ type: 'decide', id: a.id, approved: act !== 'no', always: act === 'always', note });
      for (const b of el.querySelectorAll('button')) b.disabled = true;
    });
    box.appendChild(el);
  }
}

const teamOfApproval = (a) => agents.get(a.agentId)?.teamId;

function teamLine(a) {
  const team = teams.get(teamOfApproval(a));
  return team ? `<p class="memo-team">${esc(team.name)} <button class="link-btn" data-act="goto">Take me there</button></p>` : '';
}

// Fly to the team and make the person who's waiting wiggle.
function jumpTo(a) {
  const teamId = teamOfApproval(a);
  if (!teamId) return;
  focusTeam(teamId);
  const el = document.querySelector(`.station[data-id="${a.agentId}"]`);
  el?.classList.remove('ping');
  void el?.offsetWidth;
  el?.classList.add('ping');
  document.querySelector(`.memo[data-id="${a.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function skillLabel(id) {
  return skillCatalog.find((s) => s.id === id)?.name ?? id;
}

function skillChips(ids) {
  if (!ids?.length) return '';
  return `<p class="memo-skills">${ids.map((id) => `<span class="chip skill">${esc(skillLabel(id))}</span>`).join(' ')}</p>`;
}

// ---------- chat panel ----------

function md(text) {
  const parts = String(text).split(/```[\w-]*\n?([\s\S]*?)```/g);
  return parts
    .map((p, i) => {
      if (i % 2) return `<pre><code>${esc(p.replace(/\n$/, ''))}</code></pre>`;
      return esc(p)
        .split(/\n{2,}/)
        .filter((x) => x.trim())
        .map((para) =>
          `<p>${para
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\n/g, '<br>')}</p>`,
        )
        .join('');
    })
    .join('');
}

function msgEl(m) {
  const el = document.createElement('div');
  el.className = `msg ${m.from}`;
  if (m.from === 'peer') {
    const who = agents.get(m.fromId);
    const label = m.mode === 'ask' ? 'Question from' : 'Message from';
    el.innerHTML = `<span class="from">${label} ${esc(who?.name ?? 'a teammate')}</span>${md(m.text)}`;
  } else if (m.from === 'report') {
    el.innerHTML = `<span class="from">Report from ${esc(agents.get(m.fromId)?.name ?? 'a teammate')}</span>${md(m.text)}`;
  } else if (m.from === 'board') {
    el.innerHTML = `<span class="from">New task on the board</span>${md(m.text)}`;
  } else if (m.from === 'boss') {
    const boss = orchOf(agents.get(m.agentId)?.teamId);
    el.innerHTML = `<span class="from">Task from ${esc(boss?.name ?? 'the orchestrator')}</span>${md(m.text)}`;
  } else if (m.from === 'tool') {
    el.textContent = m.text;
  } else if (m.from === 'system') {
    el.textContent = m.text;
  } else {
    el.innerHTML = md(m.text);
  }
  return el;
}

function scrollLog() {
  const log = $('log');
  log.scrollTop = log.scrollHeight;
}

function appendMsg(m) {
  $('log').querySelector('.empty-log')?.remove();
  const near = $('log').scrollHeight - $('log').scrollTop - $('log').clientHeight < 120;
  $('log').insertBefore(msgEl(m), $('log').querySelector('.msg.streaming'));
  if (near) scrollLog();
}

function renderStreaming() {
  const text = streaming[selected];
  let el = $('log').querySelector('.msg.streaming');
  if (!text) return el?.remove();
  if (!el) {
    el = document.createElement('div');
    el.className = 'msg agent streaming';
    $('log').appendChild(el);
  }
  el.innerHTML = md(text);
  scrollLog();
}

function renderHead() {
  const a = agents.get(selected);
  if (!a) return;
  $('p-portrait').innerHTML = portraitSVG(a.name, a.isOrchestrator);
  $('p-name').textContent = a.name;
  $('p-role').textContent = a.role;
  $('p-team').textContent = teams.get(a.teamId)?.name ?? '';
  $('p-model').textContent = MODEL_NAMES[a.model] ?? a.model;
  $('p-project').textContent = a.project ?? '';
  $('p-cost').textContent = a.costUsd ? `≈ $${a.costUsd.toFixed(2)} of usage` : '';
  $('p-dismiss').hidden = a.isOrchestrator;
  $('p-dismiss').textContent = `Let ${a.name} go`;
  delete $('p-dismiss').dataset.armed;
  $('input').placeholder = `Message ${a.name}…`;
}

function renderSkills() {
  const a = agents.get(selected);
  const box = $('p-skills');
  box.hidden = !a || a.isOrchestrator;
  if (box.hidden) return;
  $('p-skills-sum').textContent = a.skills.length
    ? `Skills: ${a.skills.map(skillLabel).join(', ')}`
    : 'Skills: none yet';
  const list = $('p-skill-list');
  if (!skillCatalog.length) {
    list.innerHTML = '<p class="hint">No skills installed. Add skill folders to agent-office/skills, then reload.</p>';
    return;
  }
  list.innerHTML = skillCatalog
    .map((s) => {
      const on = a.skills.includes(s.id);
      return `<button type="button" class="skill-toggle" aria-pressed="${on}" data-skill="${esc(s.id)}" title="${esc(s.description)}">
        <b>${esc(s.name)}</b><span>${esc(s.description)}</span></button>`;
    })
    .join('');
}

$('p-skill-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-skill]');
  const a = agents.get(selected);
  if (!btn || !a) return;
  const id = btn.dataset.skill;
  const skills = a.skills.includes(id) ? a.skills.filter((x) => x !== id) : [...a.skills, id];
  sendWS({ type: 'set_skills', agentId: a.id, skills });
});

function setTab(tab) {
  const a = agents.get(selected);
  panelTab = a && !a.isOrchestrator ? tab : 'chat';
  $('tab-chat').setAttribute('aria-selected', String(panelTab === 'chat'));
  $('tab-work').setAttribute('aria-selected', String(panelTab === 'work'));
  $('log').hidden = panelTab !== 'chat';
  $('composer').hidden = panelTab !== 'chat';
  $('work').hidden = panelTab !== 'work';
  if (panelTab === 'work') renderWork(a, $('work'));
}
$('tab-chat').addEventListener('click', () => setTab('chat'));
$('tab-work').addEventListener('click', () => setTab('work'));

function renderComposer() {
  const s = statuses[selected]?.status ?? 'idle';
  $('p-stop').hidden = s === 'idle' || s === 'error';
}

function openChat(id, tab = 'chat') {
  selected = id;
  document.body.classList.add('chatting');
  $('panel').hidden = false;
  renderHead();
  renderSkills();
  renderComposer();
  $('p-tabs').hidden = agents.get(id)?.isOrchestrator ?? true;
  setTab(tab);
  const log = $('log');
  log.innerHTML = '';
  const list = chats[id] ?? [];
  if (!list.length) {
    const a = agents.get(id);
    log.innerHTML = `<p class="empty-log">${
      a.isOrchestrator
        ? `Tell ${esc(a.name)} what you want built. ${esc(a.name)} asks you before hiring anyone.`
        : `${esc(a.name)} hasn't done anything yet. Give them a task, or ask ${esc(orchOf(a.teamId)?.name)} to.`
    }</p>`;
  }
  for (const m of list) log.appendChild(msgEl(m));
  renderStreaming();
  scrollLog();
  for (const a of agents.values()) updateStation(a.id);
  if (matchMedia('(min-width: 761px)').matches) $('input').focus();
  setTimeout(refreshCamera, 260);
}

function closeChat() {
  selected = null;
  document.body.classList.remove('chatting');
  $('panel').hidden = true;
  for (const a of agents.values()) updateStation(a.id);
  setTimeout(refreshCamera, 260);
}

$('p-close').addEventListener('click', closeChat);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selected) closeChat();
});

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text || !selected) return;
  sendWS({ type: 'chat', agentId: selected, text });
  $('input').value = '';
});
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});
$('p-stop').addEventListener('click', () => sendWS({ type: 'stop', agentId: selected }));
$('p-dismiss').addEventListener('click', () => {
  const btn = $('p-dismiss');
  const a = agents.get(selected);
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = `Click again to let ${a.name} go`;
    return;
  }
  sendWS({ type: 'dismiss', agentId: selected });
});

// Open the page with #demo to watch a pretend exchange. Nothing is sent to the agents.
let demoPlayed = false;
function runDemo() {
  if (demoPlayed || location.hash !== '#demo') return;
  demoPlayed = true;
  const workers = [...agents.values()].filter((a) => !a.isOrchestrator);
  const find = (n) => workers.find((a) => a.name === n);
  const dev = find('Leo') ?? workers[0];
  const designer = find('Mario') ?? workers.find((a) => a !== dev);
  if (!dev || !designer) return;
  const say = async (id, text) => {
    visitMessage({ from: 'peer', agentId: id });
    for (const word of text.split(' ')) {
      visitDelta(id, word + ' ');
      await new Promise((r) => setTimeout(r, 70));
    }
    visitStatus(id, 'idle');
  };
  onPeer({
    fromId: dev.id,
    toId: designer.id,
    mode: 'ask',
    text: `Hey ${designer.name}, I finished the hero section. Can you check the type and colours before I move on?`,
  });
  setTimeout(() => say(designer.id, 'Nice start! Give the headline more weight, and the CTA colour fights with the background. Try a deeper tone.'), 3000);
  setTimeout(() => {
    onPeer({ fromId: designer.id, toId: dev.id, mode: 'message', text: 'Sent you two mockup tweaks in the shared folder.' });
    setTimeout(() => say(dev.id, 'Got them, applying both now.'), 2500);
  }, 13000);
}

initVisits((id) => agents.get(id));
let cameraRestored = initWorld({
  onLot: (col, row) => openTeamDialog({ kind: 'new', col, row }),
  onSign: (teamId) => openTeamDialog({ kind: 'rename', teamId }),
  onBoard: (teamId) => openBoard(teamId),
  onPreview: (teamId) => teams.get(teamId) && openPreview(teams.get(teamId)),
  onSafe: (teamId) => openSafe(teamId),
});
initSafe({ send: sendWS, getTeam: (id) => teams.get(id) });
initBoard({
  getTeam: (id) => teams.get(id),
  getTasks: (teamId) => [...tasks.values()].filter((t) => t.teamId === teamId).sort((a, b) => a.createdAt - b.createdAt),
  getAgent: (id) => agents.get(id),
  onAction: (taskId, action) => sendWS({ type: 'task_action', taskId, action }),
  onAdd: (teamId, title, detail) => sendWS({ type: 'add_task', teamId, title, detail }),
  getOrchestrator: (teamId) => orchOf(teamId),
  onCard: (agentId) => {
    const a = agents.get(agentId);
    if (!a) return;
    focusTeam(a.teamId);
    openChat(agentId);
  },
});
initAlerts({ approvals: () => [...approvals.values()], teamOf: teamOfApproval, onJump: jumpTo });
initPreview();
refreshCamera();
connect();
