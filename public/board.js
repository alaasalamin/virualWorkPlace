// Task boards: sticky notes on each building's whiteboard, and the full board in a dialog.
import { portraitSVG } from './characters.js';

const COLUMNS = [
  { key: 'todo', label: 'To do', empty: 'Nothing waiting.' },
  { key: 'doing', label: 'Doing', empty: 'No one is working on anything.' },
  { key: 'review', label: 'In review', empty: 'Nothing being reviewed.' },
  { key: 'done', label: 'Done', empty: 'Nothing finished yet.' },
  { key: 'blocked', label: 'Stopped', empty: '', onlyIfAny: true },
];
const STICKIES_SHOWN = 6;

let ctx = {
  getTeam: () => undefined,
  getTasks: () => [],
  getVisions: () => [],
  onRemoveVision: () => {},
  getAgent: () => undefined,
  getOrchestrator: () => undefined,
  onCard: () => {},
  onAction: () => {},
  onAdd: () => {},
};
let adding = false;
let openTeamId = null;

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const columnOf = (t) => t.status;
const STATUS_WORDS = { todo: 'to do', doing: 'working', review: 'reviewing', done: 'done', blocked: 'stopped' };

// Parts of a split card are shown inside their parent, not as cards of their own.
function topLevel(list) {
  const ids = new Set(list.map((t) => t.id));
  return list.filter((t) => !t.parentId || !ids.has(t.parentId));
}

export function initBoard(c) {
  ctx = { ...ctx, ...c };
  $('board-close').addEventListener('click', () => $('board-dialog').close());
  $('board-dialog').addEventListener('close', () => {
    openTeamId = null;
    adding = false;
  });
  $('board-cols').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const title = f.title.value.trim();
    if (!title) return f.title.focus();
    ctx.onAdd(openTeamId, title, f.detail.value.trim());
    adding = false;
    renderBoard();
  });
  $('board-visions').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-vision]');
    if (!btn) return;
    // Two clicks, so a stray one doesn't delete a vision.
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = 'Click again to remove';
      return;
    }
    btn.disabled = true;
    ctx.onRemoveVision(btn.dataset.removeVision);
  });
  $('board-cols').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-assignee]')) {
      e.preventDefault();
      e.target.click();
    }
  });
  $('board-cols').addEventListener('click', (e) => {
    if (e.target.closest('#add-open')) {
      adding = true;
      renderBoard();
      $('board-cols').querySelector('form [name=title]')?.focus();
      return;
    }
    if (e.target.closest('#add-cancel')) {
      adding = false;
      return renderBoard();
    }
    if (e.target.closest('form')) return;
    const action = e.target.closest('[data-action]');
    if (action) {
      action.disabled = true;
      ctx.onAction(action.dataset.task, action.dataset.action);
      return;
    }
    const card = e.target.closest('[data-assignee]');
    if (!card) return;
    $('board-dialog').close();
    ctx.onCard(card.dataset.assignee);
  });
}

export function renderWhiteboard(room, teamId) {
  const list = topLevel(ctx.getTasks(teamId));
  const counts = {};
  for (const col of COLUMNS) {
    if (col.onlyIfAny) continue;
    const cards = list.filter((t) => columnOf(t) === col.key || (col.key === 'doing' && t.status === 'blocked'));
    counts[col.key] = cards.length;
    const shown = col.key === 'done' ? cards.slice(-STICKIES_SHOWN) : cards.slice(0, STICKIES_SHOWN);
    const extra = cards.length - shown.length;
    room.querySelector(`.wb-col[data-col="${col.key}"] i`).innerHTML =
      shown.map((t) => `<em class="sticky ${t.kind}${t.status === 'blocked' ? ' blocked' : ''}"></em>`).join('') +
      (extra > 0 ? `<small>+${extra}</small>` : '');
  }
  room.querySelector('.whiteboard').setAttribute(
    'aria-label',
    `Task board: ${counts.todo} to do, ${counts.doing} in progress, ${counts.review} in review, ${counts.done} done`,
  );
}

