// The team safe dialog: environment variables per environment, values hidden until asked for.

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let ctx = { send: () => {}, getTeam: () => undefined };
let teamId = null;
let envs = {};
let env = 'local';
let mode = 'list'; // or 'json'
const revealed = new Map(); // "env/key" -> value, cleared when the safe closes
let pendingCopy = null;
let armedDelete = null;
let addingEnv = false;

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function showError(msg) {
  $('safe-error').textContent = msg;
  $('safe-error').hidden = !msg;
}

function render() {
  const team = ctx.getTeam(teamId);
  $('safe-title').textContent = `${team?.name ?? 'Team'}: safe`;
  $('safe-list-view').hidden = mode !== 'list';
  $('safe-json-view').hidden = mode !== 'json';
  if (mode !== 'list') return;

  const names = Object.keys(envs);
  if (!names.includes(env)) env = names[0] ?? 'local';
  $('safe-envs').innerHTML =
    names
      .map(
        (e) =>
          `<button role="tab" data-env="${esc(e)}" aria-selected="${e === env}">${esc(e)}${e === 'local' ? '' : ' <span class="lock" title="Agents need your OK to change this">●</span>'}</button>`,
      )
      .join('') +
    (addingEnv
      ? '<form class="env-form" id="safe-env-form"><input name="env" maxlength="20" placeholder="staging" aria-label="Environment name" autocomplete="off"><button class="btn no" type="submit">Add</button></form>'
      : '<button class="add-env" id="safe-add-env">+ Environment</button>');

  const keys = envs[env] ?? [];
  $('safe-note').textContent =
    env === 'local'
      ? 'Team members can change these on their own.'
      : 'Team members need your OK to change these or write them to a file.';
  $('safe-rows').innerHTML = keys.length
    ? keys
        .map((k) => {
          const id = `${env}/${k.key}`;
          const shown = revealed.has(id);
          return `<tr>
            <th scope="row"><code>${esc(k.key)}</code></th>
            <td class="val">${shown ? `<code>${esc(revealed.get(id))}</code>` : `<span class="masked" aria-label="hidden">${'•'.repeat(Math.min(12, Math.max(6, k.length)))}</span>`}</td>
            <td class="who">${esc(k.updatedBy)}, ${ago(k.updatedAt)}</td>
            <td class="acts">
              <button class="link-btn" data-act="${shown ? 'hide' : 'show'}" data-key="${esc(k.key)}">${shown ? 'Hide' : 'Show'}</button>
              <button class="link-btn" data-act="copy" data-key="${esc(k.key)}">Copy</button>
              <button class="link-btn danger" data-act="delete" data-key="${esc(k.key)}">${armedDelete === id ? 'Really delete?' : 'Delete'}</button>
            </td>
          </tr>`;
        })
        .join('')
    : `<tr><td colspan="4" class="safe-empty">The ${esc(env)} safe is empty. Add a variable below, or let the team fill it.</td></tr>`;
}

export function initSafe(c) {
  ctx = { ...ctx, ...c };
  $('safe-close').addEventListener('click', () => $('safe-dialog').close());
  $('safe-dialog').addEventListener('close', () => {
    // Don't leave secrets lying around in the page.
    revealed.clear();
    $('safe-json').value = '';
    teamId = null;
  });
  $('safe-envs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-env]');
    if (tab) {
      env = tab.dataset.env;
      armedDelete = null;
      return render();
    }
    if (e.target.closest('#safe-add-env')) {
      addingEnv = true;
      render();
      $('safe-envs').querySelector('input')?.focus();
    }
  });
  $('safe-envs').addEventListener('submit', (e) => {
    e.preventDefault();
    const n = e.target.elements.env.value.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,19}$/.test(n)) return showError('Environment names are lowercase letters, numbers and dashes, like "staging".');
    showError('');
    envs[n] ??= [];
    env = n;
    addingEnv = false;
    render();
  });
  $('safe-rows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const key = b.dataset.key;
    const id = `${env}/${key}`;
    if (b.dataset.act === 'show') ctx.send({ type: 'vault_reveal', teamId, env, key });
    if (b.dataset.act === 'hide') {
      revealed.delete(id);
      render();
    }
    if (b.dataset.act === 'copy') {
      if (revealed.has(id)) copy(revealed.get(id), b);
      else {
        pendingCopy = { id, btn: b };
        ctx.send({ type: 'vault_reveal', teamId, env, key });
      }
    }
    if (b.dataset.act === 'delete') {
      if (armedDelete !== id) {
        armedDelete = id;
        return render();
      }
      armedDelete = null;
      revealed.delete(id);
      ctx.send({ type: 'vault_delete', teamId, env, key });
    }
  });
  $('safe-add').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const key = f.elements.key.value.trim();
    if (!key) return f.elements.key.focus();
    showError('');
    ctx.send({ type: 'vault_set', teamId, env, key, value: f.elements.value.value });
    f.reset();
  });
  $('safe-edit-json').addEventListener('click', () => {
    showError('');
    ctx.send({ type: 'vault_export', teamId });
  });
  $('safe-json-cancel').addEventListener('click', () => {
    mode = 'list';
    $('safe-json').value = '';
    showError('');
    render();
  });
  $('safe-json-save').addEventListener('click', () => {
    showError('');
    ctx.send({ type: 'vault_save_json', teamId, json: $('safe-json').value });
  });
}

function copy(value, btn) {
  navigator.clipboard?.writeText(value).then(
    () => {
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = 'Copy'), 1200);
    },
    () => showError("Couldn't copy. Use Show and copy it by hand."),
  );
}

export function openSafe(id) {
  teamId = id;
  mode = 'list';
  env = 'local';
  envs = {};
  armedDelete = null;
  addingEnv = false;
  showError('');
  render();
  $('safe-dialog').showModal();
  ctx.send({ type: 'vault_open', teamId });
}

// Replies and updates from the server.
export function onSafeEvent(e) {
  if (e.type === 'vault_changed') {
    if (teamId === e.teamId && mode === 'list') ctx.send({ type: 'vault_open', teamId });
    return;
  }
  if (e.teamId !== teamId) return;
  if (e.type === 'vault') {
    const keep = Object.fromEntries(Object.keys(envs).filter((n) => !e.envs[n]).map((n) => [n, []]));
    envs = { ...e.envs, ...keep };
    if (mode === 'json') {
      mode = 'list';
      $('safe-json').value = '';
    }
    render();
  } else if (e.type === 'vault_value') {
    const id = `${e.env}/${e.key}`;
    if (pendingCopy?.id === id) {
      copy(e.value, pendingCopy.btn);
      pendingCopy = null;
      return;
    }
    revealed.set(id, e.value);
    render();
  } else if (e.type === 'vault_json') {
    mode = 'json';
    $('safe-json').value = e.json;
    render();
    $('safe-json').focus();
  } else if (e.type === 'vault_error') {
    showError(e.error);
  }
}
