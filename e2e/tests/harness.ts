import { chromium, expect, test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeStep, type Workflow } from '@leo/shared';
import { EXTENSION_DIR } from '../global-setup';

// One line per step, for failure messages.
export const describeSteps = (steps: Workflow['steps']): string =>
  steps.map((s, i) => `  ${i}. [${s.type}] ${describeStep(s)}`).join('\n');

export const SITE = 'http://127.0.0.1:4321';
export const OTHER_SITE = 'http://localhost:4322';

// Shapes returned by the background's e2e hook (see background.ts).
export interface RunInfo {
  workflowId: string;
  tabId: number;
  stepIndex: number;
  totalSteps: number;
  status: 'running' | 'waiting-user' | 'teaching' | 'step-failed' | 'done' | 'error' | 'cancelled';
  error?: string;
  healedSteps: number[];
  repairs: {
    index: number;
    by: 'local' | 'ai' | 'agent';
    note?: string;
    verified: boolean;
    before: string[];
    after: string[];
  }[];
  teachSteps?: Workflow['steps'];
  log: { index: number; type: string; outcome: string; ms: number; error?: string; screenshot?: boolean }[];
}
export interface HookState {
  rec: { steps: Workflow['steps'] } | null;
  run: RunInfo | null;
  workflows: Workflow[];
}

type HookFn =
  | 'startRecording'
  | 'stopRecording'
  | 'discardRecording'
  | 'run'
  | 'state'
  | 'saveWorkflow'
  | 'reset'
  | 'continueRun'
  | 'retryStep'
  | 'skipStep'
  | 'cancelRun'
  | 'resumeRun'
  | 'teachStep'
  | 'finishTeaching'
  | 'undoRepair'
  | 'failureShot'
  | 'runLog';

export class Leo {
  constructor(
    readonly context: BrowserContext,
    readonly sw: Worker,
  ) {}

  call<T = unknown>(fn: HookFn, ...args: unknown[]): Promise<T> {
    return this.sw.evaluate(
      ([name, a]) =>
        (globalThis as unknown as { leoTest: Record<string, (...x: unknown[]) => unknown> }).leoTest[
          name as string
        ](...(a as unknown[])),
      [fn, args] as const,
    ) as Promise<T>;
  }

  state = () => this.call<HookState>('state');

  // Start recording on the tab showing `page`.
  async record(page: Page): Promise<void> {
    const res = await this.call<{ ok: boolean; error?: string }>('startRecording', page.url());
    expect(res, res.error).toMatchObject({ ok: true });
    await page.waitForTimeout(150); // recorder attach round-trip
  }

  // Wait until the recording holds `min` steps (messages are async), then stop.
  async stop(name = 'Test workflow', min = 2): Promise<Workflow> {
    try {
      await expect
        .poll(async () => (await this.state()).rec?.steps.length ?? 0, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(min);
    } catch {
      const steps = (await this.state()).rec?.steps ?? [];
      throw new Error(`expected at least ${min} recorded steps, got ${steps.length}:\n${describeSteps(steps)}`);
    }
    await new Promise((r) => setTimeout(r, 300)); // let trailing events land
    const res = await this.call<{ ok: boolean; error?: string; id?: string }>('stopRecording', name);
    expect(res, res.error).toMatchObject({ ok: true });
    const wf = (await this.state()).workflows.find((w) => w.id === res.id);
    expect(wf).toBeTruthy();
    return wf!;
  }

  // Start a run and return the tab it opened.
  async run(id: string): Promise<Page> {
    const pagePromise = this.context.waitForEvent('page');
    const res = await this.call<{ ok: boolean; error?: string }>('run', id);
    expect(res, res.error).toMatchObject({ ok: true });
    const page = await pagePromise;
    await page.waitForLoadState('domcontentloaded');
    return page;
  }

  // Wait for the run to reach a resting state and return it.
  async settle(timeout = 60_000): Promise<RunInfo> {
    let last: RunInfo | null = null;
    await expect
      .poll(
        async () => {
          last = (await this.state()).run;
          return last?.status;
        },
        { timeout, intervals: [250] },
      )
      .toMatch(/^(done|error|cancelled|step-failed|waiting-user)$/);
    return last!;
  }

  async expectDone(timeout?: number): Promise<RunInfo> {
    const run = await this.settle(timeout);
    expect(run.status, run.error).toBe('done');
    return run;
  }
}

// Programs the fixture server's AI mock.
export const mockAi = {
  reset: () => fetch(`${SITE}/__mock/reset`).then(() => undefined),
  queue: (body: Record<string, unknown[]>) =>
    fetch(`${SITE}/__mock/queue`, { method: 'POST', body: JSON.stringify(body) }).then(() => undefined),
  log: () => fetch(`${SITE}/__mock/log`).then((r) => r.json() as Promise<{ path: string; body: unknown }[]>),
};

export const test = base.extend<{ context: BrowserContext; leo: Leo }>({
  context: async ({}, use) => {
    const profile = mkdtempSync(join(tmpdir(), 'leo-e2e-'));
    // LEO_E2E_CHROMIUM points at a specific Chromium build when Playwright's
    // bundled one can't start on a machine (e.g. security software blocking
    // its install folder). Branded Chrome/Edge can't be used: they ignore
    // --load-extension.
    const executablePath = process.env.LEO_E2E_CHROMIUM;
    const context = await chromium.launchPersistentContext(profile, {
      ...(executablePath ? { executablePath } : { channel: 'chromium' }),
      headless: process.env.HEADED !== '1',
      viewport: { width: 1280, height: 800 },
      // Fixed locale so date inputs use mm/dd/yyyy regardless of the machine.
      locale: 'en-US',
      acceptDownloads: true,
      // --lang fixes the browser UI language, which decides the field
      // order of date inputs (the page locale alone doesn't).
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`, '--lang=en-US'],
    });
    await use(context);
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  },
  leo: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await expect
      .poll(() => sw.evaluate(() => typeof (globalThis as { leoTest?: unknown }).leoTest), { timeout: 10_000 })
      .toBe('object');
    await mockAi.reset();
    await use(new Leo(context, sw));
  },
});

export { expect };
