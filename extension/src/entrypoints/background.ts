import { describeAiError, healStep } from '@/utils/ai';
import type {
  ContentMessage,
  ElementStep,
  ExecResult,
  PanelMessage,
  PanelState,
  RecState,
  RunState,
  Step,
  Workflow,
} from '@/utils/types';
import { STATE_UPDATE } from '@/utils/types';
import {
  deleteWorkflow,
  getSettings,
  getWorkflow,
  listWorkflows,
  saveWorkflow,
  setSettings,
} from '@/utils/workflows';

const REC_KEY = 'leo:rec';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export default defineBackground(() => {
  // -------------------------------------------------------------------------
  // Shared state
  // -------------------------------------------------------------------------

  // Recording state lives in storage.session so it survives MV3 service
  // worker restarts mid-recording. Run state is in-memory: a run actively
  // drives the browser, so the keepalive interval below keeps the SW alive.
  let run: RunState | null = null;
  let cancelRequested = false;
  let continueResolver: ((ok: boolean) => void) | null = null;
  // Resolves the step-failed pause with the user's choice.
  let failureResolver: ((choice: 'retry' | 'skip' | 'end') => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;

  const getRec = async (): Promise<RecState | null> => {
    const res = await browser.storage.session.get(REC_KEY);
    return (res[REC_KEY] as RecState | undefined) ?? null;
  };
  const setRec = async (rec: RecState | null): Promise<void> => {
    if (rec) await browser.storage.session.set({ [REC_KEY]: rec });
    else await browser.storage.session.remove(REC_KEY);
  };

  const broadcast = () => {
    void browser.runtime.sendMessage({ kind: STATE_UPDATE }).catch(() => {
      // no panel open
    });
  };

  const panelState = async (): Promise<PanelState> => {
    const [rec, workflows, settings] = await Promise.all([
      getRec(),
      listWorkflows(),
      getSettings(),
    ]);
    return { rec, run, workflows, hasApiKey: Boolean(settings.apiKey) };
  };

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  const runActive = () =>
    Boolean(
      run &&
        (run.status === 'running' ||
          run.status === 'waiting-user' ||
          run.status === 'step-failed'),
    );

  const startRecording = async (): Promise<{ ok: boolean; error?: string }> => {
    if (runActive()) return { ok: false, error: 'A run is in progress.' };
    // A finished run is only kept so the panel can show its result; a new
    // recording supersedes it.
    run = null;
    if (await getRec()) return { ok: false, error: 'Already recording.' };
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) {
      return { ok: false, error: 'Open a normal website tab first, then start recording.' };
    }
    await setRec({
      active: true,
      tabId: tab.id,
      startedAt: Date.now(),
      steps: [{ type: 'navigate', url: tab.url }],
      lastInteractiveAt: 0,
    });
    // Wake the content scripts. If none respond (page loaded before the
    // extension was installed), reload so the script attaches on load.
    try {
      await browser.tabs.sendMessage(tab.id, { kind: 'rec.attach' });
    } catch {
      await browser.tabs.reload(tab.id);
    }
    broadcast();
    return { ok: true };
  };

  const appendRecStep = async (step: Step, replaceLastClicks?: number) => {
    const rec = await getRec();
    if (!rec) return;
    if (replaceLastClicks && replaceLastClicks > 0) {
      const tail = rec.steps.slice(-replaceLastClicks);
      if (tail.every((s) => s.type === 'click')) {
        rec.steps.splice(-replaceLastClicks, replaceLastClicks);
      }
    }
    // Coalesce consecutive type steps on the same element (the content
    // script re-emits the full text when typing resumes after a flush).
    const last = rec.steps[rec.steps.length - 1];
    if (
      step.type === 'type' &&
      last?.type === 'type' &&
      last.target.selectors[0] === step.target.selectors[0]
    ) {
      rec.steps[rec.steps.length - 1] = step;
    } else {
      rec.steps.push(step);
    }
    if (step.type === 'click' || step.type === 'dblclick' || step.type === 'key') {
      rec.lastInteractiveAt = Date.now();
    }
    await setRec(rec);
    broadcast();
  };

  const stopRecording = async (name: string): Promise<{ ok: boolean; error?: string }> => {
    const rec = await getRec();
    if (!rec) return { ok: false, error: 'Not recording.' };
    await setRec(null);
    try {
      await browser.tabs.sendMessage(rec.tabId, { kind: 'rec.detach' });
    } catch {
      // tab closed; fine
    }
    if (rec.steps.length <= 1) {
      broadcast();
      return { ok: false, error: 'Nothing was recorded.' };
    }
    const first = rec.steps[0];
    const workflow: Workflow = {
      id: crypto.randomUUID(),
      name: name.trim() || 'Untitled workflow',
      createdAt: rec.startedAt,
      updatedAt: Date.now(),
      startUrl: first.type === 'navigate' ? first.url : '',
      steps: rec.steps,
      healCount: 0,
    };
    await saveWorkflow(workflow);
    broadcast();
    return { ok: true };
  };

  const discardRecording = async () => {
    const rec = await getRec();
    await setRec(null);
    if (rec) {
      try {
        await browser.tabs.sendMessage(rec.tabId, { kind: 'rec.detach' });
      } catch {
        // ignore
      }
    }
    broadcast();
  };

  // Classify navigations during recording. Link/form navigations are a
  // consequence of an already-recorded click, so replay only needs to wait
  // for them; typed URLs are replayed as explicit navigations.
  browser.webNavigation.onCommitted.addListener(async (details) => {
    if (details.frameId !== 0) return;
    if (!/^https?:/.test(details.url)) return;
    const rec = await getRec();
    if (!rec || details.tabId !== rec.tabId) return;

    const last = rec.steps[rec.steps.length - 1];
    if (
      (last?.type === 'navigate' && last.url === details.url) ||
      (last?.type === 'nav-wait' && last.urlHint === details.url)
    ) {
      return;
    }

    const t = details.transitionType;
    const qualifiers: string[] = (details as { transitionQualifiers?: string[] })
      .transitionQualifiers ?? [];
    const causedByPage =
      t === 'link' ||
      t === 'form_submit' ||
      qualifiers.includes('client_redirect') ||
      Date.now() - rec.lastInteractiveAt < 3_000;

    await appendRecStep(
      causedByPage
        ? { type: 'nav-wait', urlHint: details.url }
        : { type: 'navigate', url: details.url },
    );
  });

  browser.downloads?.onCreated?.addListener(async () => {
    const rec = await getRec();
    if (!rec) return;
    await appendRecStep({ type: 'download' });
  });

  // ---------------------------------------------------------------------------
  // Replay
  // ---------------------------------------------------------------------------

  const setRunStatus = (patch: Partial<RunState>) => {
    if (!run) return;
    run = { ...run, ...patch };
    broadcast();
  };

  const waitForNav = (tabId: number, timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        browser.webNavigation.onCompleted.removeListener(onCompleted);
        clearTimeout(timer);
        resolve(ok);
      };
      const onCompleted = (details: { tabId: number; frameId: number }) => {
        if (details.tabId === tabId && details.frameId === 0) finish(true);
      };
      browser.webNavigation.onCompleted.addListener(onCompleted);
      const timer = setTimeout(() => finish(false), timeoutMs);
      // The navigation may have completed before the listener attached
      // (fast pages, SPA route changes). Settle from current tab status.
      void browser.tabs
        .get(tabId)
        .then((tab) => {
          if (tab.status === 'complete') setTimeout(() => finish(true), 500);
        })
        .catch(() => finish(false));
    });

  const waitForContentReady = async (tabId: number, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await browser.tabs.sendMessage(tabId, { kind: 'replay.ping' });
        if ((res as { ok?: boolean })?.ok) return;
      } catch {
        // not injected yet
      }
      await sleep(300);
    }
    throw new Error('page never became ready');
  };

  const waitForDownload = (timeoutMs = 60_000): Promise<void> =>
    new Promise((resolve, reject) => {
      let watchedId: number | null = null;
      const cleanup = () => {
        browser.downloads.onCreated.removeListener(onCreated);
        browser.downloads.onChanged.removeListener(onChanged);
        clearTimeout(timer);
      };
      const onCreated = (item: { id: number }) => {
        watchedId = item.id;
      };
      const onChanged = (delta: { id: number; state?: { current?: string } }) => {
        if (watchedId !== null && delta.id !== watchedId) return;
        if (delta.state?.current === 'complete') {
          cleanup();
          resolve();
        }
        if (delta.state?.current === 'interrupted') {
          cleanup();
          reject(new Error('download was interrupted'));
        }
      };
      browser.downloads.onCreated.addListener(onCreated);
      browser.downloads.onChanged.addListener(onChanged);
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('timed out waiting for the download'));
      }, timeoutMs);
    });

  const execInTab = async (
    tabId: number,
    msg: unknown,
    timeoutMs = 30_000,
  ): Promise<ExecResult> => {
    // All frames receive the message; only the matching frame responds. A
    // rejected send (port closed mid-navigation, no listener yet) is treated
    // the same as no response.
    const result = await Promise.race([
      (browser.tabs.sendMessage(tabId, msg) as Promise<ExecResult | undefined>).catch(
        () => undefined,
      ),
      sleep(timeoutMs).then(() => undefined),
    ]);
    if (!result) {
      return { ok: false, error: 'no frame handled the step (frame not found or timed out)' };
    }
    return result;
  };

  // Try the deterministic path; on selector failure, ask the AI healer to
  // find the same control on the changed page, execute on its pick, and
  // patch the workflow with fresh selectors so it stays fixed.
  const execElementStep = async (
    workflow: Workflow,
    stepIndex: number,
    step: ElementStep | Extract<Step, { type: 'key' }>,
    tabId: number,
    fast: boolean,
  ): Promise<void> => {
    const result = await execInTab(tabId, { kind: 'replay.exec', step, fast });
    if (result.ok) return;
    if (!('notFound' in result) || !result.notFound) {
      throw new Error(result.error);
    }
    if (step.type === 'key' || !step.target) {
      throw new Error('element not found');
    }

    const settings = await getSettings();
    if (!settings.apiKey) {
      throw new Error(
        `element not found: ${step.target.intent}. Add an Anthropic API key in Settings to let AI repair this step.`,
      );
    }

    let verdict;
    try {
      verdict = await healStep(
        settings,
        { intent: step.target.intent, target: step.target },
        result.candidates,
        { title: result.pageTitle, url: result.pageUrl },
      );
    } catch (err) {
      throw new Error(`element not found and AI repair failed: ${describeAiError(err)}`);
    }
    if (verdict.match == null) {
      throw new Error(
        `element not found: ${step.target.intent}. AI could not find an equivalent element (${verdict.reason}).`,
      );
    }

    const healed = await execInTab(tabId, {
      kind: 'replay.execCandidate',
      index: verdict.match,
      step,
      fast,
    });
    if (!healed.ok) {
      throw new Error(`AI repair failed during execution: ${'error' in healed ? healed.error : 'unknown'}`);
    }

    if ('healedSelectors' in healed && healed.healedSelectors?.length) {
      const target = (workflow.steps[stepIndex] as ElementStep).target;
      target.selectors = [
        ...healed.healedSelectors,
        ...target.selectors.filter((s) => !healed.healedSelectors!.includes(s)),
      ].slice(0, 8);
      workflow.healCount += 1;
      workflow.updatedAt = Date.now();
      await saveWorkflow(workflow);
    }
    if (run) {
      run.healedSteps = [...run.healedSteps, stepIndex];
      broadcast();
    }
  };

  const runWorkflow = async (id: string): Promise<{ ok: boolean; error?: string }> => {
    if (runActive()) {
      return { ok: false, error: 'A run is already in progress.' };
    }
    if (await getRec()) return { ok: false, error: 'Stop recording first.' };
    const workflow = await getWorkflow(id);
    if (!workflow) return { ok: false, error: 'Workflow not found.' };

    // Speed is sampled once per run so a mid-run settings change can't leave
    // the run half verbose, half fast.
    const fast = (await getSettings()).speed === 'agent';

    const tab = await browser.tabs.create({ url: workflow.startUrl, active: true });
    if (!tab.id) return { ok: false, error: 'Could not open a tab.' };
    const tabId = tab.id;

    cancelRequested = false;
    run = {
      workflowId: workflow.id,
      workflowName: workflow.name,
      tabId,
      stepIndex: 0,
      totalSteps: workflow.steps.length,
      status: 'running',
      healedSteps: [],
    };
    broadcast();

    // MV3 service workers idle out after ~30s without events; storage reads
    // reset the idle timer for the duration of the run.
    keepalive = setInterval(() => void browser.storage.session.get(REC_KEY), 20_000);

    void (async () => {
      try {
        await waitForNav(tabId, 30_000);
        await waitForContentReady(tabId);

        for (let i = 0; i < workflow.steps.length; i++) {
          if (cancelRequested) {
            setRunStatus({ status: 'cancelled' });
            return;
          }
          const step = workflow.steps[i];
          setRunStatus({ stepIndex: i, status: 'running', error: undefined });

          try {
            await runStep(workflow, i, step, tabId);
          } catch (err) {
            if (cancelRequested) {
              setRunStatus({ status: 'cancelled' });
              return;
            }
            // Pause instead of aborting: the user decides whether to retry
            // the step, skip it, or end the run here.
            setRunStatus({
              status: 'step-failed',
              error: err instanceof Error ? err.message : String(err),
            });
            const choice = await new Promise<'retry' | 'skip' | 'end'>((resolve) => {
              failureResolver = resolve;
            });
            failureResolver = null;
            if (choice === 'end') {
              setRunStatus({ status: 'error' });
              return;
            }
            if (choice === 'retry') {
              // The for loop's i++ brings us back to the same step.
              i--;
              continue;
            }
          }
        }
        try {
          await browser.tabs.sendMessage(tabId, { kind: 'replay.cursorHide' });
        } catch {
          // ignore
        }
        setRunStatus({ status: 'done', stepIndex: workflow.steps.length });
      } catch (err) {
        setRunStatus({
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (keepalive) clearInterval(keepalive);
        keepalive = null;
      }
    })();

    return { ok: true };

    async function runStep(
      workflow: Workflow,
      i: number,
      step: Step,
      tabId: number,
    ): Promise<void> {
      switch (step.type) {
            case 'navigate': {
              // The initial navigate was consumed by tabs.create.
              if (i === 0) break;
              await browser.tabs.update(tabId, { url: step.url });
              await waitForNav(tabId, 30_000);
              await waitForContentReady(tabId);
              break;
            }
            case 'nav-wait': {
              // SPA route changes never commit a navigation; a short grace
              // window covers both cases.
              await waitForNav(tabId, 20_000);
              await waitForContentReady(tabId);
              break;
            }
            case 'download': {
              await waitForDownload();
              break;
            }
            case 'type': {
              if (step.secret) {
                await execInTab(tabId, { kind: 'replay.highlight', target: step.target });
                setRunStatus({ status: 'waiting-user' });
                const proceed = await new Promise<boolean>((resolve) => {
                  continueResolver = resolve;
                });
                continueResolver = null;
                if (!proceed) {
                  // Bubble up as a cancellation of the whole run, not just
                  // this step.
                  cancelRequested = true;
                  throw new Error('Run cancelled.');
                }
                setRunStatus({ status: 'running' });
                break;
              }
              await execElementStep(workflow, i, step, tabId, fast);
              break;
            }
            case 'click':
            case 'dblclick':
            case 'select':
            case 'key': {
              await execElementStep(workflow, i, step, tabId, fast);
              // Clicks that triggered a recorded navigation are followed by
              // a nav-wait step; give the page a beat either way.
              if (!fast) await sleep(400);
              break;
            }
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  browser.action.onClicked.addListener(async (tab) => {
    if (tab.windowId != null) {
      await (browser as unknown as {
        sidePanel?: { open: (o: { windowId: number }) => Promise<void> };
      }).sidePanel?.open?.({ windowId: tab.windowId });
    }
  });

  // Recording ends implicitly if its tab closes.
  browser.tabs.onRemoved.addListener(async (tabId) => {
    const rec = await getRec();
    if (rec && rec.tabId === tabId) {
      await setRec(null);
      broadcast();
    }
    if (run && run.tabId === tabId && runActive()) {
      cancelRequested = true;
      continueResolver?.(false);
      failureResolver?.('end');
      setRunStatus({ status: 'cancelled' });
    }
  });

  browser.runtime.onMessage.addListener(
    (msg: PanelMessage | ContentMessage, sender, sendResponse) => {
      void (async () => {
        try {
          switch (msg.kind) {
            case 'rec.step': {
              const rec = await getRec();
              if (rec && sender.tab?.id === rec.tabId) {
                await appendRecStep(msg.step, msg.replaceLastClicks);
              }
              return { ok: true };
            }
            case 'rec.isRecording': {
              const rec = await getRec();
              return { recording: Boolean(rec && sender.tab?.id === rec.tabId) };
            }
            case 'panel.getState':
              return await panelState();
            case 'panel.startRecording':
              return await startRecording();
            case 'panel.stopRecording':
              return await stopRecording(msg.name);
            case 'panel.discardRecording':
              await discardRecording();
              return { ok: true };
            case 'panel.deleteWorkflow':
              await deleteWorkflow(msg.id);
              broadcast();
              return { ok: true };
            case 'panel.renameWorkflow': {
              const wf = await getWorkflow(msg.id);
              if (wf) {
                wf.name = msg.name.trim() || wf.name;
                wf.updatedAt = Date.now();
                await saveWorkflow(wf);
                broadcast();
              }
              return { ok: true };
            }
            case 'panel.run':
              return await runWorkflow(msg.id);
            case 'panel.cancelRun': {
              cancelRequested = true;
              continueResolver?.(false);
              failureResolver?.('end');
              return { ok: true };
            }
            case 'panel.dismissRun': {
              // Only a finished run can be dismissed; an active one must be
              // cancelled first.
              if (run && !runActive()) {
                run = null;
                broadcast();
              }
              return { ok: true };
            }
            case 'panel.continueRun': {
              continueResolver?.(true);
              return { ok: true };
            }
            case 'panel.skipStep': {
              failureResolver?.('skip');
              return { ok: true };
            }
            case 'panel.retryStep': {
              failureResolver?.('retry');
              return { ok: true };
            }
            case 'panel.getSettings':
              return await getSettings();
            case 'panel.setSettings': {
              await setSettings(msg.settings);
              broadcast();
              return { ok: true };
            }
            default:
              return undefined;
          }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      })().then(sendResponse);
      return true;
    },
  );
});
