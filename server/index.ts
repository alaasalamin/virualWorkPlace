import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import {
  ROOT, MODELS, load, flush, agents, chats, createTeam, findAgentByName, getAgent, removeAgent, statuses, teamAt, teams,
  updateAgent, updateTeam,
} from './store.ts';
import type { ModelKey } from './store.ts';
import { catalog, ensureOfficePlugin, resolveSkills } from './skills.ts';
import { decide, onApprovalChange, pendingApprovals } from './approvals.ts';
import { cardTitle, createTask, onRuntimeEvent, scrubHistory, send, stop, triageTask } from './runtime.ts';
import { changesFor, flushChanges, loadChanges } from './changes.ts';
import { latestUsage, onUsage, refreshUsage, startUsagePolling, stopUsagePolling } from './usage.ts';
import { checkName, checkVaultAccess, deleteKey, exportJson, importJson, listKeys, readValue, setValue } from './vault.ts';
import { PROJECTS_DIR, getTeam, orchestratorOf, removeTask, removeVision, tasks, visions } from './store.ts';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4545);
// Previews of the teams' sites run on their own port, so pages agents write can't reach the office.
const PREVIEW_PORT = PORT + 1;
const PUBLIC = join(ROOT, 'public');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

load();
loadChanges();
try {
  checkVaultAccess();
} catch (e) {
  console.warn(`The team safes are unavailable: couldn't reach the macOS Keychain (${e instanceof Error ? e.message : e}).`);
}
ensureOfficePlugin();

// Save everything before exiting so no conversation is lost.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    flush();
    flushChanges();
    process.exit(0);
  });
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname === '/api/changes') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(changesFor(url.searchParams.get('agent') ?? '')));
    return;
  }
  const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

// Only pages served by this server may connect; stops other websites from driving the agents.
const allowedOrigins = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);
const wss = new WebSocketServer({
  server: http,
  path: '/ws',
  verifyClient: ({ origin }: { origin: string }) => allowedOrigins.has(origin),
});

function broadcast(event: unknown) {
  const data = JSON.stringify(event);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
}

onRuntimeEvent(broadcast);
onUsage((usage) => broadcast({ type: 'usage', usage }));
onApprovalChange(broadcast);

