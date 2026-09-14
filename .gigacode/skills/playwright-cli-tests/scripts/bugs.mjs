import fs from 'node:fs';
import path from 'node:path';
import { hash, redact, readJSON, within, writeJSON, allSecrets, sanitizeRecord } from './core.mjs';

const escape = value => String(value ?? '').replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])).replace(/([\\`*_[\]#!|])/g,'\\$1');

export function writeBugReport(dir, record, secrets = []) {
  const failed = record.steps?.find(s=>s.status==='failed');
  if (!failed || !['failed','timedOut'].includes(record.status)) return null;
  const review = record.defect ?? { kind:'unknown' };
  const kind = review.kind ?? 'unknown';
  if (!['product','test','environment','requirements','unknown'].includes(kind)) throw new Error('Invalid defect classification');
  if (kind==='product' && (!review.reason || !review.impact || !review.reproduction)) throw new Error('Confirmed defect requires diagnosis, impact and reproduction result');
  const status = kind==='product' ? 'Подтверждённый дефект продукта' :
    kind==='unknown' ? 'Черновик — требуется диагностика причины' : `Не дефект продукта: ${kind}`;
  const id = 'BUG-' + hash(`${record.id}:${record.browser}:${record.attempt ?? 1}:${failed.id}`).slice(0,12);
  const relative = `bugs/${id}.md`;
  const safe = v=>escape(redact(v,secrets));
  const lines = [`# ${id}: ${safe(review.title ?? `${record.id} — расхождение на шаге ${failed.id}`)}`, '',
    `Статус: ${status}`, '', `Кейс: ${safe(record.id)}`, '',
    `Прогон: ${safe(path.basename(dir))}; браузер: ${safe(record.browser)}; попытка: ${record.attempt ?? 1}`, '',
    `Профиль: ${safe(record.profile)}`, '',
    `Стенд: ${safe(record.context?.stand ?? 'не указан')}; продукт: ${safe(record.context?.product ?? 'не указан')}; роль: ${safe(record.context?.role ?? 'не указана')}`, '',
    `Источник/предусловия: ${safe(review.preconditions ?? record.caseFile ?? 'см. исходный кейс; уточнить предусловия')}`, '',
    `Env-привязки: ${safe(JSON.stringify(record.context?.mapping ?? {}))}`, '',
    `TLS: ${safe(JSON.stringify(record.context?.tls ?? {}))}`, '',
    '## Шаги воспроизведения', ''];
  for (const s of record.steps) {
    if (s.status !== 'not_run') lines.push(`${s.id}. ${safe(s.action)}`);
    if (s.id === failed.id) break;
  }
  lines.push('', '## Ожидаемый результат', '', safe(failed.expected), '',
    '## Фактический результат', '', safe(failed.actual ?? record.error), '',
    '## Диагностика', '', safe(review.reason ?? 'Падение теста ещё не подтверждает дефект продукта.'), '',
    `Влияние: ${safe(review.impact ?? 'не оценено')}`, '',
    `Серьёзность: ${safe(review.severity ?? 'не назначена')}`, '',
    `Повторная проверка: ${safe(review.reproduction ?? 'не выполнялась или результат не зафиксирован')}`, '',
    '## Доказательства', '');
  for (const s of record.steps) {
    if (s.screenshot) {
      const full=path.resolve(dir,s.screenshot);
      if (!full.startsWith(path.resolve(dir)+path.sep) || !fs.existsSync(full)) throw new Error('Missing or unsafe bug screenshot');
      lines.push(`![Шаг ${s.id}](../${s.screenshot.split(path.sep).map(encodeURIComponent).join('/')})`, '');
    } else if (s.id===failed.id) lines.push(`Скриншот: ${safe(s.screenshotError ?? 'недоступен')}`, '');
    if (s.id===failed.id) break;
  }
  lines.push(`[Полный отчёт](../../${encodeURIComponent(path.basename(dir))}.md)`, '');
  fs.mkdirSync(path.join(dir,'bugs'),{recursive:true});
  fs.writeFileSync(path.join(dir,relative),lines.join('\n'));
  return relative;
}

export function classifyBug(root, summaryFile, assessmentFile) {
  const source=within(root,summaryFile), assessment=readJSON(within(root,assessmentFile));
  if (path.basename(source)!=='summary.json') throw new Error('Expected run summary.json');
  const state=readJSON(source);
  if (state.summary?.status==='running') throw new Error('Wait until the run finishes before classification');
  if (!['product','test','environment','requirements','unknown'].includes(assessment.kind) || !assessment.reason) {
    throw new Error('Assessment requires kind and diagnostic reason');
  }
  if (assessment.kind==='product' && (!assessment.impact || !assessment.reproduction)) {
    throw new Error('Product defect requires impact and reproduction result (including explicitly not rechecked)');
  }
  const matches=state.records.filter(r=>r.id===assessment.id && r.browser===assessment.browser && (r.attempt ?? 1)===assessment.attempt);
  if (matches.length!==1 || !matches[0].steps?.some(s=>s.status==='failed') || !['failed','timedOut'].includes(matches[0].status)) {
    throw new Error('Select exactly one failed attempt with failed steps');
  }
  matches[0].defect={...assessment};
  const secrets=allSecrets(root);
  state.records=state.records.map(r=>sanitizeRecord(r,secrets));
  writeJSON(source,state);
  return {dir:path.dirname(source),state,secrets};
}
