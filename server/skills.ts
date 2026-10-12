import { cpSync, lstatSync, readFileSync, readdirSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DATA_DIR, ROOT } from './store.ts';

export type SkillInfo = {
  id: string; // "plugin:skill", the name the Agent SDK expects
  name: string;
  description: string;
  plugin: string;
  pluginPath: string;
};

// Drop a skill folder (containing SKILL.md) in here to give it to the office.
export const OFFICE_SKILLS = join(ROOT, 'skills');
const INSTALLED = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');

export function ensureOfficePlugin() {
  mkdirSync(join(OFFICE_SKILLS, '.claude-plugin'), { recursive: true });
  mkdirSync(join(OFFICE_SKILLS, 'skills'), { recursive: true });
  const manifest = join(OFFICE_SKILLS, '.claude-plugin', 'plugin.json');
  if (!existsSync(manifest)) {
    writeFileSync(manifest, JSON.stringify({ name: 'office', description: 'Skills shared by the Agent Office team' }, null, 2));
  }
}

function frontmatter(md: string) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2];
    // Folded or literal blocks ("description: >") continue on the indented lines below.
    if (/^[>|][-+]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(' ');
    }
    out[kv[1]] = value.replace(/^["']|["']$/g, '');
  }
  return out;
}

function pluginName(path: string, fallback: string) {
  try {
    return JSON.parse(readFileSync(join(path, '.claude-plugin', 'plugin.json'), 'utf8')).name ?? fallback;
  } catch {
    return fallback;
  }
}

function skillsIn(pluginPath: string, fallbackName: string): SkillInfo[] {
  const dir = join(pluginPath, 'skills');
  if (!existsSync(dir)) return [];
  const plugin = pluginName(pluginPath, fallbackName);
  const out: SkillInfo[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name, 'SKILL.md');
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const fm = frontmatter(readFileSync(file, 'utf8'));
    const name = fm.name || entry.name;
    out.push({ id: `${plugin}:${name}`, name, description: fm.description ?? '', plugin, pluginPath });
  }
  return out;
}

// Rescanned on every call so newly installed skills show up without a restart.
export function catalog(): SkillInfo[] {
  const all = skillsIn(OFFICE_SKILLS, 'office');
  try {
    const installed = JSON.parse(readFileSync(INSTALLED, 'utf8')).plugins as Record<string, { installPath: string }[]>;
    for (const [key, versions] of Object.entries(installed)) {
      const latest = versions.at(-1);
      if (latest) all.push(...skillsIn(latest.installPath, key.split('@')[0]));
    }
  } catch {
    // No plugins installed.
  }
  return all;
}

// Accepts full ids or bare skill names; returns known ids and the names it couldn't match.
export function resolveSkills(requested: string[]) {
  const cat = catalog();
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const r of requested) {
    const hit = cat.find((s) => s.id === r) ?? cat.find((s) => s.name === r);
    if (hit) ids.includes(hit.id) || ids.push(hit.id);
    else unknown.push(r);
  }
  return { ids, unknown };
}

// Frontmatter keys a project skill keeps. Agents can edit their project's skills, so keys that
// grant tools or run code (allowed-tools, hooks, …) are dropped rather than trusted.
const SAFE_SKILL_KEYS = new Set(['name', 'description', 'disable-model-invocation', 'license', 'metadata']);

function sanitizeSkill(raw: string) {
  const md = raw.replace(/\r\n/g, '\n');
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return md;
  const kept: string[] = [];
  let keep = false;
  for (const line of m[1].split('\n')) {
    const key = line.match(/^(\w[\w-]*):/);
    if (key) keep = SAFE_SKILL_KEYS.has(key[1]);
    else if (!/^\s/.test(line)) keep = false;
    if (keep) kept.push(line);
  }
  return `---\n${kept.join('\n')}\n---${md.slice(m[0].length)}`;
}

// The project's own skills (<project>/.claude/skills, e.g. from Laravel Boost), copied into a
// per-agent plugin so only the skills load, never the project's settings, hooks or MCP servers.
// Copied fresh each turn so skills the team adds or updates show up straight away.
export function projectSkills(agentId: string, cwd: string): { pluginPath: string; ids: string[] } | null {
  const src = join(cwd, '.claude', 'skills');
  const pluginPath = join(DATA_DIR, 'project-skills', agentId);
  rmSync(pluginPath, { recursive: true, force: true });
  if (!existsSync(src)) return null;
  // Links are skipped: they could point the copy at files that never get sanitised.
  cpSync(src, join(pluginPath, 'skills'), { recursive: true, filter: (p) => !lstatSync(p).isSymbolicLink() });
  mkdirSync(join(pluginPath, '.claude-plugin'), { recursive: true });
  writeFileSync(join(pluginPath, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'project' }));
  for (const entry of readdirSync(join(pluginPath, 'skills'), { withFileTypes: true })) {
    const file = join(pluginPath, 'skills', entry.name, 'SKILL.md');
    if (entry.isDirectory() && existsSync(file)) writeFileSync(file, sanitizeSkill(readFileSync(file, 'utf8')));
  }
  const skills = skillsIn(pluginPath, 'project');
  return skills.length ? { pluginPath, ids: skills.map((s) => s.id) } : null;
}

// The project's CLAUDE.md (or AGENTS.md), for workers' system prompts.
export function projectInstructions(cwd: string): string {
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    try {
      return readFileSync(join(cwd, name), 'utf8').trim();
    } catch {
      // Try the next name.
    }
  }
  return '';
}
