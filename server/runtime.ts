import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { resolve, sep } from 'node:path';
import {
  MODELS, PROJECTS_DIR, addAgent, addChat, findAgentByName, getAgent, getTeam, orchestratorOf, statuses, teamMembers, updateAgent,
} from './store.ts';
import { addTask, addVision, rewriteTeamText, tasks, tasksOf, touchVision, updateTask, visionsOf } from './store.ts';
import type { Agent, ChatMsg, MilestoneStatus, ModelKey, Status, Task, Vision, VisionStatus } from './store.ts';
import { dropEdit, recordEdit } from './changes.ts';
import { noteRateLimit } from './usage.ts';
import { checkName, deleteKey, envFileText, exportJson, isSensitive, listKeys, readValue, setValue, vaultVersion } from './vault.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { realPath } from './paths.ts';
import { requestApproval } from './approvals.ts';
import { catalog, projectInstructions, projectSkills, resolveSkills } from './skills.ts';

export type ServerEvent =
  | { type: 'agent'; agent: Agent }
  | { type: 'status'; agentId: string; status: Status; detail: string }
  | { type: 'delta'; agentId: string; text: string }
  | { type: 'message'; msg: ChatMsg }
  | { type: 'peer'; fromId: string; toId: string; mode: 'message' | 'ask' | 'assign'; text: string }
  | { type: 'task'; task: Task }
  | { type: 'vision'; vision: Vision }
  | { type: 'vision_removed'; visionId: string; teamId: string }
  | { type: 'change'; agentId: string }
  | { type: 'vault_changed'; teamId: string };

// Who a turn's message came from. Teammate messages carry a hop count so chains can't loop forever.
export type Origin =
  | { kind: 'user' }
  | { kind: 'board'; taskId: string }
  | { kind: 'report'; fromId: string; taskId: string }
  | { kind: 'boss' }
  | { kind: 'peer'; fromId: string; depth: number; mode: 'message' | 'ask' };

const MAX_PEER_DEPTH = 3;
const PEER_LIMIT_PER_HOUR = 20;

let broadcast: (e: ServerEvent) => void = () => {};
export function onRuntimeEvent(fn: typeof broadcast) {
  broadcast = fn;
}

function setStatus(agentId: string, status: Status, detail = '') {
  statuses.set(agentId, { status, detail });
  broadcast({ type: 'status', agentId, status, detail });
}

function chat(agentId: string, from: ChatMsg['from'], text: string, extra?: Pick<ChatMsg, 'fromId' | 'mode'>) {
  const teamId = getAgent(agentId)?.teamId;
  broadcast({ type: 'message', msg: addChat(agentId, from, teamId ? redact(teamId, text) : text, extra) });
}

// ---------- keeping secrets out of logs ----------

// Values shorter than this are too likely to be ordinary words ("true", "3306").
const MIN_SECRET = 8;
const secretCache = new Map<string, { version: number; pairs: [string, string][] }>();

