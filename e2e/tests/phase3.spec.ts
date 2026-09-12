import { randomUUID } from 'node:crypto';
import type { Workflow } from '@leo/shared';
import { SITE, describeSteps, expect, mockAi, test } from './harness';
import type { BrowserContext } from '@playwright/test';
import type { Leo } from './harness';

// Phase 3: repairs Leo makes on its own, repairs it refuses to trust, and
// taking over a step it cannot do.

// Record: open the form, type a name, submit.
const recordSignup = async (context: BrowserContext, leo: Leo): Promise<Workflow> => {
  const page = await context.newPage();
  await page.goto(`${SITE}/form.html`);
  await leo.record(page);
  await page.fill('#name', 'Ada Lovelace');
  await page.click('#submit');
  const wf = await leo.stop('Signup', 3);
  await page.close();
  return wf;
};

// Point a recorded workflow at one of the redesigned variants.
const pointAt = async (leo: Leo, wf: Workflow, variant: string) => {
  const url = `${SITE}/form.html?v=${variant}`;
  wf.startUrl = url;
  wf.steps[0] = { type: 'navigate', url };
  await leo.call('saveWorkflow', wf);
};

// Repair traffic only: naming a workflow after recording always costs one
// /api/ai/objective call, which says nothing about how a run was replayed.
const aiCalls = async () =>
  (await mockAi.log()).filter((e) => e.path === '/api/ai/heal' || e.path === '/api/ai/agent').length;

test('repairs a redesigned page on its own, without AI', async ({ context, leo }) => {
  const wf = await recordSignup(context, leo);
  await pointAt(leo, wf, '5');

  const run = await leo.run(wf.id);
  const result = await leo.expectDone();
  await expect(run.locator('#result')).toContainText('"name":"Ada Lovelace"');
  expect(await aiCalls()).toBe(0);
  expect(result.repairs).toHaveLength(1);
  expect(result.repairs[0]).toMatchObject({ index: 2, by: 'local', verified: true });
  expect(result.repairs[0].note).toContain('same text');

  // The repair was saved, so the next run needs no repair at all.
  await run.close();
  const again = await leo.run(wf.id);
  expect((await leo.expectDone()).repairs).toHaveLength(0);
  expect(await aiCalls()).toBe(0);
  await expect(again.locator('#result')).toContainText('"name":"Ada Lovelace"');
});

test('asks AI only when two controls are equally plausible', async ({ context, leo }) => {
  const wf = await recordSignup(context, leo);
  await pointAt(leo, wf, '3');
  await mockAi.queue({ heal: [{ pickText: 'Send form' }] });

  const run = await leo.run(wf.id);
  const result = await leo.expectDone();
  await expect(run.locator('#result')).toContainText('"name":"Ada Lovelace"');
  expect((await mockAi.log()).filter((e) => e.path === '/api/ai/heal')).toHaveLength(1);
  expect(result.repairs[0]).toMatchObject({ index: 2, by: 'ai', verified: true });
});

test('a repair the page ignored is reported but not saved', async ({ context, leo }) => {
  const wf = await recordSignup(context, leo);
  await pointAt(leo, wf, '4');
  await mockAi.queue({ heal: [{ pickText: 'Send form' }] });

  const run = await leo.run(wf.id);
  const result = await leo.expectDone();
  // The AI picked the dead button: the form never submitted.
  await expect(run.locator('#result')).toHaveText('');
  expect(result.repairs[0]).toMatchObject({ index: 2, by: 'ai', verified: false });

  // Nothing wrong was learned: the step keeps its recorded selectors.
  const stored = (await leo.state()).workflows.find((w) => w.id === wf.id)!;
  const click = stored.steps[2];
  expect(click.type === 'click' && click.target.selectors).toContain('#submit');
});

test('undo puts back the selectors a repair replaced', async ({ context, leo }) => {
  const wf = await recordSignup(context, leo);
  await pointAt(leo, wf, '5');
  await leo.run(wf.id);
  const repair = (await leo.expectDone()).repairs[0];
  expect(repair.after[0]).not.toBe(repair.before[0]);

  const undo = await leo.call<{ ok: boolean; error?: string }>('undoRepair', 2);
  expect(undo, undo.error).toMatchObject({ ok: true });
  const stored = (await leo.state()).workflows.find((w) => w.id === wf.id)!;
  const click = stored.steps[2];
  expect(click.type === 'click' && click.target.selectors).toEqual(repair.before);
  expect((await leo.state()).run?.repairs).toHaveLength(0);
});

