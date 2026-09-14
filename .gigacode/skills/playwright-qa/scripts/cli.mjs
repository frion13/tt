#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { plan, register, resolveProfile, loadEnvironment, allSecrets, readJSON, writeJSON, redact } from './core.mjs';
import { newRun, renderReport } from './report.mjs';
import { importReport } from './import-report.mjs';
import { resolveSource } from './access.mjs';
import { classifyBug } from './bugs.mjs';
import {createRequire} from 'node:module';
import {initProject} from './init.mjs';

export function main(args = process.argv.slice(2), root = process.cwd()) {
  args=[...args];
  const projectIndex=args.indexOf('--project');
  if(projectIndex!==-1){
    if(!args[projectIndex+1]) throw new Error('--project requires a directory');
    root=path.resolve(root,args[projectIndex+1]);args.splice(projectIndex,2);
  }
  root=fs.realpathSync(root);
  const [command, file, spec] = args;
  if(command==='init'){console.log(JSON.stringify(initProject(root),null,2));return 0;}
  if (command === 'bug' && file && spec) {
    const {dir,state,secrets}=classifyBug(root,file,spec);
    console.log(`Markdown: ${renderReport(dir,state.records,state.summary,secrets)}`);
    return 0;
  }
  if (command === 'source' && file && spec) {
    const source=resolveSource(root,file,spec);
    console.log(JSON.stringify({name:source.name, origin:new URL(source.target).origin, env:source.env, tls:source.tlsPolicy},null,2));
    return 0;
  }
  if (command === 'report' && file) { console.log(`Markdown: ${importReport(root,file)}`); return 0; }
  if (command === 'register') {
    if (!file || !spec) throw new Error('Usage: playwright-qa register case.md e2e/test.spec.mjs');
    register(root, file, spec);
    console.log('Registered. Verify with qa run.');
    return 0;
  }
  if (!['plan','run'].includes(command) || !file) {
    console.log('Usage: playwright-qa plan|run test-cases/ID.md\n       playwright-qa register test-cases/ID.md e2e/ID.spec.mjs\n       playwright-qa report evidence/journal.json');
    return 2;
  }
  const decision = plan(root, file);
  if (command === 'plan') {
    console.log(JSON.stringify({ action: decision.action, id: decision.testCase.id, test: decision.entry?.test }, null, 2));
    return 0;
  }
  const dir = newRun(root);
  const record = { id: decision.testCase.id, profile: decision.testCase.profile, browser: 'not_started',
    status: 'blocked', steps: decision.testCase.steps.map(s => ({...s, status: 'not_run'})) };
  const env = loadEnvironment(root);
  let secrets = allSecrets(root, env);
  const blocked = (reason, code = 2) => {
    record.error = reason;
    renderReport(dir, [record], {status: 'blocked', exitCode: code}, secrets);
    console.log(`Markdown: ${dir}.md`);
    return code;
  };
  if (decision.action !== 'run') return blocked(`Action required: ${decision.action}. Generate/update the test and register it after review.`, 3);
  try {
    const profile = resolveProfile(root, decision.testCase, env);
    secrets.push(...profile.secrets);
    record.context = { stand: profile.stand, product: profile.product, role: profile.role, mapping: profile.mapping, tls:profile.tlsPolicy };
  } catch (error) { return blocked(error.message); }
  let cli;
  try {
    const requireFromProject=createRequire(path.join(root,'package.json'));
    cli=path.join(path.dirname(requireFromProject.resolve('@playwright/test/package.json')),'cli.js');
  } catch { return blocked('Playwright Test not installed in target project; install @playwright/test'); }
  const escapedId = decision.testCase.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const childArgs = [cli, 'test', decision.entry.test, '--grep', `(?:^|\\s)${escapedId}:`];
  renderReport(dir, [record], {status: 'running'}, secrets);
  // No shell interpolation; do not echo raw runner logs that could contain credentials.
  const child = spawnSync(process.execPath, childArgs, {
    cwd: root, env: { ...env, TTT_RUN_DIR: dir }, encoding: 'utf8',
    timeout: 300000, maxBuffer: 16 * 1024 * 1024
  });
  fs.writeFileSync(path.join(dir, 'runner.log'), redact((child.stdout ?? '') + (child.stderr ?? ''), secrets));
  const code = child.error || child.signal ? 2 : child.status ?? 2;
  const summaryFile = path.join(dir, 'summary.json');
  const state = fs.existsSync(summaryFile) ? readJSON(summaryFile) : {records: [record], summary: { status: 'blocked' }};
  state.summary.exitCode = code;
  state.summary.command = ['node', ...childArgs.slice(0,1).map(p => path.relative(root,p)), ...childArgs.slice(1)].join(' ');
  if (child.error || child.signal || !state.records.length || state.summary.status === 'running') {
    state.summary.status = 'blocked';
    state.summary.error = child.error?.code ?? child.signal ?? 'Runner did not complete or found no tests';
    if (!state.records.length) state.records = [record];
  }
  writeJSON(summaryFile, state);
  renderReport(dir, state.records, state.summary, secrets);
  console.log(`Markdown: ${dir}.md`);
  return code || (state.summary.status === 'blocked' ? 2 : 0);
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) { console.error(redact(error.message, allSecrets(process.cwd()))); process.exitCode = 2; }
}
