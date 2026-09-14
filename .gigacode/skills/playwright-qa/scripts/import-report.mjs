import fs from 'node:fs';
import path from 'node:path';
import { readJSON, within, allSecrets, writeJSON, redact, sanitizeRecord } from './core.mjs';
import { newRun, renderReport } from './report.mjs';

// MCP remains responsible for browser actions. This imports its observed evidence.
export function importReport(root, filename) {
  const source = within(root, filename);
  const journal = readJSON(source);
  if (!['manual','exploratory'].includes(journal.mode) || !Array.isArray(journal.records) || !journal.records.length) {
    throw new Error('Journal requires mode manual/exploratory and nonempty records');
  }
  const secrets = allSecrets(root);
  const images = [];
  for (const record of journal.records) {
    if (!record.id || !record.profile || !Array.isArray(record.steps)) throw new Error('Invalid journal record');
    for (const step of record.steps) {
      if (!Number.isInteger(step.id) || !step.action || !['passed','failed','blocked','not_run','observation','question'].includes(step.status)) {
        throw new Error('Invalid journal step');
      }
      if (['passed','failed'].includes(step.status) && (!step.expected || !step.actual)) throw new Error('Check requires expectation and fact');
      if (!step.screenshot && !step.screenshotError) throw new Error('Step requires screenshot or explicit absence reason');
      if (step.screenshot) {
        const full = within(root, path.relative(root,path.resolve(path.dirname(source),step.screenshot)));
        const buffer = fs.readFileSync(full);
        if (!buffer.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) throw new Error('Expected PNG evidence');
        const dest = `screenshots/evidence-${images.length+1}.png`;
        images.push({buffer,dest}); step.screenshot = dest;
      }
    }
  }
  const dir = newRun(root,journal.mode);
  for (const {buffer,dest} of images) fs.writeFileSync(path.join(dir,dest),buffer);
  const clean = {...journal,records:journal.records.map(r=>sanitizeRecord(r,secrets)),summary:{...journal.summary}};
  for(const field of ['error','command']) if(clean.summary[field]) clean.summary[field]=redact(clean.summary[field],secrets);
  writeJSON(path.join(dir,'summary.json'),clean);
  return renderReport(dir,clean.records,{status:'imported — действия выполнены агентом, не импортёром',...clean.summary},secrets);
}
