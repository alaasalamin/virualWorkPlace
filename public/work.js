// Seeing the work: file changes as diffs, and a live preview of a team's site.

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const MAX_LINES = 300;
const CONTEXT = 2;

// Line diff that trims the shared start and end, which covers edits and most rewrites.
function diffLines(before, after) {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const rows = [];
  for (let i = Math.max(0, start - CONTEXT); i < start; i++) rows.push([' ', a[i]]);
  for (let i = start; i < endA; i++) rows.push(['-', a[i]]);
  for (let i = start; i < endB; i++) rows.push(['+', b[i]]);
  for (let i = endA; i < Math.min(a.length, endA + CONTEXT); i++) rows.push([' ', a[i]]);
  return rows;
}

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

const VERB = { Edit: 'Edited', MultiEdit: 'Edited', Write: 'Wrote', NotebookEdit: 'Edited notebook' };

export async function renderWork(agent, box) {
  box.innerHTML = '<p class="work-empty">Loading…</p>';
  let list = [];
  try {
    list = await (await fetch(`/api/changes?agent=${encodeURIComponent(agent.id)}`)).json();
  } catch {
    box.innerHTML = '<p class="work-empty">Couldn\'t load changes. Is the server running?</p>';
    return;
  }
  if (!list.length) {
    box.innerHTML = `<p class="work-empty">${esc(agent.name)} hasn't changed any files yet.</p>`;
    return;
  }
  box.innerHTML = list
    .map((c) => {
      const rows = diffLines(c.before, c.after);
      const cut = rows.length > MAX_LINES;
      const body = rows
        .slice(0, MAX_LINES)
        .map(([k, line]) => `<span class="dl ${k === '+' ? 'add' : k === '-' ? 'del' : ''}">${k} ${esc(line)}</span>`)
        .join('');
      const isNew = c.tool === 'Write' && !c.before;
      return `<details class="change" open>
          <summary><b>${esc(c.path)}</b><span>${isNew ? 'Created' : VERB[c.tool] ?? c.tool}, ${ago(c.ts)}</span></summary>
          <pre class="diff">${body}${cut ? `<span class="dl">… ${rows.length - MAX_LINES} more lines</span>` : ''}</pre>
        </details>`;
    })
    .join('');
}

// ---------- everything one task changed ----------

let diffTaskId = null;

export function initDiff(send) {
  $('df-close').addEventListener('click', () => $('diff-dialog').close());
  $('diff-dialog').addEventListener('close', () => (diffTaskId = null));
  $('df-revert').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    // Two clicks, so a stray one doesn't undo someone's work.
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = 'Click again to revert';
      return;
    }
    btn.disabled = true;
    send({ type: 'revert_task', taskId: diffTaskId });
  });
}

function patchHTML(patch) {
  const lines = patch.replace(/\n$/, '').split('\n');
  const body = lines
    .slice(0, MAX_LINES)
    .map((l) => `<span class="dl ${l.startsWith('@@') ? 'hunk' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : ''}">${esc(l) || ' '}</span>`)
    .join('');
  return body + (lines.length > MAX_LINES ? `<span class="dl">… ${lines.length - MAX_LINES} more lines</span>` : '');
}

const STATUS = { A: 'Created', M: 'Changed', D: 'Deleted' };

export async function openTaskDiff(task, who) {
  diffTaskId = task.id;
  const btn = $('df-revert');
  btn.hidden = true;
  btn.disabled = false;
  btn.textContent = 'Revert these changes';
  delete btn.dataset.armed;
  $('df-title').textContent = task.title;
  $('df-note').textContent = '';
  $('df-body').innerHTML = '<p class="work-empty">Loading…</p>';
  $('diff-dialog').showModal();
  let r;
  try {
    r = await (await fetch(`/api/task-diff?task=${encodeURIComponent(task.id)}`)).json();
  } catch {
    r = { error: "Couldn't load the changes. Is the server running?" };
  }
  if (diffTaskId !== task.id) return;
  if (r.error || !r.files?.length) {
    $('df-body').innerHTML = `<p class="work-empty">${esc(r.error ?? 'No files changed.')}</p>`;
    return;
  }
  const n = r.files.length + (r.more ?? 0);
  $('df-note').textContent =
    `${n} ${n === 1 ? 'file' : 'files'} changed while ${who ?? 'they'} worked on this, including what shell commands did.` +
    (task.shared ? ' A teammate was working in the same folder at the same time, so some of these may be theirs.' : '') +
    (task.reverted ? ' You already reverted this.' : '');
  btn.hidden = !!task.reverted || (task.status !== 'done' && task.status !== 'blocked');
  $('df-body').innerHTML =
    r.files
      .map(
        (f) => `<details class="change" open>
          <summary><b>${esc(f.path)}</b><span>${STATUS[f.status] ?? 'Changed'}</span></summary>
          <pre class="diff">${patchHTML(f.patch)}</pre>
        </details>`,
      )
      .join('') + (r.more ? `<p class="work-empty">…and ${r.more} more files.</p>` : '');
}

export function onRevertResult(e) {
  if (e.taskId !== diffTaskId) return;
  $('df-revert').hidden = !e.error && e.reverted.length > 0;
  $('df-revert').disabled = false;
  $('df-revert').textContent = 'Revert these changes';
  delete $('df-revert').dataset.armed;
  const put = `Put back ${e.reverted.length} ${e.reverted.length === 1 ? 'file' : 'files'}.`;
  const left = e.skipped.length ? ` Left alone because they changed again since: ${e.skipped.join(', ')}.` : '';
  $('df-note').textContent = e.error ?? put + left;
}

// ---------- site preview ----------

let previewPort = 4546;
let previewTeam = null;

export function setPreviewPort(p) {
  previewPort = p;
}

function storedUrl(teamId) {
  try {
    return localStorage.getItem(`agent-office-preview-${teamId}`);
  } catch {
    return null;
  }
}

function defaultUrl(team) {
  return `http://${location.hostname}:${previewPort}/${encodeURIComponent(team.project)}/`;
}

function load(url) {
  $('pv-url').value = url;
  // Sandboxed and on another port, so the page can't act on the office.
  $('pv-frame').src = url;
  $('pv-open').href = url;
}

// Prefers an address the owner typed, then the one the play button's server printed, then the project folder.
export function openPreview(team, runningUrl = null) {
  previewTeam = team;
  $('pv-title').textContent = `${team.name}: preview`;
  load(storedUrl(team.id) ?? runningUrl ?? defaultUrl(team));
  $('preview-dialog').showModal();
}

export function initPreview() {
  $('pv-form').addEventListener('submit', (e) => {
    e.preventDefault();
    let url = $('pv-url').value.trim();
    if (!/^https?:\/\//.test(url)) url = `http://${url}`;
    try {
      localStorage.setItem(`agent-office-preview-${previewTeam.id}`, url);
    } catch {
      // Not remembered.
    }
    load(url);
  });
  $('pv-reset').addEventListener('click', () => {
    try {
      localStorage.removeItem(`agent-office-preview-${previewTeam.id}`);
    } catch {
      // Nothing stored.
    }
    load(defaultUrl(previewTeam));
  });
  $('pv-reload').addEventListener('click', () => load($('pv-url').value));
  $('pv-close').addEventListener('click', () => $('preview-dialog').close());
  $('preview-dialog').addEventListener('close', () => ($('pv-frame').src = 'about:blank'));
}
