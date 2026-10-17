import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.AGENT_OFFICE_DATA ?? join(ROOT, 'data');
export const PROJECTS_DIR = join(ROOT, '..', 'projects');
export const HQ_DIR = join(DATA_DIR, 'hq');
const STATE_FILE = join(DATA_DIR, 'state.json');

export type ModelKey = 'fable' | 'opus' | 'sonnet' | 'haiku';

export const MODELS: Record<ModelKey, string> = {
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
};

export type Status = 'idle' | 'thinking' | 'working' | 'waiting' | 'error';

export type Team = {
  id: string;
  name: string;
  project: string;
  // Plot on the world map, in whole grid cells.
  col: number;
  row: number;
  createdAt: number;
};

export type Agent = {
  id: string;
  teamId: string;
  name: string;
  role: string;
  personality: string;
  model: ModelKey;
  // Effort Claude Code reported for the last turn; null if the model has no effort levels, unset before the first turn.
  effort?: string | null;
  project: string | null;
  cwd: string;
  isOrchestrator: boolean;
  sessionId: string | null;
  costUsd: number;
  alwaysAllow: string[];
  skills: string[];
  // True while a turn is running; still true on load means the app stopped mid-task.
  busy: boolean;
  createdAt: number;
};

export type ChatMsg = {
  id: string;
  agentId: string;
  from: 'user' | 'agent' | 'tool' | 'system' | 'boss' | 'peer' | 'board' | 'report';
  text: string;
  // For messages from a teammate: who sent it and whether they're waiting on an answer.
  fromId?: string;
  mode?: 'message' | 'ask';
  ts: number;
};

export type TaskStatus = 'todo' | 'doing' | 'review' | 'done' | 'blocked';

export type Task = {
  id: string;
  teamId: string;
  kind: 'task' | 'review';
  title: string;
  detail: string;
  assigneeId: string;
  createdBy: string; // agent id, or 'owner'
  // Set on a teammate's part of a bigger card; the parent finishes when all its parts do.
  parentId?: string;
  status: TaskStatus;
  result?: string;
  // When the assignee started on it (it moved to doing or review); used to estimate finish times.
  startedAt?: number;
  createdAt: number;
  updatedAt: number;
};

// A feature or goal the owner described, broken into milestones by the orchestrator.
// Progress is milestones done out of all milestones.
export type MilestoneStatus = 'todo' | 'doing' | 'done';
export type Milestone = { title: string; status: MilestoneStatus };
export type VisionStatus = 'active' | 'done' | 'dropped';
export type Vision = {
  id: string;
  teamId: string;
  title: string;
  summary: string;
  milestones: Milestone[];
  status: VisionStatus;
  createdAt: number;
  updatedAt: number;
};

type State = { teams: Team[]; agents: Agent[]; chats: Record<string, ChatMsg[]>; tasks: Task[]; visions: Vision[] };

const MAX_CHAT = 300;

let state: State = { teams: [], agents: [], chats: {}, tasks: [], visions: [] };
// Status is runtime-only: nothing is "working" after a restart.
export const statuses = new Map<string, { status: Status; detail: string }>();

export function load() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(HQ_DIR, { recursive: true });
  mkdirSync(PROJECTS_DIR, { recursive: true });
  if (existsSync(STATE_FILE)) state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  state.teams ??= [];
  state.tasks ??= [];
  state.visions ??= [];
  migrateToTeams();
  // Tasks that were running when the app stopped can't finish now.
  for (const t of state.tasks) {
    if (t.status === 'doing' || t.status === 'review' || t.status === 'todo') {
      t.status = 'blocked';
      t.result = 'The app stopped before this finished.';
    }
  }
  for (const a of state.agents) {
    a.skills ??= [];
    if (a.busy) {
      a.busy = false;
      addChat(a.id, 'system', `The app stopped while ${a.name} was working. Ask them to continue if the task isn't finished.`);
    }
  }
  if (!state.teams.length) {
    createTeam({ name: "Maya's team", project: 'first-project', orchestratorName: 'Maya', model: 'fable', col: 0, row: 0 });
  }
}