wss.on('connection', (ws) => {
  // Keep the usage meter fresh only while someone has the office open.
  startUsagePolling();
  ws.on('close', () => {
    if (![...wss.clients].some((c) => c.readyState === WebSocket.OPEN)) stopUsagePolling();
  });
  ws.send(
    JSON.stringify({
      type: 'snapshot',
      teams: teams(),
      agents: agents(),
      chats: chats(),
      statuses: Object.fromEntries(statuses),
      approvals: pendingApprovals(),
      tasks: tasks(),
      visions: visions(),
      usage: latestUsage(),
      previewPort: PREVIEW_PORT,
      skills: catalog().map(({ id, name, description, plugin }) => ({ id, name, description, plugin })),
    }),
  );

  ws.on('message', (raw) => {
    let m: any;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    switch (m.type) {
      case 'chat': {
        const text = String(m.text ?? '').trim();
        const a = getAgent(m.agentId);
        if (!text || !a) break;
        // Asking a worker directly puts a card on their team's board.
        const card = a.isOrchestrator
          ? undefined
          : createTask({ teamId: a.teamId, kind: 'task', title: cardTitle(undefined, text), detail: text, assigneeId: a.id, createdBy: 'owner' });
        send(a.id, text, { kind: 'user' }, card).catch(() => {});
        break;
      }
      case 'decide':
        decide(String(m.id), { approved: !!m.approved, always: !!m.always, note: m.note ? String(m.note) : undefined });
        break;
      case 'stop':
        stop(String(m.agentId));
        break;
      case 'rename': {
        const name = String(m.name ?? '').trim().slice(0, 40);
        const a = name && updateAgent(String(m.agentId), { name });
        if (a) broadcast({ type: 'agent', agent: a });
        break;
      }
      case 'create_team': {
        const col = Math.trunc(Number(m.col));
        const row = Math.trunc(Number(m.row));
        const name = String(m.name ?? '').trim().slice(0, 40);
        const project = String(m.project ?? '').trim().slice(0, 48);
        const orchestratorName = String(m.orchestratorName ?? '').trim().slice(0, 30);
        const model = (String(m.model) in MODELS ? String(m.model) : 'opus') as ModelKey;
        let error = '';
        if (!name || !project || !orchestratorName) error = 'Fill in the team name, project and orchestrator name.';
        else if (!Number.isFinite(col) || !Number.isFinite(row) || Math.abs(col) > 50 || Math.abs(row) > 50) error = 'That spot is off the map.';
        else if (teamAt(col, row)) error = 'Another team already works on that spot.';
        else if (teams().some((t) => t.name.toLowerCase() === name.toLowerCase())) error = `There's already a team called ${name}.`;
        else if (findAgentByName(orchestratorName)) error = `Someone named ${orchestratorName} already works in the office.`;
        if (error) {
          ws.send(JSON.stringify({ type: 'team_error', error }));
          break;
        }
        const { team, boss } = createTeam({ name, project, orchestratorName, model, col, row });
        broadcast({ type: 'team', team });
        broadcast({ type: 'agent', agent: boss });
        ws.send(JSON.stringify({ type: 'team_created', teamId: team.id, orchestratorId: boss.id }));
        break;
      }
      case 'rename_team': {
        const name = String(m.name ?? '').trim().slice(0, 40);
        const t = name && updateTeam(String(m.teamId), { name });
        if (t) broadcast({ type: 'team', team: t });
        break;
      }
      case 'refresh_usage':
        refreshUsage();
        break;
      case 'add_task': {
        const team = getTeam(String(m.teamId));
        const title = String(m.title ?? '').trim().slice(0, 120);
        const detail = String(m.detail ?? '').trim().slice(0, 8000);
        const boss = team && orchestratorOf(team.id);
        if (!team || !title || !boss) break;
        // The orchestrator owns the card until they hand parts of it to teammates.
        const task = createTask({ teamId: team.id, kind: 'task', title, detail: detail || title, assigneeId: boss.id, createdBy: 'owner' });
        triageTask(task);
        break;
      }
      // ---------- the team safes (owner only; values go to this tab, never broadcast) ----------
      case 'vault_open':
      case 'vault_reveal':
      case 'vault_export':
      case 'vault_save_json':
      case 'vault_set':
      case 'vault_delete': {
        const teamId = String(m.teamId);
        const reply = (o: object) => ws.send(JSON.stringify({ teamId, ...o }));
        if (!getTeam(teamId)) break;
        try {
          const env = String(m.env ?? '');
          const key = String(m.key ?? '');
          if (m.type === 'vault_reveal') {
            reply({ type: 'vault_value', env, key, value: readValue(teamId, env, key) ?? '' });
            break;
          }
          if (m.type === 'vault_export') {
            reply({ type: 'vault_json', json: JSON.stringify(exportJson(teamId), null, 2) });
            break;
          }
          if (m.type === 'vault_save_json') {
            let parsed: unknown;
            try {
              parsed = JSON.parse(String(m.json ?? ''));
            } catch {
              throw new Error("That isn't valid JSON. Check for missing quotes or commas.");
            }
            importJson(teamId, parsed, 'you');
          } else if (m.type === 'vault_set') {
            const err = checkName(env, key);
            if (err) throw new Error(err);
            setValue(teamId, env, key, String(m.value ?? ''), 'you');
          } else if (m.type === 'vault_delete') {
            deleteKey(teamId, env, key);
          }
          if (m.type !== 'vault_open') {
            scrubHistory(teamId);
            broadcast({ type: 'vault_changed', teamId });
          }
          reply({ type: 'vault', envs: listKeys(teamId) });
        } catch (e) {
          reply({ type: 'vault_error', error: e instanceof Error ? e.message : String(e) });
        }
        break;
      }
      case 'task_action': {
        const t = tasks().find((x) => x.id === String(m.taskId));
        if (!t || t.status !== 'blocked') break;
        // Parts of a split card go with it.
        for (const id of [t.id, ...tasks().filter((x) => x.parentId === t.id).map((x) => x.id)]) {
          removeTask(id);
          broadcast({ type: 'task_removed', taskId: id });
        }
        const a = getAgent(t.assigneeId);
        if (m.action === 'retry' && a?.isOrchestrator && !t.parentId) {
          // A board task goes back to the orchestrator to pick who does it.
          triageTask(createTask({ teamId: t.teamId, kind: 'task', title: t.title, detail: t.detail, assigneeId: a.id, createdBy: 'owner' }));
        } else if (m.action === 'retry' && a) {
          const card = createTask({ teamId: t.teamId, kind: t.kind, title: t.title, detail: t.detail, assigneeId: a.id, createdBy: 'owner' });
          send(a.id, t.detail, { kind: 'user' }, card).catch(() => {});
        }
        break;
      }
      case 'set_skills': {
        const a = getAgent(String(m.agentId));
        if (!a || a.isOrchestrator || !Array.isArray(m.skills)) break;
        const updated = updateAgent(a.id, { skills: resolveSkills(m.skills.map(String)).ids });
        if (updated) broadcast({ type: 'agent', agent: updated });
        break;
      }
      case 'remove_vision': {
        const v = visions().find((x) => x.id === String(m.visionId));
        if (!v) break;
        removeVision(v.id);
        broadcast({ type: 'vision_removed', visionId: v.id, teamId: v.teamId });
        break;
      }
      case 'set_model': {
        // Takes effect from the agent's next turn; the session carries over.
        if (!(String(m.model) in MODELS)) break;
        const updated = updateAgent(String(m.agentId), { model: String(m.model) as ModelKey });
        if (updated) broadcast({ type: 'agent', agent: updated });
        break;
      }
      case 'dismiss': {
        const a = getAgent(String(m.agentId));
        if (a && !a.isOrchestrator) {
          stop(a.id);
          removeAgent(a.id);
          broadcast({ type: 'removed', agentId: a.id });
        }
        break;
      }
    }
  });
});

// ---------- site previews ----------

const PREVIEW_TYPES: Record<string, string> = {
  ...TYPES,
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mjs': 'text/javascript; charset=utf-8',
};

const preview = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  let file = join(PROJECTS_DIR, normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(PROJECTS_DIR + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': PREVIEW_TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<div style="font:16px/1.5 system-ui;padding:2em;max-width:60ch">
      <p><b>There's no index.html here.</b></p>
      <p>If this project runs its own server, type its address in the bar above, for example
      <code>localhost:8000</code> for <code>php artisan serve</code> or <code>localhost:5173</code> for <code>npm run dev</code>.
      The office remembers it for this team.</p></div>`);
  }
});
preview.listen(PREVIEW_PORT, HOST);

http.listen(PORT, HOST, () => {
  console.log(`Agent Office running at http://localhost:${PORT}`);
});
