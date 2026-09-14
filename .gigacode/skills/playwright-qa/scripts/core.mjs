import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseEnv } from 'node:util';
import { tlsPolicy } from './access.mjs';

export class BlockedError extends Error {}
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}
export function within(root, file) {
  const full = path.resolve(root, file);
  if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('Path outside project');
  // Existing input symlinks must not escape the project either.
  if (fs.existsSync(full) && !fs.realpathSync(full).startsWith(fs.realpathSync(root) + path.sep)) {
    throw new Error('Symlink outside project');
  }
  return full;
}
export function loadEnvironment(root, inherited = process.env) {
  const envFile = path.join(root, '.env');
  return { ...(fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {}), ...inherited };
}
export function readCase(root, file) {
  const full = within(root, file);
  const content = fs.readFileSync(full, 'utf8');
  const matches = [...content.matchAll(/^```ttt-case\s*\n([\s\S]*?)^```\s*$/gm)];
  if (matches.length !== 1) throw new Error('Case requires exactly one ttt-case JSON block');
  const data = JSON.parse(matches[0][1]);
  if (!/^[A-Za-z0-9_-]+$/.test(data.id ?? '') || !data.title || !data.profile ||
      !['ready', 'draft'].includes(data.state) || !Array.isArray(data.steps) || !data.steps.length) {
    throw new Error('Invalid case: id, title, profile, state and steps required');
  }
  const ids = new Set();
  for (const step of data.steps) {
    if (!Number.isInteger(step.id) || step.id < 1 || ids.has(step.id) ||
        typeof step.action !== 'string' || !step.action || typeof step.expected !== 'string' || !step.expected) {
      throw new Error('Invalid or duplicate case step');
    }
    ids.add(step.id);
  }
  return { ...data, file: path.relative(root, full), digest: hash(content) };
}
export function resolveProfile(root, testCase, env = loadEnvironment(root)) {
  const profile = readJSON(path.join(root, 'config/profiles.json'))[testCase.profile];
  if (!profile?.stand || !profile?.product || !profile?.role || !profile?.env?.baseURL) {
    throw new BlockedError('Unknown or incomplete profile: ' + testCase.profile);
  }
  if (!['password', 'anonymous'].includes(profile.auth)) throw new BlockedError('Unsupported auth mode');
  if (profile.auth === 'password' && (!profile.env.login || !profile.env.password)) {
    throw new BlockedError('Password profile requires login/password env names');
  }
  const mapping = { ...profile.env, ...(testCase.data ?? {}) };
  for (const key of Object.keys(testCase.data ?? {})) {
    if (Object.hasOwn(profile.env, key)) throw new BlockedError('Case data cannot override profile: ' + key);
  }
  const values = {}, secrets = [], missing = [];
  for (const [key, spec] of Object.entries(mapping)) {
    const rule = typeof spec === 'string' ? { env: spec } : spec;
    if (!rule || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(rule.env ?? '')) throw new BlockedError('Invalid env binding: ' + key);
    const value = env[rule.env];
    if (value === undefined || (value === '' && !rule.allowEmpty)) { missing.push(rule.env); continue; }
    if (rule.type === 'number' && (value.trim() === '' || !Number.isFinite(Number(value)))) {
      throw new BlockedError('Invalid number: ' + rule.env);
    }
    if (rule.type === 'boolean' && !['true', 'false'].includes(value)) throw new BlockedError('Invalid boolean: ' + rule.env);
    values[key] = rule.type === 'number' ? Number(value) : rule.type === 'boolean' ? value === 'true' : value;
    if (rule.secret || ['login', 'password'].includes(key)) secrets.push(value);
  }
  if (missing.length) throw new BlockedError('Missing env: ' + missing.join(', '));
  let url;
  try { url = new URL(values.baseURL); } catch { throw new BlockedError('Invalid baseURL env'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new BlockedError('Invalid baseURL protocol or credentials');
  return { ...profile, name: testCase.profile, mapping, values, secrets, tlsPolicy:tlsPolicy(values.baseURL) };
}
export function redact(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a,b) => b.length-a.length)) {
    text = text.split(secret).join('[REDACTED]');
  }
  return text;
}
export function sanitizeRecord(record, secrets = []) {
  // Redact human-readable values, never JSON syntax, status enums, paths or env binding names.
  const clean = structuredClone(record);
  for (const field of ['error','cleanupError']) if (clean[field]) clean[field] = redact(clean[field],secrets);
  if (clean.defect) for (const field of ['title','reason','impact','severity','reproduction','preconditions']) {
    if (clean.defect[field]) clean.defect[field] = redact(clean.defect[field],secrets);
  }
  for (const step of clean.steps ?? []) {
    for (const field of ['action','expected','actual','screenshotError']) {
      if (step[field]) step[field] = redact(step[field],secrets);
    }
  }
  return clean;
}
export function allSecrets(root, env = loadEnvironment(root)) {
  const names = new Set(Object.keys(env).filter(k => /PASSWORD|TOKEN|SECRET|LOGIN|EMAIL/i.test(k)));
  for (const config of ['profiles.json','sources.json']) {
  const file = path.join(root, 'config', config);
  if (fs.existsSync(file)) for (const p of Object.values(readJSON(file))) {
    for (const [key, value] of Object.entries(p.env ?? {})) {
      if (['login','password'].includes(key) || value?.secret) names.add(typeof value === 'string' ? value : value.env);
    }
  }
  }
  return [...names].map(k => env[k]).filter(Boolean);
}
export function plan(root, file) {
  const testCase = readCase(root, file);
  const registryFile = path.join(root, 'config/registry.json');
  const registry = fs.existsSync(registryFile) ? readJSON(registryFile) : {};
  const entry = registry[testCase.id];
  const action = testCase.state !== 'ready' ? 'blocked' : !entry ? 'create' :
    entry.case !== testCase.file || entry.digest !== testCase.digest ? 'update' :
      !fs.existsSync(within(root, entry.test)) ? 'create' : 'run';
  return { action, testCase, entry };
}
export function register(root, caseFile, testFile) {
  const testCase = readCase(root, caseFile);
  if (testCase.state !== 'ready') throw new Error('Cannot register draft case');
  const full = within(root, testFile);
  if (!/\.spec\.[cm]?[jt]s$/.test(full) || !fs.statSync(full).isFile()) throw new Error('Expected spec file');
  const file = path.join(root, 'config/registry.json');
  const registry = fs.existsSync(file) ? readJSON(file) : {};
  if (registry[testCase.id] && registry[testCase.id].case !== testCase.file) throw new Error('Duplicate case ID');
  registry[testCase.id] = { case: testCase.file, digest: testCase.digest, test: path.relative(root, full) };
  writeJSON(file, registry);
}
