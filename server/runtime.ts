import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { resolve, sep } from 'node:path';
import {
  MODELS, PROJECTS_DIR, agents, addAgent, addChat, findAgentByName, getAgent, orchestrator, statuses, updateAgent,
} from './store.ts';
import type { Agent, ChatMsg, ModelKey, Status } from './store.ts';
import { requestApproval } from './approvals.ts';

export type ServerEvent =
  | { type: 'agent'; agent: Agent }
  | { type: 'status'; agentId: string; status: Status; detail: string }
  | { type: 'delta'; agentId: string; text: string }
  | { type: 'message'; msg: ChatMsg };

let broadcast: (e: ServerEvent) => void = () => {};
export function onRuntimeEvent(fn: typeof broadcast) {
  broadcast = fn;
}

function setStatus(agentId: string, status: Status, detail = '') {
  statuses.set(agentId, { status, detail });
  broadcast({ type: 'status', agentId, status, detail });
}

function chat(agentId: string, from: ChatMsg['from'], text: string) {
  broadcast({ type: 'message', msg: addChat(agentId, from, text) });
}

// ---------- permissions ----------

const AUTO_ALLOW = new Set(['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'WebSearch', 'WebFetch', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function inside(path: unknown, dir: string) {
  if (typeof path !== 'string') return false;
  const p = resolve(dir, path);
  return p === dir || p.startsWith(dir + sep);
}

function summarize(toolName: string, input: Record<string, unknown>) {
  const pick = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url ?? input.query;
  if (typeof pick === 'string') return pick.length > 400 ? pick.slice(0, 400) + '…' : pick;
  const json = JSON.stringify(input);
  return json.length > 400 ? json.slice(0, 400) + '…' : json;
}

function permissionsFor(agent: Agent): CanUseTool {
  return async (toolName, input, { signal, decisionReason }) => {
    const fresh = getAgent(agent.id) ?? agent;
    if (AUTO_ALLOW.has(toolName) || toolName.startsWith('mcp__office__') || fresh.alwaysAllow.includes(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }
    if (EDIT_TOOLS.has(toolName) && inside(input.file_path ?? input.notebook_path, fresh.cwd)) {
      return { behavior: 'allow', updatedInput: input };
    }
    const prev = statuses.get(agent.id);
    setStatus(agent.id, 'waiting', `wants to use ${toolName}`);
    const d = await requestApproval(
      {
        kind: 'tool',
        agentId: agent.id,
        toolName,
        title: `${fresh.name} wants to use ${toolName}`,
        detail: summarize(toolName, input) + (decisionReason ? `\n\nWhy: ${decisionReason}` : ''),
      },
      signal,
    );
    setStatus(agent.id, prev?.status === 'waiting' ? 'working' : prev?.status ?? 'working', prev?.detail ?? '');
    if (d.approved && d.always) updateAgent(agent.id, { alwaysAllow: [...fresh.alwaysAllow, toolName] });
    if (d.approved) return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: d.note ? `The user declined: ${d.note}` : 'The user declined this action.' };
  };
}

// ---------- prompts ----------

function workerPrompt(a: Agent) {
  const boss = orchestrator();
  return `You are ${a.name}, a ${a.role} working in a small virtual office. ${a.personality}
You were hired by ${boss.name}, the team's orchestrator, who will hand you tasks. The human owner of the office may also talk to you directly.
Your project folder is ${a.cwd}. Do all your work inside it.
Speak like a friendly colleague, in first person. Keep chat replies short. When you finish a task, end with a brief summary of what you did and anything that still needs attention.`;
}

function orchestratorPrompt(a: Agent) {
  return `You are ${a.name}, the orchestrator of a small virtual office of AI agents. ${a.personality}
You talk with the office owner (the user), understand what they want, and get it done through your team.

How you work:
- Use list_team to see who is in the office and what they are doing.
- When the team lacks a skill a task needs, call propose_agent to hire someone. Every hire needs the owner's approval, so explain briefly why in the reason field. Give each hire a real human first name that isn't already taken, a clear role, a short personality, a model, and a project name (one folder per project; teammates on the same project share it).
- Choose models deliberately: "haiku" for simple or repetitive work, "sonnet" for most engineering, "opus" for hard design or debugging. Never hire a "fable" worker unless the owner asks.
- Use assign_task to hand a teammate a concrete, self-contained task. They don't see this conversation, so include all context they need. You get their report back when they finish.
- Don't hire more people than the work needs. Reuse existing teammates when they fit.
- You can read files in the projects folder (${PROJECTS_DIR}) to check work, but you don't edit files yourself.
Keep replies to the owner short and conversational. Tell them what you're doing and what came back.`;
}

// ---------- orchestrator tools ----------

function officeServer() {
  return createSdkMcpServer({
    name: 'office',
    version: '1.0.0',
    alwaysLoad: true,
    tools: [
      tool('list_team', 'List everyone in the office with their role, model, project and current status.', {}, async () => {
        const lines = agents().map((a) => {
          const s = statuses.get(a.id)?.status ?? 'idle';
          return `- ${a.name}: ${a.role}${a.isOrchestrator ? ' (you)' : ''} | model ${a.model} | project ${a.project ?? '-'} | ${s}`;
        });
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }),
      tool(
        'propose_agent',
        'Propose hiring a new agent. Blocks until the office owner approves or rejects, then returns the decision.',
        {
          name: z.string().describe('A real human first name, unique in the office'),
          role: z.string().describe('Job title, e.g. "Frontend Developer"'),
          personality: z.string().describe('One or two sentences on how they work and talk'),
          model: z.enum(['haiku', 'sonnet', 'opus', 'fable']),
          project: z.string().describe('Project folder name they will work in'),
          reason: z.string().describe('Why the team needs this person, shown to the owner'),
        },
        async (args) => {
          if (findAgentByName(args.name)) {
            return { content: [{ type: 'text', text: `Someone named ${args.name} already works here. Pick another name.` }], isError: true };
          }
          const boss = orchestrator();
          setStatus(boss.id, 'waiting', `wants to hire ${args.name}`);
          const d = await requestApproval({
            kind: 'hire',
            agentId: boss.id,
            title: `${boss.name} wants to hire ${args.name}`,
            detail: args.reason,
            data: { ...args },
          });
          setStatus(boss.id, 'thinking');
          if (!d.approved) {
            chat(boss.id, 'system', `You declined hiring ${args.name}${d.note ? `: ${d.note}` : ''}.`);
            return { content: [{ type: 'text', text: `The owner rejected hiring ${args.name}.${d.note ? ` Their note: ${d.note}` : ''}` }] };
          }
          const agent = addAgent({ ...args, model: args.model as ModelKey, isOrchestrator: false });
          setStatus(agent.id, 'idle');
          broadcast({ type: 'agent', agent });
          chat(boss.id, 'system', `${agent.name} joined the office as ${agent.role}.`);
          return {
            content: [{ type: 'text', text: `Approved. ${agent.name} is hired and works in ${agent.cwd}.${d.note ? ` Owner's note: ${d.note}` : ''}` }],
          };
        },
      ),
      tool(
        'assign_task',
        'Give a teammate a task and wait for their report. Include all context; they cannot see your conversation.',
        { agent_name: z.string(), task: z.string() },
        async ({ agent_name, task }) => {
          const a = findAgentByName(agent_name);
          if (!a || a.isOrchestrator) {
            return { content: [{ type: 'text', text: `No teammate named ${agent_name}. Use list_team.` }], isError: true };
          }
          const report = await send(a.id, task, 'boss');
          return { content: [{ type: 'text', text: `${a.name}'s report:\n${report || '(no text reply)'}` }] };
        },
      ),
    ],
  });
}

// ---------- running turns ----------

const queues = new Map<string, Promise<unknown>>();
const controllers = new Map<string, AbortController>();

// Messages to one agent run one at a time, in order.
export function send(agentId: string, text: string, from: 'user' | 'boss'): Promise<string> {
  const prev = queues.get(agentId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => runTurn(agentId, text, from));
  queues.set(agentId, next);
  return next;
}

export function stop(agentId: string) {
  controllers.get(agentId)?.abort();
}

function childEnv() {
  // Leave out any API key so Claude Code uses the logged-in (Max) account.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.ANTHROPIC_API_KEY;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'agent-office/0.1.0';
  return env;
}

async function runTurn(agentId: string, text: string, from: 'user' | 'boss', retried = false): Promise<string> {
  const agent = getAgent(agentId);
  if (!agent) return '';
  if (!retried) chat(agentId, from, text);
  setStatus(agentId, 'thinking');

  const abort = new AbortController();
  controllers.set(agentId, abort);

  const options: Options = {
    model: MODELS[agent.model],
    cwd: agent.cwd,
    resume: agent.sessionId ?? undefined,
    abortController: abort,
    includePartialMessages: true,
    settingSources: [],
    permissionMode: 'default',
    canUseTool: permissionsFor(agent),
    env: childEnv(),
  };
  if (agent.isOrchestrator) {
    options.systemPrompt = orchestratorPrompt(agent);
    options.tools = ['Read', 'Glob', 'Grep'];
    options.additionalDirectories = [PROJECTS_DIR];
    options.mcpServers = { office: officeServer() };
    options.allowedTools = ['mcp__office__list_team', 'mcp__office__propose_agent', 'mcp__office__assign_task'];
  } else {
    options.systemPrompt = { type: 'preset', preset: 'claude_code', append: workerPrompt(agent) };
  }

  const texts: string[] = [];
  try {
    for await (const m of query({ prompt: text, options }) as AsyncIterable<SDKMessage>) {
      handle(agent, m, texts);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (abort.signal.aborted) {
      chat(agentId, 'system', 'Stopped.');
    } else if (agent.sessionId && !retried) {
      // The saved session may be gone; start a fresh one.
      updateAgent(agentId, { sessionId: null });
      return runTurn(agentId, text, from, true);
    } else {
      chat(agentId, 'system', `Error: ${msg}`);
      setStatus(agentId, 'error', msg);
      return texts.join('\n\n');
    }
  } finally {
    controllers.delete(agentId);
  }
  setStatus(agentId, 'idle');
  return texts.join('\n\n');
}

function handle(agent: Agent, m: SDKMessage, texts: string[]) {
  if ('session_id' in m && m.session_id && getAgent(agent.id)?.sessionId !== m.session_id) {
    updateAgent(agent.id, { sessionId: m.session_id });
  }
  if ('parent_tool_use_id' in m && m.parent_tool_use_id) return; // subagent internals

  switch (m.type) {
    case 'stream_event': {
      const e = m.event;
      if (e.type === 'content_block_start') {
        if (e.content_block.type === 'tool_use') setStatus(agent.id, 'working', e.content_block.name.replace('mcp__office__', ''));
        else if (e.content_block.type === 'thinking') setStatus(agent.id, 'thinking');
        else if (e.content_block.type === 'text') setStatus(agent.id, 'working', 'typing');
      } else if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') {
        broadcast({ type: 'delta', agentId: agent.id, text: e.delta.text });
      }
      break;
    }
    case 'assistant': {
      for (const b of m.message.content) {
        if (b.type === 'text' && b.text.trim()) {
          texts.push(b.text);
          chat(agent.id, 'agent', b.text);
        } else if (b.type === 'tool_use') {
          const input = (b.input ?? {}) as Record<string, unknown>;
          const name = b.name.replace('mcp__office__', '');
          let line = `${name}: ${summarize(b.name, input)}`;
          if (name === 'assign_task') line = `→ ${input.agent_name}: ${String(input.task).slice(0, 300)}`;
          if (name === 'propose_agent') line = `proposes hiring ${input.name} (${input.role})`;
          if (name === 'list_team') line = 'checks the team';
          chat(agent.id, 'tool', line);
        }
      }
      break;
    }
    case 'result': {
      const a = updateAgent(agent.id, { costUsd: m.total_cost_usd ?? 0 });
      if (a) broadcast({ type: 'agent', agent: a });
      if (m.subtype !== 'success') chat(agent.id, 'system', `Turn ended: ${m.subtype}`);
      break;
    }
  }
}
