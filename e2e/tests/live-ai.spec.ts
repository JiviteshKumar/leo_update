import { randomUUID } from 'node:crypto';
import type { Step, Workflow } from '@leo/shared';
import { SITE, expect, mockAi, test } from './harness';

// Real model, real pages. Opt-in: LEO_E2E_LIVE_AI=1 makes the fixture server
// answer /api/ai/* with Claude through fe/src/lib/ai/core.ts, using
// ANTHROPIC_API_KEY from the environment or fe/.env.local. Costs a few cents.

const LIVE = process.env.LEO_E2E_LIVE_AI === '1';

const workflow = (startUrl: string, steps: Step[]): Workflow => {
  const now = Date.now();
  return { id: randomUUID(), name: 'Live AI', createdAt: now, updatedAt: now, startUrl, healCount: 0, steps };
};

const doneButton: Step = {
  type: 'click',
  target: { selectors: ['#done'], tag: 'button', text: 'Done', intent: 'Click "Done"', framePath: [] },
};

const calls = async (path: string) => (await mockAi.log()).filter((e) => e.path === path).length;

test.describe('live AI', () => {
  test.skip(!LIVE, 'set LEO_E2E_LIVE_AI=1 to run against the real model');
  test.describe.configure({ timeout: 300_000 });

  test('names a recorded workflow, repairs a redesigned page, then replays without AI', async ({ context, leo }) => {
    const page = await context.newPage();
    await page.goto(`${SITE}/form.html`);
    await leo.record(page);
    await page.fill('#name', 'Grace Hopper');
    await page.click('#submit');
    const wf = await leo.stop('Signup', 3);

    // Objective derivation runs in the background after saving.
    await expect
      .poll(async () => (await leo.state()).workflows.find((w) => w.id === wf.id)?.objective ?? '', {
        timeout: 90_000,
      })
      .not.toBe('');

    const saved = (await leo.state()).workflows.find((w) => w.id === wf.id)!;
    const redesigned = `${SITE}/form.html?v=2`;
    saved.startUrl = redesigned;
    saved.steps[0] = { type: 'navigate', url: redesigned };
    await leo.call('saveWorkflow', saved);

    const run = await leo.run(wf.id);
    const first = await leo.expectDone(240_000);
    expect(first.healedSteps).toContain(2);
    await expect(run.locator('#result')).toContainText('"name":"Grace Hopper"');
    const aiCallsAfterFirst = (await calls('/api/ai/heal')) + (await calls('/api/ai/agent'));
    expect(aiCallsAfterFirst).toBeGreaterThan(0);

    await run.close();
    const again = await leo.run(wf.id);
    const second = await leo.expectDone();
    expect(second.healedSteps).toEqual([]);
    await expect(again.locator('#result')).toContainText('"name":"Grace Hopper"');
    expect((await calls('/api/ai/heal')) + (await calls('/api/ai/agent'))).toBe(aiCallsAfterFirst);
  });

  test('an AI step chooses an option in a custom dropdown', async ({ leo }) => {
    const url = `${SITE}/widgets.html`;
    const wf = workflow(url, [
      { type: 'navigate', url },
      { type: 'agent', goal: 'Open the "Choose a plan" dropdown and select the Team plan.' },
      doneButton,
    ]);
    await leo.call('saveWorkflow', wf);
    const run = await leo.run(wf.id);
    await leo.expectDone(240_000);
    await expect(run.locator('#result')).toContainText('"plan":"team"');
  });

  test('the vision agent navigates a custom date picker', async ({ leo }) => {
    const url = `${SITE}/dates.html`;
    const wf = workflow(url, [
      { type: 'navigate', url },
      { type: 'agent', goal: 'In the calendar widget, go to next month and pick the 15th.' },
      doneButton,
    ]);
    await leo.call('saveWorkflow', wf);
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 15);
    const expected = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-15`;

    const run = await leo.run(wf.id);
    await leo.expectDone(240_000);
    await expect(run.locator('#result')).toContainText(`"picked":"${expected}"`);
  });
});