function secretsOf(teamId: string) {
  const hit = secretCache.get(teamId);
  if (hit && hit.version === vaultVersion()) return hit.pairs;
  let pairs: [string, string][] = [];
  try {
    for (const [env, keys] of Object.entries(exportJson(teamId))) {
      for (const [key, value] of Object.entries(keys)) if (value.length >= MIN_SECRET) pairs.push([value, `${env}:${key}`]);
    }
  } catch {
    pairs = []; // safe unreadable; nothing to hide
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  secretCache.set(teamId, { version: vaultVersion(), pairs });
  return pairs;
}

// After the safe changes, scrub its values from what's already stored for the team.
export function scrubHistory(teamId: string) {
  return rewriteTeamText(teamId, (t) => redact(teamId, t));
}

// Replace any value from the team's safe with a label, so it isn't stored or passed on.
export function redact(teamId: string, text: string) {
  let out = text;
  for (const [value, label] of secretsOf(teamId)) if (out.includes(value)) out = out.split(value).join(`[secret ${label}]`);
  return out;
}

// ---------- permissions ----------

const AUTO_ALLOW = new Set(['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'WebSearch', 'WebFetch', 'NotebookRead', 'Skill']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function inside(path: unknown, dir: string) {
  if (typeof path !== 'string') return false;
  const p = realPath(resolve(dir, path));
  const d = realPath(dir);
  return p === d || p.startsWith(d + sep);
}

function summarize(toolName: string, input: Record<string, unknown>) {
  const pick = input.skill ?? input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url ?? input.query;
  if (typeof pick === 'string') return pick.length > 400 ? pick.slice(0, 400) + '…' : pick;
  const json = JSON.stringify(input);
  return json.length > 400 ? json.slice(0, 400) + '…' : json;
}

function permissionsFor(agent: Agent): CanUseTool {
  return async (toolName, input, { signal, decisionReason }) => {
    const fresh = getAgent(agent.id) ?? agent;
    if (AUTO_ALLOW.has(toolName) || toolName.startsWith('mcp__office__') || toolName.startsWith('mcp__team__') || fresh.alwaysAllow.includes(toolName)) {
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

// Workers don't load project settings (agents can edit them), so the project's CLAUDE.md is passed in here.
function projectPrompt(cwd: string) {
  const text = projectInstructions(cwd);
  if (!text) return '';
  return `

# Project instructions (from the project's CLAUDE.md)

${text}

Note from the office: the project's MCP servers (such as Laravel Boost's search-docs, database-query and tinker tools) aren't connected here. Where these instructions mention them, use the project's skills, the installed package source in vendor/ and node_modules/, and approved shell commands instead.`;
}

function workerPrompt(a: Agent) {
  const boss = orchestratorOf(a.teamId);
  const team = getTeam(a.teamId);
  return `You are ${a.name}, a ${a.role} on ${team?.name ?? 'a team'} in a virtual office of AI agents. ${a.personality}
You were hired by ${boss.name}, the team's orchestrator, who will hand you tasks. The human owner of the office may also talk to you directly.
Your project folder is ${a.cwd}. Do all your work inside it. You can read other teammates' project folders in ${PROJECTS_DIR}, but only edit your own.

Working with teammates:
- Use list_team to see who's here and what they do.
- When you finish something a teammate's expertise should check, send it for review with message_teammate (kind "review_request"). For example, a page you built goes to the designer, and auth or payment code goes to the security reviewer. Say exactly what to look at (file paths) and what kind of feedback you want.
- When you review someone's work, send specific, actionable feedback with message_teammate: what to change, where, and why.
- Use ask_teammate only when you need an answer before you can continue.
- When feedback arrives, apply what makes sense. If you disagree, say why. Tell the reviewer when it's ready for a re-check only if the change was significant.
- Don't send thanks, greetings or acknowledgements. Every message should move the work forward.

Secrets and environment variables:
- Your team has a safe with environment variables per environment (local, prod, …). Check it with vault_list.
- To give your code its variables, use vault_write_env to write a .env file; the values never pass through you. Make sure that file is in .gitignore.
- When you create or receive credentials or config, store them with vault_set instead of writing them into code, files you commit, chat or messages.
- Use vault_read only when there's no other way, and never repeat a secret value anywhere.

Speak like a friendly colleague, in first person. Keep chat replies short. When you finish a task, end with a brief summary of what you did and anything that still needs attention.`;
}

function orchestratorPrompt(a: Agent) {
  const team = getTeam(a.teamId);
  return `You are ${a.name}, the orchestrator of ${team?.name ?? 'a team'} in a virtual office of AI agents. ${a.personality}
You talk with the office owner (the user), understand what they want, and get it done through your team.
Your team's project is "${team?.project}" (folder ${PROJECTS_DIR}/${team?.project}). New hires work there unless the owner asks for a separate project. Other teams in the office have their own orchestrators and projects; you only manage your own team.

How you work:
- Use list_team to see who is on your team and what they are doing.
- When the team lacks a skill a task needs, call propose_agent to hire someone. Every hire needs the owner's approval, so explain briefly why in the reason field. Give each hire a real human first name that isn't already taken, a clear role, a short personality, and a model. Leave project empty to use the team's project.
- Keep usage low; the owner prefers a slower team to an expensive one. Choose models deliberately: "sonnet" by default for engineering, "haiku" for simple or repetitive work, and "opus" only for senior roles: architecture, security review and hard debugging. Never hire a "fable" worker unless the owner asks.
- Teammates can have skills: packaged expertise such as frontend design. Use list_skills to see what's available, give fitting skills when you hire (skills field), and use request_skills to add skills to someone already on the team. The owner approves both.
- Teammates can message each other directly, for example to request a design review or send feedback. You'll see it in their chats. You may also receive messages from them.
- The owner can add tasks to your team's board. You'll get each one as a message with its task id. Pick who delivers it and pass the task_id to assign_task so the card moves on the board.
- Your team has a safe for environment variables (vault_list shows the keys). Never put secret values in task descriptions; tell teammates which keys to use from the safe.
- Use assign_task to hand a teammate a concrete, self-contained task. They don't see this conversation, so include all context they need. It returns immediately, and their report arrives later as a message, so keep the team working in parallel: hand out independent tasks to different people at the same time.
- Before assigning, check list_team. Prefer a teammate who is free and whose role and skills fit. If the best fit is busy, give it to another free teammate who can do it well; queue it behind the busy one only when nobody else fits, or propose a hire if the team is stretched.
- When work depends on other work (build, then review), assign the next step when the report for the first arrives.
- When the owner describes a new feature or goal (a vision), call create_vision before planning the work, with milestones that each end in something checkable. The owner watches its progress bar on your team's wall. Pass vision_id and the milestone number with assign_task. Mark a milestone done with update_vision only once the reports show it's finished and reviewed, and add milestones when the scope grows. Use list_visions to see where each vision stands.
- Don't hire more people than the work needs. Reuse existing teammates when they fit.
- You can read files in the projects folder (${PROJECTS_DIR}) to check work, but you don't edit files yourself.
Keep replies to the owner short and conversational. Tell them what you're doing and what came back.`;
}

// ---------- task board ----------

// A short card title: the given title, or the first line of the text.
export function cardTitle(title: string | undefined, text: string) {
  const t = (title?.trim() || text.trim().split('\n')[0]).replace(/\s+/g, ' ');
  return t.length > 90 ? t.slice(0, 89) + '…' : t;
}

export function createTask(t: Parameters<typeof addTask>[0]) {
  const task = addTask({ ...t, title: redact(t.teamId, t.title), detail: redact(t.teamId, t.detail) });
  broadcast({ type: 'task', task });
  return task;
}

function moveTask(id: string, patch: Parameters<typeof updateTask>[1]) {
  const teamId = tasks().find((t) => t.id === id)?.teamId;
  if (teamId && patch.result) patch = { ...patch, result: redact(teamId, patch.result) };
  const task = updateTask(id, patch);
  if (task) broadcast({ type: 'task', task });
}

// ---------- visions ----------

function findVision(teamId: string, id: string) {
  return visionsOf(teamId).find((v) => v.id === id.trim());
}

function visionText(v: Vision) {
  const done = v.milestones.filter((m) => m.status === 'done').length;
  const lines = v.milestones.map((m, i) => `  ${i + 1}. [${MILESTONE_WORDS[m.status]}] ${m.title}`);
  return `- ${v.title} (id ${v.id}; ${v.status}; ${done} of ${v.milestones.length} milestones done)\n  ${v.summary}\n${lines.join('\n')}`;
}

const MILESTONE_WORDS: Record<MilestoneStatus, string> = { todo: 'to do', doing: 'in progress', done: 'done' };

function saveVision(v: Vision) {
  // A vision whose milestones are all done is finished; adding a milestone reopens it.
  const allDone = v.milestones.length > 0 && v.milestones.every((m) => m.status === 'done');
  if (v.status === 'active' && allDone) v.status = 'done';
  else if (v.status === 'done' && !allDone) v.status = 'active';
  broadcast({ type: 'vision', vision: touchVision(v) });
}

const STATUS_WORDS: Record<string, string> = { todo: 'to do', doing: 'in progress', review: 'in review', done: 'done', blocked: 'stopped' };

function boardText(teamId: string) {
  const all = tasksOf(teamId);
  const list = all.filter((t) => !t.parentId && (t.status !== 'done' || Date.now() - t.updatedAt < 86_400_000));
  if (!list.length) return 'The board is empty.';
  return list
    .map((t) => {
      const parts = all.filter((p) => p.parentId === t.id);
      const who = parts.length
        ? parts.map((p) => `${getAgent(p.assigneeId)?.name ?? '?'} ${STATUS_WORDS[p.status]}`).join(', ')
        : t.createdBy === 'owner' && t.status === 'todo'
          ? 'not assigned yet'
          : getAgent(t.assigneeId)?.name ?? 'someone who left';
      return `- [${STATUS_WORDS[t.status]}] ${t.title} (id ${t.id}; ${who})`;
    })
    .join('\n');
}

// A board card that was split between teammates is finished once every part is.
function settleParents(teamId: string) {
  const all = tasksOf(teamId);
  for (const parent of all.filter((t) => !t.parentId && t.status === 'doing')) {
    const parts = all.filter((p) => p.parentId === parent.id);
    if (!parts.length || parts.some((p) => p.status === 'todo' || p.status === 'doing' || p.status === 'review')) continue;
    const names = [...new Set(parts.map((p) => getAgent(p.assigneeId)?.name ?? 'someone'))];
    const stopped = parts.filter((p) => p.status === 'blocked');
    if (stopped.length) {
      moveTask(parent.id, { status: 'blocked', result: stopped.map((p) => `${p.title}: ${p.result ?? 'stopped'}`).join('\n') });
    } else {
      const last = parts.at(-1)?.result ?? '';
      moveTask(parent.id, { status: 'done', result: `Delivered by ${names.join(' and ')}.${last ? `\n${last}` : ''}` });
    }
  }
}

// The owner put a task on the board: hand it to the team's orchestrator to triage.
export function triageTask(task: Task) {
  const boss = orchestratorOf(task.teamId);
  if (!boss) return;
  const text = task.detail && task.detail !== task.title ? `${task.title}\n\n${task.detail}` : task.title;
  send(boss.id, text, { kind: 'board', taskId: task.id }).catch(() => {});
}

// ---------- orchestrator tools ----------

function officeServer(boss: Agent) {
  const teamId = boss.teamId;
  // Finds a worker on this orchestrator's team by name.
  const member = (name: string) => {
    const a = findAgentByName(name);
    return a && a.teamId === teamId && !a.isOrchestrator ? a : undefined;
  };
  return createSdkMcpServer({
    name: 'office',
    version: '1.0.0',
    alwaysLoad: true,
    tools: [
      tool('list_team', 'List everyone on your team with their role, project, skills and current status.', {}, async () => ({
        content: [{ type: 'text', text: teamLines(boss.id, teamId) }],
      })),
      tool('vault_list', "List the keys in your team's safe (names only). Teammates read and write it themselves.", {}, async () => ({
        content: [{ type: 'text', text: safeListText(teamId) }],
      })),
      tool('list_tasks', "See your team's task board: what's to do, in progress, in review and recently done.", {}, async () => ({
        content: [{ type: 'text', text: boardText(teamId) }],
      })),
      tool('list_skills', 'List the skills teammates can be given, with what each one is for.', {}, async () => {
        const cat = catalog();
        const text = cat.length ? cat.map((s) => `- ${s.id}: ${s.description}`).join('\n') : 'No skills are installed.';
        return { content: [{ type: 'text', text }] };
      }),
      tool(
        'request_skills',
        'Ask the owner to give an existing teammate more skills. Blocks until they approve or reject.',
        {
          agent_name: z.string(),
          skills: z.array(z.string()).describe('Skill ids from list_skills'),
          reason: z.string().describe('Why they need these skills, shown to the owner'),
        },
        async ({ agent_name, skills, reason }) => {
          const a = member(agent_name);
          if (!a) {
            return { content: [{ type: 'text', text: `No one named ${agent_name} on your team. Use list_team.` }], isError: true };
          }
          const { ids, unknown } = resolveSkills(skills);
          if (unknown.length) {
            return { content: [{ type: 'text', text: `Unknown skills: ${unknown.join(', ')}. Use list_skills.` }], isError: true };
          }
          const added = ids.filter((id) => !a.skills.includes(id));
          if (!added.length) return { content: [{ type: 'text', text: `${a.name} already has those skills.` }] };
          setStatus(boss.id, 'waiting', `wants skills for ${a.name}`);
          const d = await requestApproval({
            kind: 'skills',
            agentId: boss.id,
            title: `${boss.name} wants to give ${a.name} new skills`,
            detail: reason,
            data: { name: a.name, skills: added },
          });
          setStatus(boss.id, 'thinking');
          if (!d.approved) {
            return { content: [{ type: 'text', text: `The owner said no.${d.note ? ` Their note: ${d.note}` : ''}` }] };
          }
          const updated = updateAgent(a.id, { skills: [...a.skills, ...added] });
          if (updated) broadcast({ type: 'agent', agent: updated });
          chat(a.id, 'system', `${a.name} learned: ${added.join(', ')}.`);
          return { content: [{ type: 'text', text: `Approved. ${a.name} now has: ${updated?.skills.join(', ')}.` }] };
        },
      ),
      tool(
        'create_vision',
        "Start tracking a feature or goal the owner described (a vision) with a progress bar on the team's wall. Break it into milestones that each end in something checkable. Returns the vision's id.",
        {
          title: z.string().describe('Short name, e.g. "Website builder", under 40 characters'),
          summary: z.string().describe("One or two sentences on what the owner wants and why"),
          milestones: z.array(z.string()).min(2).max(12).describe('In order; each a short outcome, e.g. "Templates can be picked and previewed"'),
        },
        async ({ title, summary, milestones }) => {
          const r = (t: string) => redact(teamId, t.trim());
          const v = addVision({ teamId, title: r(title).slice(0, 60), summary: r(summary), milestones: milestones.map(r).filter(Boolean) });
          broadcast({ type: 'vision', vision: v });
          return { content: [{ type: 'text', text: `Created. Pass vision_id "${v.id}" and a milestone number with assign_task.\n${visionText(v)}` }] };
        },
      ),
      tool(
        'update_vision',
        "Update a vision's progress: mark milestones in progress or done, add milestones when the scope grows, or mark the whole vision done or dropped. Mark a milestone done only when the reports show it's finished and reviewed.",
        {
          vision_id: z.string(),
          milestones: z
            .array(z.object({ number: z.number().int().min(1), status: z.enum(['todo', 'doing', 'done']) }))
            .optional()
            .describe('Milestone numbers as shown by list_visions, starting at 1'),
          add_milestones: z.array(z.string()).optional().describe('New milestones, added at the end'),
          status: z.enum(['active', 'done', 'dropped']).optional().describe('Only to finish or drop the whole vision'),
        },
        async ({ vision_id, milestones, add_milestones, status }) => {
          const v = findVision(teamId, vision_id);
          if (!v) return { content: [{ type: 'text', text: `No vision ${vision_id}. Use list_visions.` }], isError: true };
          const bad = (milestones ?? []).filter((m) => m.number > v.milestones.length).map((m) => m.number);
          if (bad.length) {
            return { content: [{ type: 'text', text: `There's no milestone ${bad.join(', ')}; this vision has ${v.milestones.length}.` }], isError: true };
          }
          for (const m of milestones ?? []) v.milestones[m.number - 1].status = m.status;
          for (const t of add_milestones ?? []) if (t.trim()) v.milestones.push({ title: redact(teamId, t.trim()), status: 'todo' });
          if (status) v.status = status as VisionStatus;
          saveVision(v);
          return { content: [{ type: 'text', text: `Updated.\n${visionText(v)}` }] };
        },
      ),
      tool('list_visions', "See the team's visions and how far each one is.", {}, async () => {
        const list = visionsOf(teamId).filter((v) => v.status !== 'dropped');
        return { content: [{ type: 'text', text: list.length ? list.map(visionText).join('\n\n') : 'No visions yet.' }] };
      }),
      tool(
        'propose_agent',
        'Propose hiring a new agent. Blocks until the office owner approves or rejects, then returns the decision.',
        {
          name: z.string().describe('A real human first name, unique in the office'),
          role: z.string().describe('Job title, e.g. "Frontend Developer"'),
          personality: z.string().describe('One or two sentences on how they work and talk'),
          model: z.enum(['haiku', 'sonnet', 'opus', 'fable']),
          project: z.string().optional().describe("Leave empty to use the team's project"),
          skills: z.array(z.string()).optional().describe('Skill ids from list_skills that fit the role'),
          reason: z.string().describe('Why the team needs this person, shown to the owner'),
        },
        async (args) => {
          if (findAgentByName(args.name)) {
            return { content: [{ type: 'text', text: `Someone named ${args.name} already works in the office. Pick another name.` }], isError: true };
          }
          const { ids: skillIds, unknown } = resolveSkills(args.skills ?? []);
          if (unknown.length) {
            return { content: [{ type: 'text', text: `Unknown skills: ${unknown.join(', ')}. Use list_skills.` }], isError: true };
          }
          const project = args.project?.trim() || getTeam(teamId)?.project || null;
          setStatus(boss.id, 'waiting', `wants to hire ${args.name}`);
          const d = await requestApproval({
            kind: 'hire',
            agentId: boss.id,
            title: `${boss.name} wants to hire ${args.name}`,
            detail: args.reason,
            data: { ...args, project, skills: skillIds, team: getTeam(teamId)?.name },
          });
          setStatus(boss.id, 'thinking');
          if (!d.approved) {
            chat(boss.id, 'system', `You declined hiring ${args.name}${d.note ? `: ${d.note}` : ''}.`);
            return { content: [{ type: 'text', text: `The owner rejected hiring ${args.name}.${d.note ? ` Their note: ${d.note}` : ''}` }] };
          }
          const agent = addAgent({ ...args, teamId, project, skills: skillIds, model: args.model as ModelKey, isOrchestrator: false });
          setStatus(agent.id, 'idle');
          broadcast({ type: 'agent', agent });
          chat(boss.id, 'system', `${agent.name} joined the team as ${agent.role}.`);
          return {
            content: [{ type: 'text', text: `Approved. ${agent.name} is hired and works in ${agent.cwd}.${d.note ? ` Owner's note: ${d.note}` : ''}` }],
          };
        },
      ),
      tool(
        'assign_task',
        "Give a teammate a task. Returns right away so you can hand out more work; their report arrives later as a message. If they're busy, the task waits in their queue. Include all context; they can't see your conversation.",
        {
          agent_name: z.string(),
          wait: z
            .boolean()
            .optional()
            .describe('Wait here for their report instead. Only for quick answers you need before you can continue.'),
          title: z.string().optional().describe('Short card title for the task board, under 60 characters'),
          task_id: z.string().optional().describe("The board task's id, when this assignment delivers (part of) a task from the board"),
          vision_id: z.string().optional().describe('The vision this work moves forward'),
          milestone: z.number().int().min(1).optional().describe("The vision's milestone number this work is for"),
          task: z.string(),
        },
        async ({ agent_name, title, task_id, vision_id, milestone, task, wait }) => {
          const a = member(agent_name);
          if (!a) {
            return { content: [{ type: 'text', text: `No one named ${agent_name} on your team. Use list_team.` }], isError: true };
          }
          const vision = vision_id ? findVision(teamId, vision_id) : undefined;
          if (vision_id && !vision) return { content: [{ type: 'text', text: `No vision ${vision_id}. Use list_visions.` }], isError: true };
          if (vision && milestone && milestone > vision.milestones.length) {
            return { content: [{ type: 'text', text: `There's no milestone ${milestone}; this vision has ${vision.milestones.length}.` }], isError: true };
          }
          // Work starting on a milestone shows it as in progress on the wall.
          if (vision && milestone && vision.milestones[milestone - 1].status === 'todo') {
            vision.milestones[milestone - 1].status = 'doing';
            saveVision(vision);
          }
          let parentId: string | undefined;
          if (task_id) {
            const parent = tasksOf(teamId).find((t) => t.id === task_id && !t.parentId);
            if (!parent) return { content: [{ type: 'text', text: `There's no task ${task_id} on your board. Use list_tasks.` }], isError: true };
            parentId = parent.id;
            if (parent.status !== 'doing') moveTask(parent.id, { status: 'doing', result: '' });
          }
          broadcast({ type: 'peer', fromId: boss.id, toId: a.id, mode: 'assign', text: redact(teamId, task) });
          const card = createTask({
            teamId, kind: 'task', title: cardTitle(title, task), detail: task, assigneeId: a.id, createdBy: boss.id, parentId,
          });
          const ahead = queuedFor(a.id);
          const run = send(a.id, task, { kind: 'boss' }, card);
          if (wait) {
            const report = await run;
            return { content: [{ type: 'text', text: `${a.name}'s report:\n${report || '(no text reply)'}` }] };
          }
          // Hand the report back to the orchestrator as its own message once the work is done.
          run
            .then((report) => {
              const final = tasksOf(teamId).find((t) => t.id === card.id);
              const outcome = final?.status === 'blocked' ? `stopped (${final.result ?? 'no reason given'})` : 'finished';
              const parent = parentId ? tasksOf(teamId).find((t) => t.id === parentId) : undefined;
              const header = `${a.name} ${outcome} "${card.title}"${parent ? `, part of board task "${parent.title}" (id ${parent.id})` : ''}.`;
              send(boss.id, `${header}\n\n${report || '(no text reply)'}`, { kind: 'report', fromId: a.id, taskId: card.id }).catch(() => {});
            })
            .catch(() => {});
          const where = ahead
            ? `${a.name} is busy, so this waits in their queue behind ${ahead} other ${ahead === 1 ? 'task' : 'tasks'}.`
            : `${a.name} has started.`;
          return { content: [{ type: 'text', text: `${where} Their report will arrive as a message. Hand out other work in the meantime.` }] };
        },
      ),
    ],
  });
}

function teamLines(selfId: string, teamId: string) {
  return teamMembers(teamId)
    .map((a) => {
      const sk = a.skills.length ? a.skills.join(', ') : 'none';
      const where = a.isOrchestrator ? 'orchestrator' : `project ${a.project ?? '-'}`;
      const n = pendingTurns.get(a.id) ?? 0;
      const availability = n === 0 ? 'free' : n === 1 ? 'busy' : `busy, ${n - 1} more queued`;
      return `- ${a.name}${a.id === selfId ? ' (you)' : ''}: ${a.role} | ${where} | skills ${sk} | ${availability}`;
    })
    .join('\n');
}

// ---------- the team's safe ----------

function safeListText(teamId: string) {
  const envs = listKeys(teamId);
  return Object.entries(envs)
    .map(([env, keys]) => `${env}: ${keys.length ? keys.map((k) => k.key).join(', ') : '(empty)'}`)
    .join('\n');
}

// Ask the owner, unless they said "always" for this agent and action before.
async function ownerOK(agent: Agent, always: string, label: string, title: string, detail: string) {
  const fresh = getAgent(agent.id) ?? agent;
  if (fresh.alwaysAllow.includes(always)) return { ok: true };
  const prev = statuses.get(agent.id);
  setStatus(agent.id, 'waiting', 'needs your OK for the safe');
  const d = await requestApproval({ kind: 'vault', agentId: agent.id, toolName: label, title, detail });
  setStatus(agent.id, prev?.status === 'waiting' ? 'working' : prev?.status ?? 'working', prev?.detail ?? '');
  if (d.approved && d.always) updateAgent(agent.id, { alwaysAllow: [...fresh.alwaysAllow, always] });
  return { ok: d.approved, note: d.note };
}

function safeTools(self: Agent) {
  const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], isError });
  const changed = () => {
    scrubHistory(self.teamId);
    broadcast({ type: 'vault_changed', teamId: self.teamId });
  };
  const env = z.string().describe('Environment, e.g. "local" or "prod"');
  return [
    tool('vault_list', "List the keys in your team's safe for each environment (names only, no values).", {}, async () =>
      text(safeListText(self.teamId)),
    ),
    tool(
      'vault_set',
      "Save or update an environment variable in the team's safe. Use it for credentials and config you create or receive, instead of writing them into files or messages. Non-local environments need the owner's OK.",
      { env, key: z.string().describe('Like STRIPE_SECRET_KEY'), value: z.string() },
      async ({ env, key, value }) => {
        const err = checkName(env, key);
        if (err) return text(err, true);
        if (isSensitive(env)) {
          const ok = await ownerOK(
            self, `vault_set:${env}`, `${env} safe changes`,
            `${self.name} wants to ${readValue(self.teamId, env, key) === undefined ? 'add' : 'change'} ${key} in the ${env} safe`,
            `The new value is ${value.length} characters long (hidden here).`,
          );
          if (!ok.ok) return text(`The owner said no.${ok.note ? ` Their note: ${ok.note}` : ''}`);
        }
        try {
          setValue(self.teamId, env, key, value, self.name);
        } catch (e) {
          return text(e instanceof Error ? e.message : String(e), true);
        }
        changed();
        return text(`Saved ${key} in the ${env} safe.`);
      },
    ),
    tool(
      'vault_write_env',
      "Write an environment's variables from the safe into a .env file in your project. The values go straight to the file without passing through you, so prefer this over vault_read. Non-local environments need the owner's OK.",
      { env, path: z.string().optional().describe('File path inside your project, default ".env"') },
      async ({ env, path }) => {
        const err = checkName(env);
        if (err) return text(err, true);
        const target = resolve(self.cwd, path || '.env');
        if (!inside(target, self.cwd)) return text('The file has to be inside your project folder.', true);
        const { text: body, count } = envFileText(self.teamId, env);
        if (!count) return text(`The ${env} safe is empty.`, true);
        if (isSensitive(env)) {
          const ok = await ownerOK(
            self, `vault_env:${env}`, `${env} env files`,
            `${self.name} wants to write the ${env} secrets to a file`,
            `${count} variables into ${target}`,
          );
          if (!ok.ok) return text(`The owner said no.${ok.note ? ` Their note: ${ok.note}` : ''}`);
        }
        writeFileSync(target, body, { mode: 0o600 });
        const ignore = resolve(self.cwd, '.gitignore');
        const ignored = existsSync(ignore) && readFileSync(ignore, 'utf8').split('\n').some((l) => l.trim() === basename(target) || l.trim() === '.env*' || l.trim() === '*.env');
        return text(
          `Wrote ${count} variables to ${target}.${ignored ? '' : ` It isn't in .gitignore yet: add "${basename(target)}" there so the secrets are never committed.`}`,
        );
      },
    ),
    tool(
      'vault_read',
      "Read one value from the safe into this conversation. Needs the owner's OK. Only use it when you can't use vault_write_env, and never repeat the value in chat, messages or committed files.",
      { env, key: z.string() },
      async ({ env, key }) => {
        const value = readValue(self.teamId, env, key);
        if (value === undefined) return text(`There's no ${key} in the ${env} safe. Use vault_list.`, true);
        const ok = await ownerOK(self, `vault_read:${env}`, `${env} safe reads`, `${self.name} wants to read ${key} from the ${env} safe`, 'The value will be shown to the agent.');
        if (!ok.ok) return text(`The owner said no.${ok.note ? ` Their note: ${ok.note}` : ''}`);
        return text(value);
      },
    ),
    tool(
      'vault_delete',
      "Remove a key from the team's safe. Non-local environments need the owner's OK.",
      { env, key: z.string() },
      async ({ env, key }) => {
        if (readValue(self.teamId, env, key) === undefined) return text(`There's no ${key} in the ${env} safe.`, true);
        if (isSensitive(env)) {
          const ok = await ownerOK(self, `vault_delete:${env}`, `${env} safe deletions`, `${self.name} wants to delete ${key} from the ${env} safe`, '');
          if (!ok.ok) return text(`The owner said no.${ok.note ? ` Their note: ${ok.note}` : ''}`);
        }
        deleteKey(self.teamId, env, key);
        changed();
        return text(`Removed ${key} from the ${env} safe.`);
      },
    ),
  ];
}

// ---------- teammate messaging (workers) ----------

const sentLog = new Map<string, number[]>();

function checkPeer(from: Agent, toName: string, depth: number): Agent | string {
  const to = findAgentByName(toName);
  if (!to) return `No teammate named ${toName}. Use list_team.`;
  if (to.id === from.id) return "You can't message yourself.";
  if (to.teamId !== from.teamId) return `${to.name} is on another team. You can only message your own teammates.`;
  if (depth >= MAX_PEER_DEPTH) {
    return 'This back-and-forth has gone on long enough. Finish with what you have and summarise any open points in your reply.';
  }
  const hourAgo = Date.now() - 3_600_000;
  const recent = (sentLog.get(from.id) ?? []).filter((t) => t > hourAgo);
  if (recent.length >= PEER_LIMIT_PER_HOUR) return "You've sent a lot of messages this hour. Finish your work and report instead.";
  sentLog.set(from.id, [...recent, Date.now()]);
  return to;
}

function teamServer(self: Agent, depth: number) {
  const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], isError });
  return createSdkMcpServer({
    name: 'team',
    version: '1.0.0',
    alwaysLoad: true,
    tools: [
      ...safeTools(self),
      tool('list_team', 'See who works in the office: roles, projects, skills and whether they are busy.', {}, async () =>
        text(teamLines(self.id, self.teamId)),
      ),
      tool(
        'message_teammate',
        "Send a teammate a message without waiting: a review request, feedback on their work, or a handoff. They act on it when they're free; if they reply, it arrives as a new message.",
        {
          name: z.string().describe("The teammate's first name"),
          kind: z
            .enum(['review_request', 'feedback', 'info'])
            .optional()
            .describe('review_request puts a review card on the task board; use it when asking someone to check your work'),
          title: z.string().optional().describe('For review requests: short card title, e.g. "Review hero section"'),
          message: z.string().describe('Self-contained message. Include file paths and exactly what you want.'),
        },
        async ({ name, kind, title, message }) => {
          const to = checkPeer(self, name, depth);
          if (typeof to === 'string') return text(to, true);
          broadcast({ type: 'peer', fromId: self.id, toId: to.id, mode: 'message', text: redact(self.teamId, message) });
          const card =
            kind === 'review_request'
              ? createTask({
                  teamId: self.teamId, kind: 'review', title: cardTitle(title, message), detail: message,
                  assigneeId: to.id, createdBy: self.id,
                })
              : undefined;
          send(to.id, message, { kind: 'peer', fromId: self.id, depth: depth + 1, mode: 'message' }, card).catch(() => {});
          return text(`Sent to ${to.name}. Carry on with your work; any reply will come as a new message.`);
        },
      ),
      tool(
        'ask_teammate',
        'Ask a teammate a question and wait for the answer. Only use this when you cannot continue without it.',
        { name: z.string(), question: z.string() },
        async ({ name, question }) => {
          const to = checkPeer(self, name, depth);
          if (typeof to === 'string') return text(to, true);
          if (isBusy(to.id)) {
            // Waiting on a busy teammate could deadlock, so leave the question in their queue instead.
            broadcast({ type: 'peer', fromId: self.id, toId: to.id, mode: 'message', text: redact(self.teamId, question) });
            send(to.id, question, { kind: 'peer', fromId: self.id, depth: depth + 1, mode: 'message' }).catch(() => {});
            return text(`${to.name} is busy, so your question was left as a message. Continue without the answer if you can.`);
          }
          broadcast({ type: 'peer', fromId: self.id, toId: to.id, mode: 'ask', text: redact(self.teamId, question) });
          const answer = await send(to.id, question, { kind: 'peer', fromId: self.id, depth: depth + 1, mode: 'ask' });
          return text(`${to.name} answered:\n${answer || '(no answer)'}`);
        },
      ),
    ],
  });
}

function promptFor(text: string, origin: Origin) {
  if (origin.kind === 'board') {
    return `The owner added a task to your team's board (task id ${origin.taskId}):

${text}

Check list_team for who is free and fits, then call assign_task with task_id "${origin.taskId}" for each teammate who works on it. Others may already be busy with earlier tasks; work in parallel where you can. If several people are needed, give each a self-contained part. If nobody on the team fits, propose a hire first. If the task is unclear or can't be done, say what you need from the owner instead of guessing. Finish with a short note on who you gave it to.`;
  }
  if (origin.kind === 'report') {
    return `A report from your team:

${text}

If this needs a follow-up (a review, the next step, a fix), assign it now. If it completes what the owner asked for, tell them in a sentence or two. Otherwise reply in one short line.`;
  }
  if (origin.kind !== 'peer') return text;
  const s = getAgent(origin.fromId);
  const who = s ? `${s.name} (${s.role})` : 'A teammate';
  if (origin.mode === 'ask') {
    return `${who} asks you:\n\n${text}\n\nAnswer in your reply; it goes straight back to them. Keep it focused.`;
  }
  return `Message from ${who}:\n\n${text}\n\nThis is from a teammate, not the owner. Act on it if it's relevant to your work. Use message_teammate to reply only if they need something back from you.`;
}

// ---------- running turns ----------

const queues = new Map<string, Promise<unknown>>();
const controllers = new Map<string, AbortController>();
const pendingTurns = new Map<string, number>();

// True while the agent has a turn running or waiting in its queue.
export const isBusy = (agentId: string) => (pendingTurns.get(agentId) ?? 0) > 0;
// Turns already running or waiting for this agent.
const queuedFor = (agentId: string) => pendingTurns.get(agentId) ?? 0;

// How the agent's last turn ended, so its task card can be marked done or stopped.
const lastOutcome = new Map<string, { ok: boolean; reason?: string }>();

// Messages to one agent run one at a time, in order. A task card, if any, follows the turn.
export function send(agentId: string, text: string, origin: Origin, card?: Task): Promise<string> {
  // Agents pass work to each other as text; keep safe values out of it. The owner's own words go through as typed.
  const target = getAgent(agentId);
  if (target && origin.kind !== 'user') text = redact(target.teamId, text);
  pendingTurns.set(agentId, (pendingTurns.get(agentId) ?? 0) + 1);
  const prev = queues.get(agentId) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      if (card) moveTask(card.id, { status: card.kind === 'review' ? 'review' : 'doing' });
      const reply = await runTurn(agentId, text, origin);
      forgetting.delete(agentId);
      const who = getAgent(agentId);
      if (who?.isOrchestrator) settleParents(who.teamId);
      if (card) {
        const out = lastOutcome.get(agentId);
        const summary = reply.trim().split('\n').slice(-6).join('\n').slice(-400);
        moveTask(card.id, out?.ok === false ? { status: 'blocked', result: out.reason } : { status: 'done', result: summary });
        const boss = card.parentId ? orchestratorOf(card.teamId) : undefined;
        if (boss && !controllers.has(boss.id)) settleParents(card.teamId);
      }
      return reply;
    })
    .finally(() => pendingTurns.set(agentId, (pendingTurns.get(agentId) ?? 1) - 1));
  queues.set(agentId, next);
  return next;
}

