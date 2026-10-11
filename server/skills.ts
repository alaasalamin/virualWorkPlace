import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ROOT } from './store.ts';

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
