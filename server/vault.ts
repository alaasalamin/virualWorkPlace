// Each team's safe: environment variables per environment (local, prod, …), encrypted on disk.
// The encryption key lives in the macOS Keychain, so the files alone are useless.
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './store.ts';

type Entry = { value: string; updatedBy: string; updatedAt: number };
type Vault = Record<string, Record<string, Entry>>; // env -> key -> entry

export type KeyInfo = { key: string; updatedBy: string; updatedAt: number; length: number };

const DIR = join(DATA_DIR, 'vaults');
const SERVICE = 'agent-office-vault';
const ACCOUNT = 'master-key';
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const ENV_RE = /^[a-z][a-z0-9-]{0,19}$/;
const MAX_VALUE = 20_000;

export const DEFAULT_ENVS = ['local', 'prod'];
// Anything other than local counts as sensitive: changes and env files need the owner's OK.
export const isSensitive = (env: string) => env !== 'local';

let masterKey: Buffer | null = null;
// Bumped on every write, so callers can cache what's in the safes.
let version = 0;
export const vaultVersion = () => version;

function keychainKey(): Buffer {
  if (masterKey) return masterKey;
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    masterKey = Buffer.from(out, 'base64');
  } catch {
    // First run: make a key and keep it in the login keychain.
    const k = randomBytes(32);
    execFileSync('security', ['add-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w', k.toString('base64'), '-U'], {
      stdio: 'ignore',
    });
    masterKey = k;
  }
  if (masterKey.length !== 32) throw new Error('The safe key in the Keychain is damaged.');
  return masterKey;
}

const fileFor = (teamId: string) => join(DIR, `${teamId.replace(/[^a-z0-9-]/gi, '')}.vault`);

function load(teamId: string): Vault {
  const file = fileFor(teamId);
  if (!existsSync(file)) return Object.fromEntries(DEFAULT_ENVS.map((e) => [e, {}]));
  const { iv, tag, data } = JSON.parse(readFileSync(file, 'utf8'));
  const d = createDecipheriv('aes-256-gcm', keychainKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  const plain = Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  return JSON.parse(plain);
}

function store(teamId: string, v: Vault) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keychainKey(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(v), 'utf8'), c.final()]);
  const body = JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') });
  const file = fileFor(teamId);
  version++;
  writeFileSync(file + '.tmp', body, { mode: 0o600 });
  renameSync(file + '.tmp', file);
  chmodSync(file, 0o600);
}

export function checkName(env: string, key?: string) {
  if (!ENV_RE.test(env)) return 'Environment names are lowercase letters, numbers and dashes, like "local" or "prod".';
  if (key !== undefined && !KEY_RE.test(key)) return 'Keys are letters, numbers and underscores, starting with a letter, like STRIPE_KEY.';
  return '';
}

// Keys and who last changed them; never the values.
export function listKeys(teamId: string): Record<string, KeyInfo[]> {
  const v = load(teamId);
  return Object.fromEntries(
    Object.entries(v).map(([env, keys]) => [
      env,
      Object.entries(keys)
        .map(([key, e]) => ({ key, updatedBy: e.updatedBy, updatedAt: e.updatedAt, length: e.value.length }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    ]),
  );
}

export function readValue(teamId: string, env: string, key: string): string | undefined {
  return load(teamId)[env]?.[key]?.value;
}

export function setValue(teamId: string, env: string, key: string, value: string, by: string) {
  const err = checkName(env, key) || (value.length > MAX_VALUE ? 'That value is too long for the safe.' : '');
  if (err) throw new Error(err);
  const v = load(teamId);
  (v[env] ??= {})[key] = { value, updatedBy: by, updatedAt: Date.now() };
  store(teamId, v);
}

export function deleteKey(teamId: string, env: string, key: string) {
  const v = load(teamId);
  if (!v[env]?.[key]) return false;
  delete v[env][key];
  store(teamId, v);
  return true;
}

// Everything as plain { env: { KEY: value } } for the owner's JSON editor.
export function exportJson(teamId: string) {
  const v = load(teamId);
  return Object.fromEntries(Object.entries(v).map(([env, keys]) => [env, Object.fromEntries(Object.entries(keys).map(([k, e]) => [k, e.value]))]));
}

// Replace the whole safe from the owner's JSON, keeping who-changed-what for untouched keys.
export function importJson(teamId: string, json: unknown, by: string) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('The safe must be an object of environments, like {"local": {"KEY": "value"}}.');
  const old = load(teamId);
  const next: Vault = {};
  for (const [env, keys] of Object.entries(json as Record<string, unknown>)) {
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw new Error(`"${env}" must be an object of keys and values.`);
    for (const [key, value] of Object.entries(keys as Record<string, unknown>)) {
      const err = checkName(env, key);
      if (err) throw new Error(`${env}.${key}: ${err}`);
      if (typeof value !== 'string') throw new Error(`${env}.${key}: values must be text (put numbers in quotes).`);
      if (value.length > MAX_VALUE) throw new Error(`${env}.${key}: that value is too long.`);
      const prev = old[env]?.[key];
      (next[env] ??= {})[key] = prev && prev.value === value ? prev : { value, updatedBy: by, updatedAt: Date.now() };
    }
    next[env] ??= {};
  }
  store(teamId, next);
}

// KEY=value lines for a .env file, quoted so any value survives.
export function envFileText(teamId: string, env: string) {
  const keys = load(teamId)[env] ?? {};
  const lines = Object.keys(keys)
    .sort()
    .map((k) => `${k}=${JSON.stringify(keys[k].value)}`);
  return { text: `# Written by Agent Office from the ${env} safe. Don't commit this file.\n${lines.join('\n')}\n`, count: lines.length };
}

// Fail early (at startup) if the Keychain isn't reachable, instead of on the first secret.
export function checkVaultAccess() {
  keychainKey();
}
