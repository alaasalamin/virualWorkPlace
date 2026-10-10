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
