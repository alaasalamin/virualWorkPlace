import { stationSVG, portraitSVG } from './characters.js';

const $ = (id) => document.getElementById(id);
const agents = new Map();
const statuses = {};
const approvals = new Map();
let chats = {};
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
      agents.clear();
      for (const a of e.agents) agents.set(a.id, a);
      chats = e.chats;
      Object.assign(statuses, e.statuses);
      approvals.clear();
      for (const a of e.approvals) approvals.set(a.id, a);
      renderOffice();
      renderMemos();
      if (selected && agents.has(selected)) openChat(selected);
      else if (selected) closeChat();
      break;
    case 'agent':
      agents.set(e.agent.id, e.agent);
      chats[e.agent.id] ??= [];
      renderOffice();
      if (selected === e.agent.id) renderHead();
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
      if (selected === e.agentId) renderComposer();
      break;
    case 'delta':
      streaming[e.agentId] = (streaming[e.agentId] ?? '') + e.text;
      if (selected === e.agentId) renderStreaming();
      break;
    case 'message': {
      const m = e.msg;
      (chats[m.agentId] ??= []).push(m);
      if (m.from === 'agent') delete streaming[m.agentId];
      if (selected === m.agentId) {
        if (m.from === 'agent') document.querySelector('.msg.streaming')?.remove();
        appendMsg(m);
      }
      break;
    }
    case 'approval':
      approvals.set(e.approval.id, e.approval);
      renderMemos();
      break;
    case 'approval_resolved':
      approvals.delete(e.id);
      renderMemos();
      break;
  }
}

// ---------- office ----------

const orchestrator = () => [...agents.values()].find((a) => a.isOrchestrator);

function statusLine(a) {
  const s = statuses[a.id] ?? { status: 'idle', detail: '' };
  switch (s.status) {
    case 'thinking': return 'Thinking…';
    case 'working': return s.detail === 'typing' ? 'Typing…' : `Using ${s.detail}`;
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
  el.addEventListener('click', () => openChat(a.id));
  return el;
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

function emptyDesk() {
  const el = document.createElement('button');
  el.className = 'station empty';
  el.dataset.id = 'empty';
  el.innerHTML = `<svg viewBox="0 0 160 190" class="char" aria-hidden="true">
      <rect x="44" y="84" width="72" height="80" rx="16" fill="#3D4B63" stroke="#1E2A3A" stroke-width="3" stroke-dasharray="7 6"/>
      <rect x="4" y="146" width="152" height="40" rx="6" fill="#2F5D62" stroke="#1E2A3A" stroke-width="3" stroke-dasharray="7 6"/>
    </svg><span class="plaque"><b>Open desk</b><small>Ask ${orchestrator()?.name ?? 'the orchestrator'} to hire</small></span>`;
  el.addEventListener('click', () => {
    const boss = orchestrator();
    if (!boss) return;
    openChat(boss.id);
    $('input').value = 'I need someone to help with ';
    $('input').focus();
  });
  return el;
}

function renderOffice() {
  const team = $('team');
  const front = $('front');
  const boss = orchestrator();
  const workers = [...agents.values()].filter((a) => !a.isOrchestrator).sort((x, y) => x.createdAt - y.createdAt);

  for (const el of document.querySelectorAll('.station[data-id]')) {
    if (el.dataset.id !== 'empty' && !agents.has(el.dataset.id)) el.remove();
  }
  for (const a of workers) {
    if (!team.querySelector(`[data-id="${a.id}"]`)) team.appendChild(makeStation(a));
  }
  team.querySelector('[data-id="empty"]')?.remove();
  team.appendChild(emptyDesk());
  if (boss && !front.querySelector(`[data-id="${boss.id}"]`)) front.appendChild(makeStation(boss));
  for (const a of agents.values()) updateStation(a.id);
}

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
        <div class="hire">
          ${portraitSVG(d.name)}
          <div><b>${esc(d.name)}</b>${esc(d.role)}<br><span class="chip">${esc(MODEL_NAMES[d.model] ?? d.model)}</span> <span class="chip">${esc(d.project)}</span></div>
        </div>
        <p>${esc(a.detail)}</p>
        <input placeholder="Note for ${esc(agents.get(a.agentId)?.name ?? 'the orchestrator')} (optional)" aria-label="Note">
        <div class="actions">
          <button class="btn go" data-act="yes">Hire ${esc(d.name)}</button>
          <button class="btn no" data-act="no">Not now</button>
        </div>`;
    } else {
      el.innerHTML = `
        <h3>${esc(a.title)}</h3>
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
      const note = el.querySelector('input').value.trim() || undefined;
      sendWS({ type: 'decide', id: a.id, approved: act !== 'no', always: act === 'always', note });
      for (const b of el.querySelectorAll('button')) b.disabled = true;
    });
    box.appendChild(el);
  }
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
  if (m.from === 'boss') {
    const boss = orchestrator();
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
  $('p-model').textContent = MODEL_NAMES[a.model] ?? a.model;
  $('p-project').textContent = a.project ?? '';
  $('p-cost').textContent = a.costUsd ? `≈ $${a.costUsd.toFixed(2)} of usage` : '';
  $('p-dismiss').hidden = a.isOrchestrator;
  $('p-dismiss').textContent = `Let ${a.name} go`;
  delete $('p-dismiss').dataset.armed;
  $('input').placeholder = `Message ${a.name}…`;
}

function renderComposer() {
  const s = statuses[selected]?.status ?? 'idle';
  $('p-stop').hidden = s === 'idle' || s === 'error';
}

function openChat(id) {
  selected = id;
  document.body.classList.add('chatting');
  $('panel').hidden = false;
  renderHead();
  renderComposer();
  const log = $('log');
  log.innerHTML = '';
  const list = chats[id] ?? [];
  if (!list.length) {
    const a = agents.get(id);
    log.innerHTML = `<p class="empty-log">${
      a.isOrchestrator
        ? `Tell ${esc(a.name)} what you want built. ${esc(a.name)} asks you before hiring anyone.`
        : `${esc(a.name)} hasn't done anything yet. Give them a task, or ask ${esc(orchestrator()?.name)} to.`
    }</p>`;
  }
  for (const m of list) log.appendChild(msgEl(m));
  renderStreaming();
  scrollLog();
  for (const a of agents.values()) updateStation(a.id);
  if (matchMedia('(min-width: 761px)').matches) $('input').focus();
}

function closeChat() {
  selected = null;
  document.body.classList.remove('chatting');
  $('panel').hidden = true;
  for (const a of agents.values()) updateStation(a.id);
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

connect();
