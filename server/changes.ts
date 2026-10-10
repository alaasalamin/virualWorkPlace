import { readFileSync, writeFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './store.ts';

// A file edit an agent made, kept so the owner can see the work as a diff.
export type Change = {
  id: string;
  agentId: string;
  teamId: string;
  toolUseId: string;
  path: string; // relative to the agent's folder when inside it
  tool: string;
  before: string;
  after: string;
  ts: number;
};

const FILE = join(DATA_DIR, 'changes.json');
const MAX_CHANGES = 400;
const MAX_TEXT = 20_000;

let changes: Change[] = [];
let timer: NodeJS.Timeout | null = null;

export function loadChanges() {
  if (existsSync(FILE)) changes = JSON.parse(readFileSync(FILE, 'utf8'));
}

export function flushChanges() {
  if (timer) clearTimeout(timer);
  timer = null;
  writeFileSync(FILE + '.tmp', JSON.stringify(changes));
  renameSync(FILE + '.tmp', FILE);
}

function save() {
  if (!timer) timer = setTimeout(flushChanges, 500);
}

const clip = (s: unknown) => {
  const t = typeof s === 'string' ? s : '';
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + '\n… (cut off)' : t;
};

function readIfSmall(path: string) {
  try {
    if (statSync(path).size > 200_000) return '(file too large to show)';
    return readFileSync(path, 'utf8');
  } catch {
    return ''; // new file
  }
}

// Called when an agent asks to edit a file, before the edit runs.
export function recordEdit(
  agent: { id: string; teamId: string; cwd: string },
  toolUseId: string,
  tool: string,
  input: Record<string, unknown>,
): Change[] {
  const raw = input.file_path ?? input.notebook_path;
  if (typeof raw !== 'string') return [];
  const abs = resolve(agent.cwd, raw);
  const rel = relative(agent.cwd, abs);
  const path = rel.startsWith('..') ? abs : rel;
  const base = { agentId: agent.id, teamId: agent.teamId, toolUseId, path, tool, ts: Date.now() };
  const made: Change[] = [];
  if (tool === 'Edit') {
    made.push({ ...base, id: randomUUID(), before: clip(input.old_string), after: clip(input.new_string) });
  } else if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    for (const e of input.edits as Record<string, unknown>[]) {
      made.push({ ...base, id: randomUUID(), before: clip(e.old_string), after: clip(e.new_string) });
    }
  } else if (tool === 'Write') {
    made.push({ ...base, id: randomUUID(), before: clip(readIfSmall(abs)), after: clip(input.content) });
  } else {
    made.push({ ...base, id: randomUUID(), before: '', after: '(notebook edit)' });
  }
  changes.push(...made);
  if (changes.length > MAX_CHANGES) changes.splice(0, changes.length - MAX_CHANGES);
  save();
  return made;
}

// The edit was denied or failed, so it never happened.
export function dropEdit(toolUseId: string) {
  const before = changes.length;
  changes = changes.filter((c) => c.toolUseId !== toolUseId);
  if (changes.length !== before) save();
  return before !== changes.length;
}

export const changesFor = (agentId: string) => changes.filter((c) => c.agentId === agentId).slice(-60).reverse();
export const changeCount = (agentId: string) => changes.filter((c) => c.agentId === agentId).length;
