import path from 'node:path';
import { test, expect } from '@playwright/test';
import { readCase, resolveProfile, hash, writeJSON, sanitizeRecord, BlockedError } from './core.mjs';
import { createContext } from './access.mjs';

export { expect };
export function caseTest(caseFile, body) {
  const root = process.cwd();
  const testCase = readCase(root, caseFile);
  test(`${testCase.id}: ${testCase.title}`, { annotation: { type: 'ttt-case', description: caseFile } }, async ({ browser }, info) => {
    const dir = process.env.TTT_RUN_DIR;
    if (!dir) throw new Error('TTT reporter must be configured');
    const key = hash(info.testId + ':' + info.retry);
    const file = path.join(dir, 'records', key + '.json');
    let context, profile;
    const record = { id: testCase.id, caseFile: testCase.file, profile: testCase.profile, browser: info.project.name,
      attempt: info.retry + 1, status: 'running', steps: testCase.steps.map(s => ({ ...s, status: 'not_run' })) };
    const save = () => writeJSON(file, sanitizeRecord(record, profile?.secrets));
    save();
    try {
      if (testCase.state !== 'ready') throw new BlockedError('Draft case');
      profile = resolveProfile(root, testCase);
      record.context = { stand: profile.stand, product: profile.product, role: profile.role, mapping: profile.mapping, tls:profile.tlsPolicy };
      context = await createContext(browser, profile);
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      let cursor = 0;
      await body({ page, data: profile.values, profile, context,
        step: async (id, operation, options = {}) => {
          const step = record.steps[cursor];
          if (!step || step.id !== id) throw new Error('Steps must execute exactly once in case order');
          cursor++;
          await test.step(`${id}: ${step.action}`, async () => {
            try {
              const actual = await operation();
              if (typeof actual !== 'string' || !actual.trim()) throw new Error('Step must return observed fact after assertions');
              step.actual = actual;
              step.status = 'passed';
            } catch (error) {
              step.status = 'failed';
              step.actual = error.message;
              throw error;
            } finally {
              if (options.noScreenshot) {
                step.screenshotError = options.noScreenshot;
              } else {
                const relative = `screenshots/${key}-step-${id}.png`;
                try {
                  const mask = [page.locator('input, textarea, [data-sensitive]'), ...(options.mask ?? []),
                    ...profile.secrets.filter(Boolean).map(s => page.getByText(s, { exact: false }))];
                  await page.screenshot({ path: path.join(dir, relative), mask, timeout: 5000 });
                  step.screenshot = relative;
                } catch {
                  step.screenshotError = 'Снимок недоступен: браузер закрыт или ошибка захвата';
                }
              }
              save();
            }
          });
        }
      });
      if (record.steps.some(s => s.status !== 'passed')) throw new Error('Not all case steps completed');
      record.status = 'passed';
    } catch (error) {
      record.status = error instanceof BlockedError ? 'blocked' : 'failed';
      record.error = error.message;
      throw error;
    } finally {
      try { await context?.close(); } catch { record.cleanupError = 'Browser context cleanup failed'; }
      save();
    }
  });
}