export function stop(agentId: string) {
  controllers.get(agentId)?.abort();
}

// Agents mid-turn when their memory was cleared; their running turn mustn't save its session back.
const forgetting = new Set<string>();

// Like /clear for every agent on the team: their next turn starts a fresh conversation, and their usage counts from $0.
export function resetTeamMemory(teamId: string) {
  for (const a of teamMembers(teamId)) {
    if (controllers.has(a.id)) forgetting.add(a.id);
    const fresh = updateAgent(a.id, { sessionId: null, costUsd: 0 });
    if (fresh) broadcast({ type: 'agent', agent: fresh });
    chat(a.id, 'system', 'Memory cleared and usage reset to $0. The next task starts a fresh conversation.');
  }
}

function childEnv() {
  // Leave out any API key so Claude Code uses the logged-in (Max) account.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.ANTHROPIC_API_KEY;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'agent-office/0.1.0';
  return env;
}

async function runTurn(agentId: string, text: string, origin: Origin, retried = false): Promise<string> {
  const agent = getAgent(agentId);
  if (!agent) return '';
  if (!retried) {
    if (origin.kind === 'peer') chat(agentId, 'peer', text, { fromId: origin.fromId, mode: origin.mode });
    else if (origin.kind === 'board') chat(agentId, 'board', text);
    else if (origin.kind === 'report') chat(agentId, 'report', text, { fromId: origin.fromId });
    else chat(agentId, origin.kind, text);
  }
  const depth = origin.kind === 'peer' ? origin.depth : 0;
  updateAgent(agentId, { busy: true });
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
    options.mcpServers = { office: officeServer(agent) };
    options.allowedTools = [
      'list_team', 'list_tasks', 'vault_list', 'list_skills', 'propose_agent', 'request_skills', 'assign_task',
      'create_vision', 'update_vision', 'list_visions',
    ].map(
      (t) => `mcp__office__${t}`,
    );
    options.skills = [];
  } else {
    options.systemPrompt = { type: 'preset', preset: 'claude_code', append: workerPrompt(agent) + projectPrompt(agent.cwd) };
    options.additionalDirectories = [PROJECTS_DIR];
    options.mcpServers = { team: teamServer(agent, depth) };
    options.allowedTools = [
      'list_team', 'message_teammate', 'ask_teammate', 'vault_list', 'vault_set', 'vault_write_env', 'vault_read', 'vault_delete',
    ].map((t) => `mcp__team__${t}`);
    // Load only the plugins that hold this agent's skills, and enable only those skills.
    const mine = catalog().filter((s) => agent.skills.includes(s.id));
    options.plugins = [...new Set(mine.map((s) => s.pluginPath))].map((path) => ({ type: 'local' as const, path }));
    options.skills = mine.map((s) => s.id);
    // Plus the project's own skills, which every worker on the project gets.
    const fromProject = projectSkills(agent.id, agent.cwd);
    if (fromProject) {
      options.plugins.push({ type: 'local', path: fromProject.pluginPath });
      options.skills.push(...fromProject.ids);
    }
  }
  // Record the effort the turn actually ran at (after any downgrade for the model) so the office can show it.
  options.hooks = {
    Stop: [{
      hooks: [async (input) => {
        const effort = input.effort?.level ?? null;
        if (getAgent(agentId)?.effort !== effort) {
          const updated = updateAgent(agentId, { effort });
          if (updated) broadcast({ type: 'agent', agent: updated });
        }
        return {};
      }],
    }],
  };

  const texts: string[] = [];
  try {
    for await (const m of query({ prompt: promptFor(text, origin), options }) as AsyncIterable<SDKMessage>) {
      handle(agent, m, texts);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (abort.signal.aborted) {
      chat(agentId, 'system', 'Stopped.');
      lastOutcome.set(agentId, { ok: false, reason: 'Stopped by the owner.' });
      setStatus(agentId, 'idle');
      return texts.join('\n\n');
    } else if (agent.sessionId && !retried) {
      // The saved session may be gone; start a fresh one.
      updateAgent(agentId, { sessionId: null });
      return runTurn(agentId, text, origin, true);
    } else {
      chat(agentId, 'system', `Error: ${msg}`);
      setStatus(agentId, 'error', msg);
      lastOutcome.set(agentId, { ok: false, reason: msg });
      return texts.join('\n\n');
    }
  } finally {
    controllers.delete(agentId);
    updateAgent(agentId, { busy: false });
  }
  setStatus(agentId, 'idle');
  lastOutcome.set(agentId, { ok: true });
  return texts.join('\n\n');
}

