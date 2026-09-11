import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SITE, describeSteps, expect, test } from './harness';

// Phase 2: replay that works on sites that fight automation, waits for the
// page instead of racing it, and follows the user across tabs.

test('trusted input: a site that ignores synthetic events still works', async ({ context, leo }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/trusted.html`);
  await leo.record(page);
  await page.fill('#coupon', 'SAVE10');
  await page.click('#apply');
  await expect(page.locator('#result')).toHaveText('applied SAVE10 (typing trusted)');
  await page.fill('#q', 'receipts');
  await page.press('#q', 'Enter');
  await page.waitForURL(/nav2\.html\?q=receipts/);
  const wf = await leo.stop('Trusted', 5);

  const run = await leo.run(wf.id);
  await leo.expectDone();
  // Native Enter submitted a form that has no submit button.
  await expect(run).toHaveURL(/nav2\.html\?q=receipts/);
  const log = await leo.call<{ inputMode: string }[]>('runLog');
  expect(log[0].inputMode).toBe('native');
});

test('trusted input: the click and typing are real, not synthetic', async ({ context, leo }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/trusted.html`);
  await leo.record(page);
  await page.fill('#coupon', 'WELCOME');
  await page.click('#apply');
  const wf = await leo.stop('Coupon', 3);

  const run = await leo.run(wf.id);
  await leo.expectDone();
  await expect(run.locator('#result')).toHaveText('applied WELCOME (typing trusted)');
});

test('shadow DOM: elements inside nested open shadow roots', async ({ context, leo }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/shadow.html`);
  await leo.record(page);
  await page.locator('input[placeholder="Work email"]').fill('ops@example.eu');
  await page.locator('button#go').click();
  await expect(page.locator('#result')).toHaveText('subscribed ops@example.eu');
  const wf = await leo.stop('Subscribe', 3);
  const click = wf.steps[2];
  expect(click.type === 'click' && click.target.selectors[0]).toContain('>>>');

  const run = await leo.run(wf.id);
  await leo.expectDone();
  await expect(run.locator('#result')).toHaveText('subscribed ops@example.eu');
});

test('actionability: waits out an overlay, a disabled button, and scrolls below the fold', async ({ context, leo }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/overlay.html`);
  await page.locator('#overlay').waitFor({ state: 'detached' });
  await leo.record(page);
  await page.click('#save');
  await page.click('#confirm'); // Playwright waits for it to enable
  await page.click('#footer');
  const wf = await leo.stop('Slow page', 4);

  const run = await leo.run(wf.id);
  await leo.expectDone();
  await expect(run.locator('#result')).toHaveText('saved;confirmed;footer;');
});

test('new tab: a target=_blank link opens a tab and the workflow continues there', async ({ context, leo }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/tabs.html`);
  await leo.record(page);
  const [child] = await Promise.all([context.waitForEvent('page'), page.click('#open-tab')]);
  await child.waitForLoadState();
  await child.fill('#title', 'Q3 VAT');
  await child.click('#file');
  await expect(child.locator('#result')).toHaveText('filed Q3 VAT');
  const wf = await leo.stop('New tab', 5);
  expect(wf.steps.map((s) => s.type)).toContain('switch-tab');

  const opened: string[] = [];
  context.on('page', (p) => opened.push(p.url()));
  await leo.run(wf.id);
  await leo.expectDone();
  const reportTab = context.pages().find((p) => p.url().includes('tab-child.html') && p !== child);
  expect(reportTab).toBeTruthy();
  await expect(reportTab!.locator('#result')).toHaveText('filed Q3 VAT');
});

test('popup: a sign-in popup that closes itself returns to the opener', async ({ context, leo }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/tabs.html`);
  await leo.record(page);
  const [popup] = await Promise.all([context.waitForEvent('page'), page.click('#sso')]);
  await popup.waitForLoadState();
  await popup.fill('#user', 'marie');
  await popup.click('#approve');
  await popup.waitForEvent('close');
  await expect(page.locator('#result')).toHaveText('signed in as marie');
  await page.waitForTimeout(500);
  const wf = await leo.stop('SSO', 5);
  const types = wf.steps.map((s) => s.type);
  expect(types).toEqual(expect.arrayContaining(['switch-tab', 'close-tab']));

  const run = await leo.run(wf.id);
  await leo.expectDone();
  await expect(run.locator('#result')).toHaveText('signed in as marie');
});