// ---------- visions ----------

const VISION_ORDER = { active: 0, done: 1, dropped: 2 };
const MILESTONE_WORDS = { todo: 'To do', doing: 'In progress', done: 'Done' };

function sortedVisions(teamId) {
  return [...ctx.getVisions(teamId)].sort((a, b) => VISION_ORDER[a.status] - VISION_ORDER[b.status] || b.updatedAt - a.updatedAt);
}

function doneCount(v) {
  return v.milestones.filter((m) => m.status === 'done').length;
}

// One segment per milestone: filled when done, striped while in progress.
function barHTML(v) {
  return `<span class="vbar" role="img" aria-label="${doneCount(v)} of ${v.milestones.length} milestones done">${v.milestones
    .map((m) => `<i class="${m.status}" title="${esc(m.title)}: ${MILESTONE_WORDS[m.status].toLowerCase()}"></i>`)
    .join('')}</span>`;
}

// The bar on the building's wall shows the active vision that moved most recently.
export function renderVisionBar(room, teamId) {
  const el = room.querySelector('.vision-bar');
  const active = sortedVisions(teamId).filter((v) => v.status === 'active');
  el.hidden = !active.length;
  if (!active.length) return;
  const v = active[0];
  const more = active.length - 1;
  el.innerHTML = `<b>${esc(v.title)}</b>${barHTML(v)}<span class="vcount">${doneCount(v)}/${v.milestones.length}${more ? ` · +${more} more` : ''}</span>`;
  el.setAttribute('aria-label', `Vision ${v.title}: ${doneCount(v)} of ${v.milestones.length} milestones done. Open the task board`);
}

function visionHTML(v, open) {
  const chip = v.status === 'active' ? '' : `<span class="vstatus ${v.status}">${v.status === 'done' ? 'Done' : 'Dropped'}</span>`;
  return `<details class="vision ${v.status}" data-vision="${esc(v.id)}"${open ? ' open' : ''}>
      <summary>
        <span class="vhead"><b>${esc(v.title)}</b>${chip}<span class="vcount">${doneCount(v)} of ${v.milestones.length} milestones</span></span>
        ${barHTML(v)}
      </summary>
      ${v.summary ? `<p class="vsummary">${esc(v.summary)}</p>` : ''}
      <ol class="milestones">${v.milestones.map((m) => `<li class="${m.status}"><span>${MILESTONE_WORDS[m.status]}</span>${esc(m.title)}</li>`).join('')}</ol>
      <button class="link-btn" data-remove-vision="${esc(v.id)}">Remove vision</button>
    </details>`;
}

function renderVisions() {
  const list = sortedVisions(openTeamId);
  const box = $('board-visions');
  // Keep visions the owner opened or closed that way across live updates; active ones start open.
  const was = new Map([...box.querySelectorAll('details[data-vision]')].map((d) => [d.dataset.vision, d.open]));
  box.hidden = !list.length;
  box.innerHTML = list.length
    ? `<h3>Visions</h3>${list.map((v) => visionHTML(v, was.get(v.id) ?? v.status === 'active')).join('')}`
    : '';
}

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function partsHTML(t, parts) {
  if (!parts.length) {
    if (t.createdBy !== 'owner' || t.status !== 'todo') return '';
    const boss = ctx.getAgent(t.assigneeId);
    return `<p class="card-wait">Waiting for ${esc(boss?.name ?? 'the orchestrator')} to pick who does it</p>`;
  }
  const done = parts.filter((p) => p.status === 'done').length;
  return `<ul class="card-parts">
      ${parts
        .map((p) => {
          const a = ctx.getAgent(p.assigneeId);
          return `<li class="part ${p.status}">${a ? portraitSVG(a.name, a.isOrchestrator) : ''}<b>${esc(a?.name ?? 'Left')}</b><span>${STATUS_WORDS[p.status]}</span></li>`;
        })
        .join('')}
    </ul>
    <p class="card-progress">${done} of ${parts.length} done</p>`;
}