function handle(agent: Agent, m: SDKMessage, texts: string[]) {
  if ('session_id' in m && m.session_id && !forgetting.has(agent.id) && getAgent(agent.id)?.sessionId !== m.session_id) {
    updateAgent(agent.id, { sessionId: m.session_id });
  }
  if ('parent_tool_use_id' in m && m.parent_tool_use_id) return; // subagent internals

  switch (m.type) {
    case 'stream_event': {
      const e = m.event;
      if (e.type === 'content_block_start') {
        if (e.content_block.type === 'tool_use') setStatus(agent.id, 'working', e.content_block.name.replace(/^mcp__(office|team)__/, ''));
        else if (e.content_block.type === 'thinking') setStatus(agent.id, 'thinking');
        else if (e.content_block.type === 'text') setStatus(agent.id, 'working', 'typing');
      } else if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') {
        broadcast({ type: 'delta', agentId: agent.id, text: redact(agent.teamId, e.delta.text) });
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
          if (EDIT_TOOLS.has(b.name) && recordEdit(agent, b.id, b.name, input).length) {
            broadcast({ type: 'change', agentId: agent.id });
          }
          const name = b.name.replace(/^mcp__(office|team)__/, '');
          let line = `${name}: ${summarize(b.name, input)}`;
          if (name === 'assign_task') line = `→ ${input.agent_name}: ${String(input.task).slice(0, 300)}`;
          if (name === 'propose_agent') line = `proposes hiring ${input.name} (${input.role})`;
          if (name === 'list_team') line = 'checks the team';
          if (name === 'message_teammate') line = `→ ${input.name}: ${String(input.message).slice(0, 300)}`;
          if (name === 'ask_teammate') line = `asks ${input.name}: ${String(input.question).slice(0, 300)}`;
          // Never put secret values in the chat log.
          if (name === 'vault_list') line = 'checks the safe';
          if (name === 'vault_set') line = `saves ${input.key} in the ${input.env} safe`;
          if (name === 'vault_read') line = `asks to read ${input.key} from the ${input.env} safe`;
          if (name === 'vault_write_env') line = `writes the ${input.env} safe to ${input.path || '.env'}`;
          if (name === 'vault_delete') line = `removes ${input.key} from the ${input.env} safe`;
          chat(agent.id, 'tool', line);
        }
      }
      break;
    }
    case 'rate_limit_event':
      noteRateLimit(m.rate_limit_info);
      break;
    case 'user': {
      // A denied or failed edit never happened; take it off the change list.
      const content = m.message.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'tool_result' && b.is_error && dropEdit(b.tool_use_id)) broadcast({ type: 'change', agentId: agent.id });
        }
      }
      break;
    }
    case 'result': {
      // A turn that was running when the team was reset belongs to the old count.
      const a = forgetting.has(agent.id) ? getAgent(agent.id) : updateAgent(agent.id, { costUsd: m.total_cost_usd ?? 0 });
      if (a) broadcast({ type: 'agent', agent: a });
      if (m.subtype !== 'success') chat(agent.id, 'system', `Turn ended: ${m.subtype}`);
      break;
    }
  }
}