test('the user can show Leo how to do a step it cannot', async ({ leo }) => {
  const now = Date.now();
  const url = `${SITE}/form.html`;
  const wf: Workflow = {
    id: randomUUID(),
    name: 'Needs help',
    createdAt: now,
    updatedAt: now,
    startUrl: url,
    healCount: 0,
    steps: [
      { type: 'navigate', url },
      {
        type: 'click',
        target: { selectors: ['#nope'], tag: 'button', text: 'Nope', intent: 'Click "Nope"', framePath: [] },
      },
    ],
  };
  await leo.call('saveWorkflow', wf);

  const run = await leo.run(wf.id);
  expect((await leo.settle()).status).toBe('step-failed');

  const started = await leo.call<{ ok: boolean; error?: string }>('teachStep');
  expect(started, started.error).toMatchObject({ ok: true });
  await expect.poll(async () => (await leo.state()).run?.status).toBe('teaching');

  // The user does it by hand while Leo watches.
  await run.fill('#name', 'Taught by hand');
  await run.click('#submit');
  await expect
    .poll(async () => (await leo.state()).run?.teachSteps?.length ?? 0)
    .toBeGreaterThanOrEqual(2);

  const saved = await leo.call<{ ok: boolean; error?: string }>('finishTeaching', true);
  expect(saved, saved.error).toMatchObject({ ok: true });
  await leo.expectDone();
  await expect(run.locator('#result')).toContainText('"name":"Taught by hand"');

  // The workflow now holds what the user did, so the next run is unattended.
  const stored = (await leo.state()).workflows.find((w) => w.id === wf.id)!;
  expect(stored.steps.map((s) => s.type), describeSteps(stored.steps)).toEqual(['navigate', 'type', 'click']);
});

// The hand-driven demo page (demo.html) rebuilds itself on every visit, and
// its whole point is that Leo copes. It is easy to break by accident, so the
// same journey a person would take by hand runs here too.
test('the demo page: a rebuild that moves everything is repaired without AI', async ({ context, leo }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/demo.html`);
  await leo.record(page);
  await page.fill('#name', 'Ada Lovelace');
  await page.fill('#email', 'ada@example.com');
  await page.click('#submit');
  const wf = await leo.stop('Demo', 4);
  await page.close();

  // Second visit: new ids and classes, labels cut loose from their fields,
  // the two fields swapped over, a sidebar pushing everything right, and
  // Submit turned into a link in the opposite corner of the card.
  const second = await leo.run(wf.id);
  const repaired = await leo.expectDone();
  await expect(second.locator('#result')).toContainText('"name":"Ada Lovelace"');
  await expect(second.locator('#result')).toContainText('"email":"ada@example.com"');
  expect(await aiCalls()).toBe(0);
  expect(repaired.repairs.map((r) => `${r.by}/${r.verified}`)).toEqual(['local/true']);
  await second.close();

  // Third visit: the control is an unlabelled icon with a random id. Nothing
  // identifies it any more, so Leo stops rather than clicking something at
  // random — and the user can show it what to do.
  const third = await leo.run(wf.id);
  expect((await leo.settle()).status).toBe('step-failed');

  const started = await leo.call<{ ok: boolean; error?: string }>('teachStep');
  expect(started, started.error).toMatchObject({ ok: true });
  await expect.poll(async () => (await leo.state()).run?.status).toBe('teaching');
  await third.click('button.icon');
  await expect.poll(async () => (await leo.state()).run?.teachSteps?.length ?? 0).toBeGreaterThanOrEqual(1);
  const saved = await leo.call<{ ok: boolean; error?: string }>('finishTeaching', true);
  expect(saved, saved.error).toMatchObject({ ok: true });
  await leo.expectDone();
  await expect(third.locator('#result')).toContainText('"name":"Ada Lovelace"');
});
