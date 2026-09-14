import fs from 'node:fs';
import path from 'node:path';
import { hash, readCase, readJSON, writeJSON, allSecrets, redact, loadEnvironment, resolveProfile, sanitizeRecord } from './core.mjs';
import { newRun, renderReport } from './report.mjs';

export default class MarkdownReporter {
  onBegin(config, suite) {
    this.root = process.cwd();
    this.dir = process.env.TTT_RUN_DIR || newRun(this.root);
    process.env.TTT_RUN_DIR = this.dir;
    this.secrets = allSecrets(this.root);
    this.records = new Map();
    for (const t of suite.allTests()) {
      const annotation = t.annotations.find(a => a.type === 'ttt-case');
      if (!annotation) continue;
      const c = readCase(this.root, annotation.description);
      // Include custom secret bindings even if profile validation later fails.
      const env = loadEnvironment(this.root);
      for (const spec of Object.values(c.data ?? {})) if (spec?.secret && env[spec.env]) this.secrets.push(env[spec.env]);
      this.records.set(hash(t.id + ':0'), { id: c.id, profile: c.profile, browser: t.parent.project()?.name,
        status: 'not_run', attempt: 1, steps: c.steps.map(s => ({ ...s, status: 'not_run' })) });
    }
    this.flush();
  }
  refresh(test, result) {
    const key = hash(test.id + ':' + result.retry);
    const file = path.join(this.dir, 'records', key + '.json');
    if (fs.existsSync(file)) this.records.set(key, readJSON(file));
    return key;
  }
  onStepEnd(test, result) { this.refresh(test, result); this.flush(); }
  onTestEnd(test, result) {
    const key = this.refresh(test, result);
    let record = this.records.get(key);
    if (!record) {
      const a = test.annotations.find(a => a.type === 'ttt-case');
      const c = a ? readCase(this.root, a.description) : null;
      record = { id: c?.id ?? test.title, profile: c?.profile, browser: test.parent.project()?.name,
        attempt: result.retry + 1, steps: c?.steps.map(s => ({ ...s, status: 'not_run' })) ?? [] };
    }
    record.runnerStatus = result.status;
    record.status = record.status === 'blocked' ? 'blocked' : result.status;
    record.error = result.error?.message ?? record.error;
    const a = test.annotations.find(a => a.type === 'ttt-case');
    if (a) {
      try {
        const p = resolveProfile(this.root, readCase(this.root, a.description));
        record.context ??= {stand:p.stand, product:p.product, role:p.role, mapping:p.mapping};
      } catch { /* keep actual failure; missing profile details are not guessed */ }
    }
    this.records.set(key, record);
    this.flush();
  }
  onError(error) { this.error = error.message; if (this.records) this.flush(); }
  onEnd(result) {
    const records = [...this.records.values()];
    const retryPassed = records.some(r => r.attempt > 1 && r.status === 'passed');
    const status = retryPassed && result.status === 'passed' ? 'flaky' : result.status;
    this.flush({ status, exitCode: result.status === 'passed' ? 0 : 1 });
    if (this.reportFailed) return {status: 'failed'};
  }
  flush(summary = {}) {
    try {
      const records = [...this.records.values()].map(r=>sanitizeRecord(r,this.secrets));
      const state = { status: 'running', error: this.error, ...summary };
      writeJSON(path.join(this.dir, 'summary.json'), { records, summary: {...state,error:state.error ? redact(state.error,this.secrets) : undefined} });
      renderReport(this.dir, records, state, this.secrets);
    } catch { this.reportFailed = true; }
  }
  onExit() {
    if (this.reportFailed) { process.stderr.write('Markdown report generation failed\n'); process.exitCode = 1; }
    else process.stdout.write(`Markdown: ${this.dir}.md\n`);
  }
}
