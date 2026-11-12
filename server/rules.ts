// "Always allow" rules. For most tools a rule is the tool's name. For shell commands it is the start
// of a command, e.g. "Bash(npm run test)", so saying "always" to one command doesn't allow every other.

// Anything that chains, redirects or substitutes can hide a second command, so it never matches a rule.
const SHELL_SYNTAX = /[\n;&|<>`$(){}\\]/;
const WORD = /^[A-Za-z][\w:.@-]*$/;
// Commands with a third word that names what actually runs.
const THREE_WORDS = new Set(['npm run', 'pnpm run', 'yarn run', 'bun run', 'npm exec', 'php artisan', 'docker compose', 'python -m', 'python3 -m']);
// Too broad or too dangerous to ever wave through unseen.
const NEVER = new Set([
  'rm', 'sudo', 'su', 'doas', 'dd', 'mkfs', 'chmod', 'chown', 'kill', 'killall', 'pkill', 'curl', 'wget', 'ssh', 'scp', 'rsync',
  'eval', 'exec', 'sh', 'bash', 'zsh', 'fish', 'env', 'xargs', 'find', 'mv', 'osascript', 'open', 'security', 'launchctl', 'defaults',
]);

function words(command: unknown): string[] | null {
  if (typeof command !== 'string' || SHELL_SYNTAX.test(command)) return null;
  const w = command.trim().split(/\s+/).filter(Boolean);
  // "KEY=value cmd" runs cmd with a changed environment; treat it as not simple.
  return w.length && !w[0].includes('=') ? w : null;
}

const prefixOf = (rule: string) => rule.match(/^Bash\((.+)\)$/)?.[1].split(' ') ?? null;

// The rule to offer for a shell command, or null when it's one that should be asked about every time.
export function suggestBashRule(command: unknown): string | null {
  const w = words(command);
  if (!w || NEVER.has(w[0].split('/').pop()!)) return null;
  let n = 1;
  if (w[1] && (WORD.test(w[1]) || THREE_WORDS.has(`${w[0]} ${w[1]}`))) n = 2;
  if (n === 2 && w[2] && THREE_WORDS.has(`${w[0]} ${w[1]}`) && WORD.test(w[2])) n = 3;
  return `Bash(${w.slice(0, n).join(' ')})`;
}

// How a rule reads to the owner: "npm run test …" or the tool's name.
export function ruleLabel(rule: string) {
  const p = prefixOf(rule);
  return p ? `${p.join(' ')} …` : rule;
}

export function allowedByRules(rules: string[], toolName: string, input: Record<string, unknown>) {
  if (toolName !== 'Bash') return rules.includes(toolName);
  const w = words(input.command);
  if (!w) return false;
  return rules.some((r) => {
    const p = prefixOf(r);
    return !!p && p.length <= w.length && p.every((x, i) => x === w[i]);
  });
}

// Commands the owner is still asked about when an agent works without asking: ones that take over the
// machine, or delete a whole home, disk or top-level folder. A tripwire for mistakes, not a sandbox.
// Only where a command starts, so the word "security" inside a message or a sed script doesn't count.
const SYSTEM = /(^|[;&|(`\n])\s*(sudo|su|doas|dd|mkfs\S*|diskutil|launchctl|osascript|security|defaults|shutdown|reboot)(\s|$)/;
const RM = /(?:^|[;&|(`\n])\s*rm\s+([^;&|\n)]*)/g;
const SCRATCH = /^(\/private)?\/(tmp|var\/folders)(\/|$)/;

// "rm -r" aimed at /, the home folder, the folder it runs in, a parent, or something like /Users/name.
// Temp folders and anything deeper (a project's dist, a worktree in /tmp) are everyday cleanup.
function wideDelete(command: string) {
  for (const m of command.matchAll(RM)) {
    const args = m[1].split(/\s+/).filter(Boolean);
    if (!args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive')) continue;
    for (const raw of args) {
      if (raw.startsWith('-')) continue;
      const p = raw.replace(/["']/g, '').replace(/\/*\*?$/, '');
      if (['', '~', '$HOME', '${HOME}', '.'].includes(p) || /^\.\.(\/\.\.)*$/.test(p)) return true;
      if (p.startsWith('/') && !SCRATCH.test(p) && p.split('/').length <= 3) return true;
    }
  }
  return false;
}

export const needsOwner = (command: unknown) => typeof command !== 'string' || SYSTEM.test(command) || wideDelete(command);

// A bare "Bash" from before rules existed allowed every command; it no longer counts.
export const isLegacyRule = (rule: string) => rule === 'Bash';