// Offices from before teams existed become the first team, keeping everyone.
function migrateToTeams() {
  if (state.teams.length || !state.agents.length) return;
  const counts = new Map<string, number>();
  for (const a of state.agents) if (a.project) counts.set(a.project, (counts.get(a.project) ?? 0) + 1);
  const project = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'first-project';
  const boss = state.agents.find((a) => a.isOrchestrator);
  const team: Team = {
    id: randomUUID(),
    name: boss ? `${boss.name}'s team` : 'First team',
    project,
    col: 0,
    row: 0,
    createdAt: Date.now(),
  };
  state.teams.push(team);
  for (const a of state.agents) a.teamId = team.id;
  save();
}

const DEFAULT_ORCH_PERSONALITY = 'Warm, decisive and organised. Thinks before hiring and keeps the team small.';

export function createTeam(t: { name: string; project: string; orchestratorName: string; model: ModelKey; col: number; row: number }) {
  const team: Team = {
    id: randomUUID(),
    name: t.name,
    project: slugify(t.project),
    col: t.col,
    row: t.row,
    createdAt: Date.now(),
  };
  state.teams.push(team);
  const boss = addAgent({
    teamId: team.id,
    name: t.orchestratorName,
    role: 'Orchestrator',
    personality: DEFAULT_ORCH_PERSONALITY,
    model: t.model,
    project: team.project,
    isOrchestrator: true,
  });
  save();
  return { team, boss };
}

// Drops the team with its agents, chats, cards and visions. The project folder on disk stays.
export function removeTeam(id: string) {
  const members = new Set(state.agents.filter((a) => a.teamId === id).map((a) => a.id));
  for (const a of members) delete state.chats[a];
  state.agents = state.agents.filter((a) => !members.has(a.id));
  state.tasks = state.tasks.filter((t) => t.teamId !== id);
  state.visions = state.visions.filter((v) => v.teamId !== id);
  state.teams = state.teams.filter((t) => t.id !== id);
  save();
}

export function updateTeam(id: string, patch: Partial<Pick<Team, 'name'>>) {
  const t = state.teams.find((x) => x.id === id);
  if (!t) return;
  Object.assign(t, patch);
  save();
  return t;
}

let saveTimer: NodeJS.Timeout | null = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 200);
}

// Writes pending changes now. Called on shutdown so nothing is lost.
export function flush() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2));
  renameSync(STATE_FILE + '.tmp', STATE_FILE);
}

export const agents = () => state.agents;
export const getAgent = (id: string) => state.agents.find((a) => a.id === id);
export const findAgentByName = (name: string) =>
  state.agents.find((a) => a.name.toLowerCase() === name.trim().toLowerCase());
export const teams = () => state.teams;
export const getTeam = (id: string) => state.teams.find((t) => t.id === id);
export const teamAt = (col: number, row: number) => state.teams.find((t) => t.col === col && t.row === row);
export const teamMembers = (teamId: string) => state.agents.filter((a) => a.teamId === teamId);
export const orchestratorOf = (teamId: string) => state.agents.find((a) => a.teamId === teamId && a.isOrchestrator)!;
export const chats = () => state.chats;

export function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'project';
}

export function addAgent(
  a: Pick<Agent, 'teamId' | 'name' | 'role' | 'personality' | 'model' | 'project' | 'isOrchestrator'> & { skills?: string[] },
) {
  const project = a.project ? slugify(a.project) : null;
  const cwd = project ? join(PROJECTS_DIR, project) : HQ_DIR;
  mkdirSync(cwd, { recursive: true });
  const agent: Agent = {
    ...a,
    project,
    cwd,
    id: randomUUID(),
    sessionId: null,
    costUsd: 0,
    alwaysAllow: [],
    skills: a.skills ?? [],
    busy: false,
    createdAt: Date.now(),
  };
  state.agents.push(agent);
  state.chats[agent.id] = [];
  save();
  return agent;
}

export function updateAgent(id: string, patch: Partial<Agent>) {
  const a = getAgent(id);
  if (!a) return;
  Object.assign(a, patch);
  save();
  return a;
}