function cardHTML(t, parts = []) {
  const who = ctx.getAgent(t.assigneeId);
  const from = t.createdBy === 'owner' ? 'you' : ctx.getAgent(t.createdBy)?.name ?? 'someone';
  const meta = t.kind === 'review' ? `Review asked by ${esc(from)}` : `From ${esc(from)}`;
  const result = (t.status === 'done' || t.status === 'blocked') && t.result ? `<p class="card-result">${esc(t.result)}</p>` : '';
  const actions =
    t.status === 'blocked'
      ? `<span class="card-actions">
          ${who ? `<button class="btn no" data-action="retry" data-task="${esc(t.id)}">Retry</button>` : ''}
          <button class="link-btn" data-action="remove" data-task="${esc(t.id)}">Remove</button>
        </span>`
      : '';
  return `<div class="card ${t.kind}${t.status === 'blocked' ? ' blocked' : ''}" data-assignee="${esc(t.assigneeId)}" role="button" tabindex="0" title="Open ${esc(who?.name ?? '')}'s chat">
      <b>${esc(t.title)}</b>
      ${partsHTML(t, parts)}
      ${result}
      <span class="card-foot">
        <span class="card-who">${who ? portraitSVG(who.name, who.isOrchestrator) : ''}${esc(who?.name ?? 'Left the team')}</span>
        <span>${meta}, ${ago(t.updatedAt)}</span>
      </span>
      ${actions}
    </div>`;
}

function renderBoard() {
  const team = ctx.getTeam(openTeamId);
  if (!team) return;
  $('board-title').textContent = `${team.name}: task board`;
  renderVisions();
  const all = ctx.getTasks(openTeamId);
  const list = topLevel(all);
  const partsOf = (t) => all.filter((p) => p.parentId === t.id);
  const cols = COLUMNS.filter((col) => !col.onlyIfAny || list.some((t) => columnOf(t) === col.key));
  $('board-cols').style.setProperty('--cols', cols.length);
  $('board-cols').innerHTML = cols.map((col) => {
    let cards = list.filter((t) => columnOf(t) === col.key);
    if (col.key === 'done') cards = cards.slice(-30).reverse();
    const add =
      col.key !== 'todo'
        ? ''
        : adding
          ? `<form class="add-task">
              <input name="title" maxlength="120" placeholder="What needs doing?" aria-label="Task title" autocomplete="off">
              <textarea name="detail" rows="3" placeholder="Details, links, acceptance criteria (optional)" aria-label="Details"></textarea>
              <span class="add-actions"><button class="btn go" type="submit">Add task</button><button class="btn no" type="button" id="add-cancel">Cancel</button></span>
              <small>${esc(ctx.getOrchestrator(openTeamId)?.name ?? 'The orchestrator')} will pick who does it.</small>
            </form>`
          : '<button class="add-open" id="add-open">+ Add task</button>';
    const empty = col.key === 'todo' && adding ? '' : `<p class="board-empty">${col.empty}</p>`;
    return `<section class="board-col" data-col="${col.key}">
        <h3>${col.label} <span>${cards.length}</span></h3>
        <div class="board-cards">${add}${cards.length ? cards.map((t) => cardHTML(t, partsOf(t))).join('') : empty}</div>
      </section>`;
  }).join('');
}

export function openBoard(teamId) {
  openTeamId = teamId;
  renderBoard();
  $('board-dialog').showModal();
}

export function refreshBoard(teamId) {
  // Don't wipe a half-typed task.
  if (openTeamId && openTeamId === teamId && !adding) renderBoard();
}

export function refreshVisions(teamId) {
  // Only the visions section, so a half-typed task survives.
  if (openTeamId && openTeamId === teamId) renderVisions();
}
