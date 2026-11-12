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
// machine, or delete folders outside the place they're run from. A tripwire for mistakes, not a sandbox.
const SYSTEM = /(^|[\s;&|(`])(sudo|su|doas|dd|mkfs\S*|diskutil|launchctl|osascript|security|defaults|shutdown|reboot)(\s|$)/;
const WIDE_DELETE = /(^|[\s;&|(`])rm\s+(-\S+\s+)*-\S*[rR]\S*[^;&|]*\s["']?(\/|~|\$HOME|\$\{HOME\}|\.\.)/;
export const needsOwner = (command: unknown) => typeof command !== 'string' || SYSTEM.test(command) || WIDE_DELETE.test(command);

// A bare "Bash" from before rules existed allowed every command; it no longer counts.
export const isLegacyRule = (rule: string) => rule === 'Bash';
