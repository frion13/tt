import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redact } from './core.mjs';
import { writeBugReport } from './bugs.mjs';

const escape = value => String(value ?? '').replace(/[&<>]/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;'}[c])).replace(/([\\`*_[\]#!|])/g, '\\$1');
export function newRun(root, mode = 'automation') {
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0,8);
  const dir = path.join(root, 'reports', mode, id);
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'records'), { recursive: true });
  return dir;
}
export function renderReport(dir, records, summary = {}, secrets = []) {
  const safe = value => escape(redact(value, secrets));
  const lines = ['# Отчёт тестирования', '', `Run: ${path.basename(dir)}`, '',
    `Статус запуска: ${escape(summary.status ?? 'running')}`, '',
    `Код выхода: ${safe(summary.exitCode ?? 'ожидается')}`, '',
    `Команда: ${safe(summary.command ?? 'Playwright Test')}`, ''];
  if (summary.error) lines.push(`Ошибка запуска: ${safe(summary.error)}`, '');
  const counts = {};
  for (const r of records) counts[r.status ?? 'unknown'] = (counts[r.status ?? 'unknown'] ?? 0) + 1;
  lines.push(`Попытки по статусам: ${escape(JSON.stringify(counts))}`, '');
  for (const record of records) {
    const bugFile = writeBugReport(dir,record,secrets);
    lines.push(`## ${safe(record.id)} — ${safe(record.browser)} — попытка ${record.attempt ?? 1}`, '',
      `Статус: ${escape(record.status)}`, '', `Профиль: ${safe(record.profile)}`, '');
    if (record.context) lines.push(`Стенд: ${safe(record.context.stand)}; продукт: ${safe(record.context.product)}; роль: ${safe(record.context.role)}`, '',
      `Env-привязки: ${safe(JSON.stringify(record.context.mapping))}`, '');
    if (record.context?.tls) lines.push(`TLS: ignoreHTTPSErrors=${record.context.tls.ignoreHTTPSErrors}; contextOrigin=${safe(record.context.tls.origin)}`, '');
    if (record.error) lines.push(`Ошибка: ${safe(record.error)}`, '');
    if (bugFile) lines.push(`[Баг-репорт / диагностика](${path.basename(dir)}/${bugFile})`, '');
    if (record.cleanupError) lines.push(`Очистка: ${safe(record.cleanupError)}`, '');
    for (const step of record.steps ?? []) {
      lines.push(`### Шаг ${step.id}. ${safe(step.action)}`, '',
        `- Ожидание: ${safe(step.expected)}`, `- Факт: ${safe(step.actual ?? 'не выполнялся')}`,
        `- Статус: ${escape(step.status)}`, '');
      if (step.screenshot) {
        const image = path.resolve(dir, step.screenshot);
        if (!image.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(image)) throw new Error('Missing or unsafe screenshot');
        if (!fs.readFileSync(image).subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) throw new Error('Screenshot must be PNG');
        lines.push(`![Шаг ${step.id}](${path.basename(dir)}/${step.screenshot.split(path.sep).map(encodeURIComponent).join('/')})`, '');
      } else lines.push(`Скриншот: ${safe(step.screenshotError ?? 'шаг не выполнялся')}`, '');
    }
  }
  const destination = `${dir}.md`;
  fs.writeFileSync(destination + '.tmp', lines.join('\n'));
  fs.renameSync(destination + '.tmp', destination);
  return destination;
}
