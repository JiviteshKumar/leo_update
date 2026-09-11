import { expect, test } from './harness';

// A smoke test on a real public website built for testing automation tools
// (the-internet.herokuapp.com). Opt-in: LEO_E2E_REAL_SITES=1 (needs internet).

const BASE = 'https://the-internet.herokuapp.com';

test.describe('real site', () => {
  test.skip(process.env.LEO_E2E_REAL_SITES !== '1', 'set LEO_E2E_REAL_SITES=1 (needs internet)');
  test.describe.configure({ timeout: 120_000 });

  test('dynamic loading: waits for content rendered seconds later', async ({ context, leo }) => {
    const page = await context.newPage();
    await page.goto(`${BASE}/dynamic_loading/2`);
    await leo.record(page);
    await page.click('#start button');
    await page.locator('#finish h4').waitFor({ timeout: 20_000 });
    await page.click('#finish h4');
    const wf = await leo.stop('Dynamic loading', 3);

    const run = await leo.run(wf.id);
    await leo.expectDone(60_000);
    await expect(run.locator('#finish h4')).toHaveText('Hello World!');
  });

  test('hovers: a hover-only link is revealed, then followed', async ({ context, leo }) => {
    const page = await context.newPage();
    await page.goto(`${BASE}/hovers`);
    await leo.record(page);
    await page.hover('.figure >> nth=0');
    await page.click('.figure >> nth=0 >> text=View profile');
    await page.waitForURL(/\/users\/1/);
    const wf = await leo.stop('Hovers', 3);

    const run = await leo.run(wf.id);
    await leo.expectDone(60_000);
    await expect(run).toHaveURL(/\/users\/1/);
  });

  test('drag and drop: native HTML5 columns', async ({ context, leo }) => {
    const page = await context.newPage();
    await page.goto(`${BASE}/drag_and_drop`);
    await leo.record(page);
    await page.dragAndDrop('#column-a', '#column-b');
    await expect(page.locator('#column-a header')).toHaveText('B');
    const wf = await leo.stop('Swap columns', 2);

    const run = await leo.run(wf.id);
    await leo.expectDone(60_000);
    await expect(run.locator('#column-a header')).toHaveText('B');
  });

  test('checkboxes', async ({ context, leo }) => {
    const page = await context.newPage();
    await page.goto(`${BASE}/checkboxes`);
    await leo.record(page);
    await page.locator('#checkboxes input').first().click();
    await expect(page.locator('#checkboxes input').first()).toBeChecked();
    const wf = await leo.stop('Tick box', 2);

    const run = await leo.run(wf.id);
    await leo.expectDone(60_000);
    await expect(run.locator('#checkboxes input').first()).toBeChecked();
  });
});
