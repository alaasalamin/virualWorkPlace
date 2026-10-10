import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import {
  ROOT, MODELS, load, flush, agents, chats, createTeam, findAgentByName, getAgent, removeAgent, statuses, teamAt, teams,
  updateAgent, updateTeam,
} from './store.ts';
import type { ModelKey } from './store.ts';
import { catalog, ensureOfficePlugin, resolveSkills } from './skills.ts';
import { decide, onApprovalChange, pendingApprovals } from './approvals.ts';
import { onRuntimeEvent, send, stop } from './runtime.ts';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4545);
const PUBLIC = join(ROOT, 'public');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

load();
ensureOfficePlugin();

// Save everything before exiting so no conversation is lost.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    flush();
    process.exit(0);
  });
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
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
onApprovalChange(broadcast);

wss.on('connection', (ws) => {
  ws.send(
    JSON.stringify({
      type: 'snapshot',
      teams: teams(),
      agents: agents(),
      chats: chats(),
      statuses: Object.fromEntries(statuses),
      approvals: pendingApprovals(),
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
        if (text && getAgent(m.agentId)) send(m.agentId, text, { kind: 'user' }).catch(() => {});
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
        const model = (String(m.model) in MODELS ? String(m.model) : 'fable') as ModelKey;
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
      case 'set_skills': {
        const a = getAgent(String(m.agentId));
        if (!a || a.isOrchestrator || !Array.isArray(m.skills)) break;
        const updated = updateAgent(a.id, { skills: resolveSkills(m.skills.map(String)).ids });
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

http.listen(PORT, HOST, () => {
  console.log(`Agent Office running at http://localhost:${PORT}`);
});