export function removeAgent(id: string) {
  state.agents = state.agents.filter((a) => a.id !== id);
  for (const t of state.tasks) if (t.assigneeId === id && t.status !== 'done') t.status = 'blocked';
  delete state.chats[id];
  save();
}

// ---------- tasks ----------

const DONE_KEPT_PER_TEAM = 100;

export const tasks = () => state.tasks;
export const tasksOf = (teamId: string) => state.tasks.filter((t) => t.teamId === teamId);

export function addTask(t: Pick<Task, 'teamId' | 'kind' | 'title' | 'detail' | 'assigneeId' | 'createdBy'> & { parentId?: string }) {
  const now = Date.now();
  const task: Task = { ...t, id: randomUUID(), status: 'todo', createdAt: now, updatedAt: now };
  state.tasks.push(task);
  // Keep the board from growing forever: drop the oldest finished cards.
  const done = state.tasks.filter((x) => x.teamId === t.teamId && x.status === 'done');
  if (done.length > DONE_KEPT_PER_TEAM) {
    const drop = new Set(done.slice(0, done.length - DONE_KEPT_PER_TEAM).map((x) => x.id));
    state.tasks = state.tasks.filter((x) => !drop.has(x.id));
  }
  save();
  return task;
}

export function updateTask(id: string, patch: Partial<Pick<Task, 'status' | 'result'>>) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  const now = Date.now();
  const starting = (patch.status === 'doing' || patch.status === 'review') && t.status !== patch.status;
  Object.assign(t, patch, { updatedAt: now }, starting ? { startedAt: now } : {});
  save();
  return t;
}

export function removeTask(id: string) {
  state.tasks = state.tasks.filter((t) => t.id !== id);
  save();
}

export const visions = () => state.visions;
export const visionsOf = (teamId: string) => state.visions.filter((v) => v.teamId === teamId);

export function addVision(v: Pick<Vision, 'teamId' | 'title' | 'summary'> & { milestones: string[] }) {
  const now = Date.now();
  const vision: Vision = {
    ...v,
    // Short, so the orchestrator can quote it back easily.
    id: randomUUID().slice(0, 8),
    milestones: v.milestones.map((title) => ({ title, status: 'todo' })),
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  state.visions.push(vision);
  save();
  return vision;
}

// Bumps updatedAt and saves after the caller changed a vision in place.
export function touchVision(v: Vision) {
  v.updatedAt = Date.now();
  save();
  return v;
}

export function removeVision(id: string) {
  state.visions = state.visions.filter((v) => v.id !== id);
  save();
}

// Rewrite every stored text of a team (chats and task cards), e.g. to scrub a secret.
export function rewriteTeamText(teamId: string, fn: (text: string) => string) {
  let changed = false;
  for (const a of state.agents.filter((x) => x.teamId === teamId)) {
    for (const m of state.chats[a.id] ?? []) {
      const next = fn(m.text);
      if (next !== m.text) (m.text = next), (changed = true);
    }
  }
  for (const t of state.tasks.filter((x) => x.teamId === teamId)) {
    for (const f of ['title', 'detail', 'result'] as const) {
      const v = t[f];
      if (typeof v === 'string' && fn(v) !== v) (t[f] = fn(v)), (changed = true);
    }
  }
  for (const v of state.visions.filter((x) => x.teamId === teamId)) {
    for (const f of ['title', 'summary'] as const) {
      if (fn(v[f]) !== v[f]) (v[f] = fn(v[f])), (changed = true);
    }
    for (const m of v.milestones) if (fn(m.title) !== m.title) (m.title = fn(m.title)), (changed = true);
  }
  if (changed) save();
  return changed;
}

export function addChat(agentId: string, from: ChatMsg['from'], text: string, extra?: Pick<ChatMsg, 'fromId' | 'mode'>) {
  const msg: ChatMsg = { id: randomUUID(), agentId, from, text, ts: Date.now(), ...extra };
  const list = (state.chats[agentId] ??= []);
  list.push(msg);
  if (list.length > MAX_CHAT) list.splice(0, list.length - MAX_CHAT);
  save();
  return msg;
}