test('widgets: label checkbox, custom dropdown, CJK text and a rich-text editor', async ({ context, leo }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/widgets.html`);
  await leo.record(page);
  // Click the label's text (not the box) — the browser then clicks the
  // checkbox itself, and that second click must not become a step.
  const label = (await page.locator('#terms-label').boundingBox())!;
  await page.mouse.click(label.x + label.width - 12, label.y + label.height / 2);
  await expect(page.locator('#terms')).toBeChecked();
  await page.click('.dropdown-toggle');
  await page.click('li[data-value="team"]');
  await page.fill('#name', '山田 太郎 / 김민준');
  await page.click('#editor');
  await page.keyboard.insertText('Grüße aus München');
  await page.click('#done');
  const expected = JSON.stringify({
    terms: true,
    plan: 'team',
    name: '山田 太郎 / 김민준',
    editor: 'Grüße aus München',
    file: '',
  });
  await expect(page.locator('#result')).toHaveText(expected);
  const wf = await leo.stop('Widgets', 7);
  // Clicking the label must not also record the checkbox click it causes.
  const termsClicks = wf.steps.filter((s) => s.type === 'click' && /terms/i.test(s.target.intent));
  expect(termsClicks, describeSteps(wf.steps)).toHaveLength(1);

  const run = await leo.run(wf.id);
  await leo.expectDone();
  await expect(run.locator('#result')).toHaveText(expected);
});

test('upload: replay pauses so the user picks the file, then continues', async ({ context, leo }) => {
  const file = join(tmpdir(), 'leo-invoice.pdf');
  writeFileSync(file, '%PDF-1.4 test');
  const page = await context.newPage();
  await page.goto(`${SITE}/widgets.html`);
  await leo.record(page);
  await page.setInputFiles('#file', file);
  await page.click('#done');
  const wf = await leo.stop('Upload', 3);
  expect(wf.steps.map((s) => s.type)).toContain('upload');

  const run = await leo.run(wf.id);
  const paused = await leo.settle();
  expect(paused.status).toBe('waiting-user');
  expect((await leo.state()).run).toMatchObject({ waitingFor: 'file' });
  await run.setInputFiles('#file', file);
  await leo.call('continueRun');
  await leo.expectDone();
  await expect(run.locator('#result')).toContainText('"file":"leo-invoice.pdf"');
});

test('download: waits for the file the previous click started', async ({ context, leo }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/widgets.html`);
  await leo.record(page);
  await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  await page.waitForTimeout(500);
  const wf = await leo.stop('Download', 3);
  expect(wf.steps.map((s) => s.type)).toContain('download');

  await leo.run(wf.id);
  await leo.expectDone();
});

test('resume: a stopped run continues from the step it stopped at', async ({ context, leo }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/form.html`);
  await leo.record(page);
  await page.fill('#name', 'Resumed');
  await page.fill('#password', 'pw123456');
  await page.click('#submit');
  const wf = await leo.stop('Resume', 4);

  const run = await leo.run(wf.id);
  expect((await leo.settle()).status).toBe('waiting-user');
  await leo.call('cancelRun');
  const stopped = await leo.settle();
  expect(stopped.status).toBe('cancelled');
  expect((await leo.state()).run).toMatchObject({ resumeFrom: 2 });

  const resumed = await leo.call<{ ok: boolean; error?: string }>('resumeRun');
  expect(resumed, resumed.error).toMatchObject({ ok: true });
  expect((await leo.settle()).status).toBe('waiting-user');
  await run.fill('#password', 'pw123456');
  await leo.call('continueRun');
  await leo.expectDone();
  await expect(run.locator('#result')).toContainText('"name":"Resumed"');
});

test('closing the recorded tab saves the recording instead of losing it', async ({ context, leo }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/form.html`);
  await leo.record(page);
  await page.fill('#name', 'Kept');
  await page.click('#submit');
  await expect.poll(async () => (await leo.state()).rec?.steps.length ?? 0).toBeGreaterThanOrEqual(3);
  await page.close();
  await expect.poll(async () => (await leo.state()).workflows.length).toBe(1);
  expect((await leo.state()).rec).toBeNull();
});
