import { SITE, OTHER_SITE, expect, mockAi, test } from './harness';

// Record a workflow by driving the page like a user (Playwright input is
// trusted, so the recorder captures it), then let Leo replay it in a fresh
// tab and check the page ended up in the same state.

test('form: text, select, checkbox, password, submit', async ({ context, leo }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/form.html`);
  await leo.record(page);

  await page.fill('#name', 'Ada Lovelace');
  await page.fill('#email', 'ada@example.com');
  // Pick with the keyboard like a person: Playwright's selectOption() fires
  // synthetic events, which the recorder (rightly) ignores.
  await page.focus('#country');
  await page.keyboard.press('ArrowDown'); // India
  await page.keyboard.press('ArrowDown'); // Germany
  await expect(page.locator('#country')).toHaveValue('de');
  await page.check('#terms');
  await page.fill('#password', 'hunter22');
  await page.click('#submit');
  const wf = await leo.stop('Signup', 7);

  const types = wf.steps.map((s) => s.type);
  expect(types).toEqual(['navigate', 'type', 'type', 'select', 'click', 'type', 'click']);
  const pw = wf.steps[5];
  expect(pw.type === 'type' && pw.secret && pw.text).toBe('');

  const run = await leo.run(wf.id);
  // The password step pauses for the user.
  const paused = await leo.settle();
  expect(paused.status).toBe('waiting-user');
  await run.fill('#password', 'hunter22');
  await leo.call('continueRun');

  await leo.expectDone();
  await expect(run.locator('#result')).toHaveText(
    JSON.stringify({ name: 'Ada Lovelace', email: 'ada@example.com', country: 'de', terms: true, passwordLength: 8 }),
  );
});

test('multi-page: link navigation and a GET form submit', async ({ context, leo }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/nav1.html`);
  await leo.record(page);

  await page.fill('#q', 'invoices');
  await page.press('#q', 'Enter');
  await page.waitForURL(/nav2\.html\?q=invoices/);
  await page.click('#confirm');
  const wf = await leo.stop('Search', 4);
  expect(wf.steps.map((s) => s.type)).toContain('nav-wait');

  const run = await leo.run(wf.id);
  await leo.expectDone();
  await expect(run).toHaveURL(/nav2\.html\?q=invoices/);
  await expect(run.locator('#status')).toHaveText('confirmed');
});

test('single-page app: route change and late-rendered content', async ({ context, leo }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/spa.html`);
  await leo.record(page);

  await page.click('text=Orders');
  await page.click('button[data-order="A-101"]');
  await expect(page.locator('#opened')).toHaveText('opened A-101');
  const wf = await leo.stop('Open order', 3);

  const run = await leo.run(wf.id);
  await leo.expectDone();
  await expect(run.locator('#opened')).toHaveText('opened A-101');
});

test('iframes: same-origin and cross-origin frames', async ({ context, leo }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/iframe.html`);
  await leo.record(page);

  const same = page.frameLocator('#same');
  const cross = page.frameLocator('#cross');
  await same.locator('#msg').fill('hello');
  await same.locator('#send').click();
  await cross.locator('#msg').fill('world');
  await cross.locator('#send').click();
  await expect(page.locator('#log')).toHaveText('same:hello\ncross:world');
  const wf = await leo.stop('Frames', 5);

  const run = await leo.run(wf.id);
  await leo.expectDone();
  await expect(run.locator('#log')).toHaveText('same:hello\ncross:world');
  expect(OTHER_SITE).toContain('localhost');
});

test('self-healing: a redesigned page is repaired once, then replays without AI', async ({ context, leo }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/form.html`);
  await leo.record(page);
  await page.fill('#name', 'Grace Hopper');
  await page.click('#submit');
  const wf = await leo.stop('Name only', 3);

  // Point the workflow at the redesign: every id and the button text changed.
  const redesigned = `${SITE}/form.html?v=2`;
  wf.startUrl = redesigned;
  wf.steps[0] = { type: 'navigate', url: redesigned };
  await leo.call('saveWorkflow', wf);

  // The name field kept its placeholder, so a recorded selector still finds
  // it without AI; only the button (new id, new label) needs repair.
  await mockAi.queue({ heal: [{ pickText: 'Send form' }] });
  const run = await leo.run(wf.id);
  const result = await leo.expectDone();
  expect(result.healedSteps).toEqual([2]);
  await expect(run.locator('#result')).toContainText('"name":"Grace Hopper"');
  const heals = (await mockAi.log()).filter((e) => e.path === '/api/ai/heal');
  expect(heals).toHaveLength(1);

  // Second run: the repaired selectors are saved, so no AI is needed.
  await run.close();
  const again = await leo.run(wf.id);
  const second = await leo.expectDone();
  expect(second.healedSteps).toEqual([]);
  await expect(again.locator('#result')).toContainText('"name":"Grace Hopper"');
  expect((await mockAi.log()).filter((e) => e.path === '/api/ai/heal')).toHaveLength(1);
});

test('self-healing: a low-confidence guess is not clicked; the vision agent decides', async ({ context, leo }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/form.html`);
  await leo.record(page);
  await page.fill('#name', 'Katherine');
  await page.click('#submit');
  const wf = await leo.stop('Low confidence', 3);
  const redesigned = `${SITE}/form.html?v=2`;
  wf.startUrl = redesigned;
  wf.steps[0] = { type: 'navigate', url: redesigned };
  await leo.call('saveWorkflow', wf);

  await mockAi.queue({
    heal: [{ pickText: 'Send form', confidence: 'low' }],
    agent: [
      { tools: [{ name: 'click', input: { pickText: 'Send form' } }] },
      { tools: [{ name: 'finish', input: { success: true, note: 'submitted' } }] },
    ],
  });
  const run = await leo.run(wf.id);
  await leo.expectDone();
  await expect(run.locator('#result')).toContainText('"name":"Katherine"');
  const paths = (await mockAi.log()).map((e) => e.path);
  expect(paths.filter((p) => p === '/api/ai/agent')).toHaveLength(2);
});
