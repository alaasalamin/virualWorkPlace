import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'data');
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

export type Agent = {
  id: string;
  name: string;
  role: string;
  personality: string;
  model: ModelKey;
  project: string | null;
  cwd: string;
  isOrchestrator: boolean;
  sessionId: string | null;
  costUsd: number;
  alwaysAllow: string[];
  createdAt: number;
};

export type ChatMsg = {
  id: string;
  agentId: string;
  from: 'user' | 'agent' | 'tool' | 'system' | 'boss';
  text: string;
  ts: number;
};

type State = { agents: Agent[]; chats: Record<string, ChatMsg[]> };

const MAX_CHAT = 300;

let state: State = { agents: [], chats: {} };
// Status is runtime-only: nothing is "working" after a restart.
export const statuses = new Map<string, { status: Status; detail: string }>();

export function load() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(HQ_DIR, { recursive: true });
  mkdirSync(PROJECTS_DIR, { recursive: true });
  if (existsSync(STATE_FILE)) state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  if (!state.agents.some((a) => a.isOrchestrator)) {
    addAgent({
      name: 'Maya',
      role: 'Orchestrator',
      personality: 'Warm, decisive and organised. Thinks before hiring and keeps the team small.',
      model: 'fable',
      project: null,
      isOrchestrator: true,
    });
  }
}

let saveTimer: NodeJS.Timeout | null = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2));
    renameSync(STATE_FILE + '.tmp', STATE_FILE);
  }, 200);
}

export const agents = () => state.agents;
export const getAgent = (id: string) => state.agents.find((a) => a.id === id);
export const findAgentByName = (name: string) =>
  state.agents.find((a) => a.name.toLowerCase() === name.trim().toLowerCase());
export const orchestrator = () => state.agents.find((a) => a.isOrchestrator)!;
export const chats = () => state.chats;

export function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'project';
}

export function addAgent(a: Pick<Agent, 'name' | 'role' | 'personality' | 'model' | 'project' | 'isOrchestrator'>) {
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
  delete state.chats[id];
  save();
}

export function addChat(agentId: string, from: ChatMsg['from'], text: string) {
  const msg: ChatMsg = { id: randomUUID(), agentId, from, text, ts: Date.now() };
  const list = (state.chats[agentId] ??= []);
  list.push(msg);
  if (list.length > MAX_CHAT) list.splice(0, list.length - MAX_CHAT);
  save();
  return msg;
}
