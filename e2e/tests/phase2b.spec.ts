import { randomUUID } from 'node:crypto';
import type { Workflow } from '@leo/shared';
import { SITE, describeSteps, expect, test } from './harness';

// Phase 2, continued: hover-only menus, drag and drop, date inputs, and a
// screenshot when a step fails.

test('hover menus: CSS and JS menus are revealed before their items are clicked', async ({ context, leo }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/hover.html`);
  await leo.record(page);
  await page.hover('#reports');
  await page.click('#vat');
  await page.hover('#account');
  await page.click('#signout');
  await expect(page.locator('#result')).toHaveText('vat;signout;');
  const wf = await leo.stop('Hover menus', 3);

  const run = await leo.run(wf.id);
  await leo.expectDone();
  await expect(run.locator('#result')).toHaveText('vat;signout;');
});

test('drag and drop: an HTML5 kanban card, a pointer-sorted list and a slider', async ({ context, leo }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/drag.html`);
  await leo.record(page);

  await page.dragAndDrop('#card-1', '#done');

  const alpha = (await page.locator('li[data-id="alpha"]').boundingBox())!;
  const gamma = (await page.locator('li[data-id="gamma"]').boundingBox())!;
  await page.mouse.move(alpha.x + alpha.width / 2, alpha.y + alpha.height / 2);
  await page.mouse.down();
  await page.mouse.move(gamma.x + gamma.width / 2, gamma.y + gamma.height * 0.8, { steps: 12 });
  await page.mouse.up();

  const vol = (await page.locator('#vol').boundingBox())!;
  await page.mouse.move(vol.x + 4, vol.y + vol.height / 2);
  await page.mouse.down();
  await page.mouse.move(vol.x + vol.width * 0.7, vol.y + vol.height / 2, { steps: 10 });
  await page.mouse.up();

  await page.click('#report');
  const recorded = (await page.locator('#result').textContent())!;
  const state = JSON.parse(recorded) as { done: string[]; order: string[]; volume: number };
  expect(state.done).toEqual(['card-1']);
  expect(state.order).toEqual(['beta', 'gamma', 'alpha']);
  expect(state.volume).toBeGreaterThan(50);

  const wf = await leo.stop('Drags', 5);
  expect(wf.steps.filter((s) => s.type === 'drag'), describeSteps(wf.steps)).toHaveLength(3);
  expect(wf.steps.filter((s) => s.type === 'click'), describeSteps(wf.steps)).toHaveLength(1);

  const run = await leo.run(wf.id);
  await leo.expectDone();
  await expect(run.locator('#result')).toHaveText(recorded);
});

test('date input: a typed date replays reliably', async ({ context, leo }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/dates.html`);
  await leo.record(page);
  // A date field's segment order follows the OS date format (mm/dd on most
  // Linux CI, dd/mm here), so try both, like a person would. Focusing lands
  // on the first segment; repeated typing into one field records as one step.
  for (const keys of ['10152026', '15102026']) {
    await page.locator('#due').evaluate((el) => (el as HTMLElement).blur());
    await page.focus('#due');
    await page.keyboard.type(keys);
    if ((await page.inputValue('#due')) === '2026-10-15') break;
  }
  await expect(page.locator('#due')).toHaveValue('2026-10-15');
  await page.click('#done');
  const wf = await leo.stop('Due date', 3);
  expect(wf.steps.some((s) => s.type === 'type' && s.text === '2026-10-15'), describeSteps(wf.steps)).toBe(true);

  const run = await leo.run(wf.id);
  await leo.expectDone();
  await expect(run.locator('#result')).toContainText('"due":"2026-10-15"');
});

test('a failed step keeps a screenshot of the page', async ({ leo }) => {
  const now = Date.now();
  const wf: Workflow = {
    id: randomUUID(),
    name: 'Broken',
    createdAt: now,
    updatedAt: now,
    startUrl: `${SITE}/form.html`,
    healCount: 0,
    steps: [
      { type: 'navigate', url: `${SITE}/form.html` },
      {
        type: 'click',
        target: { selectors: ['#does-not-exist'], tag: 'button', text: 'Nope', intent: 'Click "Nope"', framePath: [] },
      },
    ],
  };
  await leo.call('saveWorkflow', wf);
  await leo.run(wf.id);
  const failed = await leo.settle();
  expect(failed.status).toBe('step-failed');
  const shot = await leo.call<string | null>('failureShot');
  expect(shot).toMatch(/^data:image\/jpeg;base64,/);
  expect(shot!.length).toBeGreaterThan(2_000);
  const state = await leo.state();
  expect(state.run!.log).toContainEqual(expect.objectContaining({ outcome: 'failed', screenshot: true }));
  await leo.call('cancelRun');
});
