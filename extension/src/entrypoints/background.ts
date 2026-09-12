import {
  AiError,
  deriveObjective,
  describeAiError,
  healStep,
  runAgentStep,
  type AgentRunResult,
} from '@/utils/ai';
import { CdpTab } from '@/utils/cdp';
import { FE_URL } from '@/utils/env';
import { deleteWorkflowRemote, fetchAccount, pullWorkflows, pushWorkflow, signOutFe } from '@/utils/fe';
import { createMutex } from '@/utils/mutex';
import { mergeWorkflows, recoveryGoal, selectorsFromRecovery, validateSteps } from '@leo/shared';
import type {
  Account,
  AgentAction,
  AgentSnapshot,
  BgToContentMessage,
  Candidate,
  ContentMessage,
  DragStep,
  ElementStep,
  ExecResult,
  KeyStep,
  LocateResult,
  PanelMessage,
  PanelState,
  RecState,
  RepairRecord,
  RunLogEntry,
  RunRecord,
  RunState,
  RunStatus,
  Step,
  TargetInfo,
  Workflow,
} from '@/utils/types';
import { STATE_UPDATE } from '@/utils/types';
import {
  clearTombstone,
  deleteWorkflow,
  getSettings,
  getTombstones,
  getWorkflow,
  listWorkflows,
  mergeLocal,
  saveWorkflow,
  setSettings,
  updateWorkflow,
} from '@/utils/workflows';

const REC_KEY = 'leo:rec';
const RUN_KEY = 'leo:run';
const RUN_LOGS_KEY = 'leo:runLogs';
const UI_OPEN_KEY = 'leo:uiOpen';
const MAX_RUN_LOGS = 20;

const ACTIVE: readonly RunStatus[] = ['running', 'waiting-user', 'step-failed', 'teaching'];
// Steps that act on the page; the page gets a moment to settle after each.
const ACTING: readonly Step['type'][] = ['click', 'dblclick', 'type', 'select', 'key', 'agent', 'drag'];

// Inputs whose value is set directly rather than typed: typing into a date
// or time field's segments, or at a slider, is unreliable.
const SET_DIRECTLY = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const TIMEOUT = Symbol('timeout');
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> =>
  Promise.race([p, sleep(ms).then((): typeof TIMEOUT => TIMEOUT)]);

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// "Landed on the same page": origin + path. Query strings and hashes carry
// per-session noise (ids, timestamps) that differs from run to run.
const samePage = (a: string, b: string): boolean => {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return a === b;
  }
};

const shortUrl = (u: string): string => {
  try {
    const x = new URL(u);
    return x.host + x.pathname;
  } catch {
    return u;
  }
};

// Raised when the debugger connection drops mid-step; the step is retried
// with page-level input.
class InputLost extends Error {}

// How a paused, failed step resolves: retry it, skip it, end the run, or
// carry on past the steps the user just demonstrated.
type FailChoice = { action: 'retry' | 'skip' | 'end' } | { action: 'taught'; count: number };

// Something a step will cause that the *next* step waits for (a navigation,
// a download, a new tab). Watchers are armed before the step acts, so a
// fast event can't slip past between the action and the wait.
interface Watch<T> {
  result: Promise<T>;
  dispose(): void;
}
interface Expectation {
  nav?: Watch<void>;
  download?: Watch<void>;
  newTab?: Watch<number>;
  dispose(): void;
}
const NONE: Expectation = { dispose: () => {} };

export default defineBackground(() => {
  // -------------------------------------------------------------------------
  // Shared state
  // -------------------------------------------------------------------------

  // Recording state lives in storage.session so it survives MV3 service
  // worker restarts mid-recording. The run is mirrored there too, so a
  // restart mid-run is reported (and resumable) instead of silently lost.
  let run: RunState | null = null;
  let cancelRequested = false;
  // Aborts in-flight AI calls when the run is cancelled.
  let runAbort: AbortController | null = null;
  let continueResolver: ((ok: boolean) => void) | null = null;
  // Resolves the step-failed pause with the user's choice.
  let failureResolver: ((choice: FailChoice) => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  // JPEG data URL of the page when the current run's last step failed.
  let failureShot: string | null = null;
  // The workflow the current run is executing (its steps are patched in
  // place by repairs and by teaching).
  let activeWorkflow: Workflow | null = null;
  // Set while the user is showing Leo how to do a failed step.
  let teach: { tabId: number; stepIndex: number; steps: Step[] } | null = null;
  // Leo Cloud session, cached so the panel's poll doesn't hit fe every tick.
  let account: Account | null = null;
  let accountFetched = false;
  // Serializes read-modify-write of the recording state.
  const recLock = createMutex();
  const cdpSessions = new Map<number, CdpTab>();
  // Tabs the run closes on purpose (close-tab steps), so onRemoved doesn't
  // take them for the user closing the run tab.
  const expectedCloses = new Set<number>();

  const broadcast = () => {
    void browser.runtime.sendMessage({ kind: STATE_UPDATE }).catch(() => {
      // no panel open
    });
  };

  const panelState = async (): Promise<PanelState> => {
    const [rec, workflows] = await Promise.all([getRec(), listWorkflows()]);
    return { rec, run, workflows };
  };

  // -------------------------------------------------------------------------
  // Account + cloud sync: pull, merge (last-write-wins per workflow UUID,
  // tombstones for local deletes), then push what's newer locally.
  // -------------------------------------------------------------------------

  const refreshAccount = async (): Promise<Account | null> => {
    account = await fetchAccount();
    accountFetched = true;
    if (account) void syncWorkflows();
    return account;
  };

  let syncing = false;
  const syncWorkflows = async (): Promise<void> => {
    if (syncing) return;
    syncing = true;
    try {
      const remote = await pullWorkflows();
      if (!remote) return; // signed out or fe unreachable
      const tombstones = await getTombstones();
      const merge = await mergeLocal((local) => {
        const r = mergeWorkflows(local, remote, tombstones);
        return { next: r.changed ? r.merged : null, result: r };
      });
      if (merge.changed) broadcast();
      for (const w of merge.toPush) void pushWorkflow(w);
      for (const id of merge.toDeleteRemote) removeRemote(id);
      // Tombstones for workflows the cloud never had can go.
      const remoteIds = new Set(remote.map((w) => w.id));
      for (const id of tombstones) if (!remoteIds.has(id)) void clearTombstone(id);
    } finally {
      syncing = false;
    }
  };

  const pushIfSignedIn = (wf: Workflow) => {
    if (account) void pushWorkflow(wf);
  };

  const removeRemote = (id: string) => {
    if (!account) return;
    void deleteWorkflowRemote(id).then((ok) => {
      if (ok) void clearTombstone(id);
    });
  };

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  const getRec = async (): Promise<RecState | null> => {
    const res = await browser.storage.session.get(REC_KEY);
    const rec = res[REC_KEY] as RecState | undefined | null;
    return rec ? { ...rec, tabStack: rec.tabStack ?? [] } : null;
  };
  const setRec = async (rec: RecState | null): Promise<void> => {
    if (rec) await browser.storage.session.set({ [REC_KEY]: rec });
    else await browser.storage.session.remove(REC_KEY);
  };

  const runActive = () => Boolean(run && ACTIVE.includes(run.status));

  // Records `tabId` — the tab whose floating menu was used — falling back to
  // the active tab of the focused window.
  const startRecording = (tabId?: number) =>
    recLock(async (): Promise<{ ok: boolean; error?: string }> => {
      if (runActive()) return { ok: false, error: 'A run is in progress.' };
      if (await getRec()) return { ok: false, error: 'Already recording.' };
      // A finished run is only kept so the panel can show its result; a new
      // recording supersedes it.
      run = null;
      persistRun();
      const tab =
        tabId != null
          ? await browser.tabs.get(tabId).catch(() => undefined)
          : (await browser.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      if (tab?.id == null || !tab.url || !/^https?:/.test(tab.url)) {
        return { ok: false, error: 'Open a normal website tab first, then start recording.' };
      }
      await setRec({
        active: true,
        tabId: tab.id,
        tabStack: [],
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
    });

  // Appends a step to `rec` in place, coalescing where the recorder
  // re-emits: repeated typing into one field, repeated picks in one
  // dropdown (arrowing through options), and a double-click's clicks.
  const pushStep = (rec: RecState, step: Step, replaceLastClicks?: number) => {
    if (replaceLastClicks && replaceLastClicks > 0) {
      const tail = rec.steps.slice(-replaceLastClicks);
      if (tail.every((s) => s.type === 'click')) rec.steps.splice(-replaceLastClicks, replaceLastClicks);
    }
    const last = rec.steps[rec.steps.length - 1];
    const sameField =
      (step.type === 'type' && last?.type === 'type' && last.target.selectors[0] === step.target.selectors[0]) ||
      (step.type === 'select' && last?.type === 'select' && last.target.selectors[0] === step.target.selectors[0]);
    if (sameField) {
      rec.steps[rec.steps.length - 1] = step;
    } else {
      rec.steps.push(step);
    }
    if (step.type === 'click' || step.type === 'dblclick' || step.type === 'key') {
      rec.lastInteractiveAt = Date.now();
    }
  };

  // Move the recording into a tab the recorded page opened. Called both from
  // tabs.onCreated and from the first step that arrives out of a new tab
  // (whichever happens first), so nothing done in the moment a popup appears
  // is lost. Both callers hold the recording lock, so it runs once.
  type OpenedTab = { openerTabId?: number; pendingUrl?: string; url?: string };
  const adoptOpenedTab = async (rec: RecState, tabId: number, known?: OpenedTab): Promise<boolean> => {
    const tab = known ?? (await browser.tabs.get(tabId).catch(() => null));
    if (!tab || tab.openerTabId !== rec.tabId) return false;
    const hint = tab.pendingUrl ?? tab.url ?? '';
    pushStep(rec, { type: 'switch-tab', urlHint: /^https?:/.test(hint) ? hint : '' });
    rec.tabStack.push(rec.tabId);
    rec.tabId = tabId;
    return true;
  };

  const appendRecStep = async (step: Step, replaceLastClicks?: number, fromTabId?: number) => {
    const changed = await recLock(async () => {
      const rec = await getRec();
      if (!rec) return false;
      if (fromTabId != null && fromTabId !== rec.tabId && !(await adoptOpenedTab(rec, fromTabId))) {
        return false;
      }
      pushStep(rec, step, replaceLastClicks);
      await setRec(rec);
      return true;
    });
    if (changed) broadcast();
  };

  const detachRecorder = async (rec: RecState) => {
    for (const t of [rec.tabId, ...rec.tabStack]) {
      await browser.tabs.sendMessage(t, { kind: 'rec.detach' }).catch(() => {});
    }
  };

  const saveRecording = async (
    rec: RecState,
    name: string,
  ): Promise<{ ok: boolean; error?: string; id?: string }> => {
    if (rec.steps.length <= 1) return { ok: false, error: 'Nothing was recorded.' };
    const first = rec.steps.find((s) => s.type === 'navigate');
    const workflow: Workflow = {
      id: crypto.randomUUID(),
      name: name.trim() || 'Untitled workflow',
      createdAt: rec.startedAt,
      updatedAt: Date.now(),
      startUrl: first?.type === 'navigate' ? first.url : '',
      steps: rec.steps,
      healCount: 0,
    };
    await saveWorkflow(workflow);
    pushIfSignedIn(workflow);
    broadcast();
    // Derive a name + objective from the steps in the background — it
    // grounds the healer/agent later. Non-blocking: the save above already
    // succeeded, so the workflow is patched when (if) the summary returns.
    void deriveObjectiveFor(workflow.id, rec.steps, Boolean(name.trim()));
    return { ok: true, id: workflow.id };
  };

  const stopRecording = async (name: string): Promise<{ ok: boolean; error?: string; id?: string }> => {
    const rec = await recLock(async () => {
      const r = await getRec();
      if (r) await setRec(null);
      return r;
    });
    if (!rec) return { ok: false, error: 'Not recording.' };
    await detachRecorder(rec);
    const res = await saveRecording(rec, name);
    broadcast();
    return res;
  };

  const deriveObjectiveFor = async (id: string, steps: Step[], userNamed: boolean): Promise<void> => {
    const result = await deriveObjective(steps);
    if (!result?.objective) return;
    const saved = await updateWorkflow(id, (wf) => {
      wf.objective = result.objective;
      if (!userNamed && result.name) wf.name = result.name;
      wf.updatedAt = Date.now();
      return wf;
    });
    if (saved) {
      pushIfSignedIn(saved);
      broadcast();
    }
  };

  const discardRecording = async () => {
    const rec = await recLock(async () => {
      const r = await getRec();
      await setRec(null);
      return r;
    });
    if (rec) await detachRecorder(rec);
    broadcast();
  };

  // Classify navigations during recording. Link/form navigations are a
  // consequence of an already-recorded click, so replay only needs to wait
  // for them; typed URLs are replayed as explicit navigations.
  browser.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0 || !/^https?:/.test(details.url)) return;
    void (async () => {
      const changed = await recLock(async () => {
        const rec = await getRec();
        if (!rec || details.tabId !== rec.tabId) return false;
        const last = rec.steps[rec.steps.length - 1];
        // The first page of a tab the recorded page just opened belongs to
        // the switch-tab step, not a navigation of its own.
        if (last?.type === 'switch-tab' && (!last.urlHint || samePage(last.urlHint, details.url))) {
          last.urlHint = details.url;
          await setRec(rec);
          return false;
        }
        if (
          (last?.type === 'navigate' && last.url === details.url) ||
          (last?.type === 'nav-wait' && last.urlHint === details.url)
        ) {
          return false;
        }
        const t = details.transitionType;
        const qualifiers: string[] =
          (details as { transitionQualifiers?: string[] }).transitionQualifiers ?? [];
        const causedByPage =
          t === 'link' ||
          t === 'form_submit' ||
          qualifiers.includes('client_redirect') ||
          Date.now() - rec.lastInteractiveAt < 3_000;
        pushStep(rec, causedByPage ? { type: 'nav-wait', urlHint: details.url } : { type: 'navigate', url: details.url });
        await setRec(rec);
        return true;
      });
      if (changed) broadcast();
    })();
  });

  // (Re)attach the recorder in every frame of the recorded tab as documents
  // load. The content script also asks on its own at document_start, but a
  // tab the page just opened can load before the recording follows it.
  const attachIfRecorded = (details: { tabId: number; frameId: number }) => {
    void getRec().then((rec) => {
      if (rec && details.tabId === rec.tabId) {
        void browser.tabs
          .sendMessage(details.tabId, { kind: 'rec.attach' }, { frameId: details.frameId })
          .catch(() => {});
      }
    });
  };
  browser.webNavigation.onDOMContentLoaded.addListener(attachIfRecorded);
  browser.webNavigation.onCompleted.addListener(attachIfRecorded);

  // The recorded page opened a new tab (target=_blank, window.open): follow
  // the user into it.
  browser.tabs.onCreated.addListener((tab) => {
    if (tab.id == null || tab.openerTabId == null) return;
    const newId = tab.id;
    const opener = tab.openerTabId;
    void (async () => {
      const changed = await recLock(async () => {
        const rec = await getRec();
        if (!rec || opener !== rec.tabId) return false;
        if (!(await adoptOpenedTab(rec, newId, tab))) return false;
        await setRec(rec);
        return true;
      });
      if (!changed) return;
      broadcast();
      // If the new tab's page already asked (and was told "no"), attach now.
      await browser.tabs.sendMessage(newId, { kind: 'rec.attach' }).catch(() => {});
    })();
  });

  browser.downloads?.onCreated?.addListener(() => {
    void appendRecStep({ type: 'download' });
  });

  // -------------------------------------------------------------------------
  // Run state
  // -------------------------------------------------------------------------

  const persistRun = () => {
    void browser.storage.session.set({ [RUN_KEY]: run }).catch(() => {});
  };

  const setRunStatus = (patch: Partial<RunState>) => {
    if (!run) return;
    run = { ...run, ...patch };
    persistRun();
    broadcast();
  };

  const logStep = (
    index: number,
    type: Step['type'],
    outcome: RunLogEntry['outcome'],
    started: number,
    error?: string,
    screenshot?: boolean,
  ) => {
    if (!run) return;
    const entry: RunLogEntry = {
      index,
      type,
      outcome,
      ms: Date.now() - started,
      ...(error ? { error } : {}),
      ...(screenshot ? { screenshot } : {}),
    };
    setRunStatus({ log: [...run.log, entry] });
  };

  const saveRunRecord = async () => {
    if (!run) return;
    const record: RunRecord = {
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      startedAt: run.startedAt,
      finishedAt: Date.now(),
      status: run.status,
      error: run.error,
      inputMode: run.inputMode,
      steps: run.log,
      ...(failureShot ? { screenshot: failureShot } : {}),
    };
    const res = await browser.storage.local.get(RUN_LOGS_KEY);
    const all = [record, ...((res[RUN_LOGS_KEY] as RunRecord[] | undefined) ?? [])].slice(0, MAX_RUN_LOGS);
    await browser.storage.local.set({ [RUN_LOGS_KEY]: all });
  };

  // A service-worker restart mid-run kills the run loop. Report it and offer
  // to resume from the step it was on, instead of showing a run that never
  // progresses.
  const restoreRun = async () => {
    const res = await browser.storage.session.get(RUN_KEY);
    const raw = res[RUN_KEY] as RunState | undefined | null;
    if (!raw || run) return;
    // A run stored by an older version of Leo can be missing fields this one
    // expects; fill them in rather than handing the panel a half-built run.
    const stored: RunState = {
      ...raw,
      healedSteps: raw.healedSteps ?? [],
      repairs: raw.repairs ?? [],
      log: raw.log ?? [],
      tabStack: raw.tabStack ?? [],
    };
    if (ACTIVE.includes(stored.status)) {
      run = {
        ...stored,
        status: 'error',
        error: 'Leo was restarted by the browser during this run.',
        resumeFrom: stored.stepIndex,
        agentNote: undefined,
        waitingFor: undefined,
      };
      persistRun();
    } else {
      run = stored;
    }
    broadcast();
  };

  // -------------------------------------------------------------------------
  // Tab messaging + waiting
  // -------------------------------------------------------------------------

  // To every frame of the tab; the frame the message is for answers.
  const toFrames = async <T>(tabId: number, msg: BgToContentMessage, timeoutMs = 30_000): Promise<T | undefined> => {
    const res = await withTimeout(
      (browser.tabs.sendMessage(tabId, msg) as Promise<T | undefined>).catch(() => undefined),
      timeoutMs,
    );
    return res === TIMEOUT ? undefined : res;
  };

  const toTop = async <T>(tabId: number, msg: BgToContentMessage, timeoutMs = 30_000): Promise<T | undefined> => {
    const res = await withTimeout(
      (browser.tabs.sendMessage(tabId, msg, { frameId: 0 }) as Promise<T | undefined>).catch(() => undefined),
      timeoutMs,
    );
    return res === TIMEOUT ? undefined : res;
  };

  const execInTab = async (tabId: number, msg: BgToContentMessage): Promise<ExecResult> =>
    (await toFrames<ExecResult>(tabId, msg)) ?? {
      ok: false,
      error: 'no frame handled the step (frame not found or timed out)',
    };

  const locateInTab = async (tabId: number, msg: BgToContentMessage): Promise<LocateResult> =>
    (await toFrames<LocateResult>(tabId, msg)) ?? {
      ok: false,
      error: "the element's frame isn't on the page (or didn't respond)",
    };

  // Resolves when the tab has finished loading its current document.
  const waitForLoad = (tabId: number, timeoutMs: number): Promise<boolean> =>
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
      void browser.tabs
        .get(tabId)
        .then((tab) => {
          if (tab.status === 'complete') finish(true);
        })
        .catch(() => finish(false));
    });

  const waitForContentReady = async (tabId: number, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await toTop<{ ok?: boolean }>(tabId, { kind: 'replay.ping' }, 2_000);
      if (res?.ok) return;
      await sleep(250);
    }
    throw new Error("the page never became ready (Leo can't run on this page)");
  };

  // Wait for the page to stop changing after an action.
  // Waits for the page to go quiet; reports whether anything changed at all
  // (used to check that a repaired step really did something).
  const settle = async (tabId: number, fast: boolean): Promise<boolean> => {
    const res = await toTop<{ ok: true; changed: boolean }>(
      tabId,
      { kind: 'replay.settle', quietMs: fast ? 150 : 300, maxMs: fast ? 1_200 : 2_500 },
      4_000,
    );
    // No answer (page navigating away): assume it worked.
    return res?.changed ?? true;
  };

  const watchNavigation = (tabId: number): Watch<void> => {
    let done!: () => void;
    const result = new Promise<void>((r) => (done = r));
    const onNav = (d: { tabId: number; frameId: number }) => {
      if (d.tabId === tabId && d.frameId === 0) done();
    };
    browser.webNavigation.onCommitted.addListener(onNav);
    browser.webNavigation.onHistoryStateUpdated.addListener(onNav);
    browser.webNavigation.onReferenceFragmentUpdated.addListener(onNav);
    return {
      result,
      dispose: () => {
        browser.webNavigation.onCommitted.removeListener(onNav);
        browser.webNavigation.onHistoryStateUpdated.removeListener(onNav);
        browser.webNavigation.onReferenceFragmentUpdated.removeListener(onNav);
      },
    };
  };

  const watchDownload = (): Watch<void> => {
    let id: number | null = null;
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const result = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    result.catch(() => {}); // observed by whoever awaits it
    const onCreated = (item: { id: number; state?: string }) => {
      if (id != null) return;
      id = item.id;
      if (item.state === 'complete') resolve();
    };
    const onChanged = (delta: { id: number; state?: { current?: string } }) => {
      if (id == null || delta.id !== id) return;
      if (delta.state?.current === 'complete') resolve();
      if (delta.state?.current === 'interrupted') reject(new Error('the download was interrupted'));
    };
    browser.downloads.onCreated.addListener(onCreated);
    browser.downloads.onChanged.addListener(onChanged);
    return {
      result,
      dispose: () => {
        browser.downloads.onCreated.removeListener(onCreated);
        browser.downloads.onChanged.removeListener(onChanged);
      },
    };
  };

  const watchNewTab = (openerTabId: number): Watch<number> => {
    let done!: (id: number) => void;
    const result = new Promise<number>((r) => (done = r));
    const onCreated = (tab: { id?: number; openerTabId?: number }) => {
      if (tab.id != null && tab.openerTabId === openerTabId) done(tab.id);
    };
    browser.tabs.onCreated.addListener(onCreated);
    return { result, dispose: () => browser.tabs.onCreated.removeListener(onCreated) };
  };

  const arm = (next: Step | undefined, tabId: number): Expectation => {
    switch (next?.type) {
      case 'nav-wait': {
        const nav = watchNavigation(tabId);
        return { nav, dispose: nav.dispose };
      }
      case 'download': {
        const download = watchDownload();
        return { download, dispose: download.dispose };
      }
      case 'switch-tab': {
        const newTab = watchNewTab(tabId);
        return { newTab, dispose: newTab.dispose };
      }
      case 'close-tab':
        // The step before a close-tab usually makes the tab close itself (a
        // sign-in popup finishing). That close is expected, not the user
        // abandoning the run.
        expectedCloses.add(tabId);
        return { dispose: () => void expectedCloses.delete(tabId) };
      default:
        return NONE;
    }
  };

  const waitForTabClose = (tabId: number, timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      const onRemoved = (id: number) => {
        if (id !== tabId) return;
        cleanup();
        resolve(true);
      };
      const cleanup = () => {
        browser.tabs.onRemoved.removeListener(onRemoved);
        clearTimeout(timer);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      browser.tabs.onRemoved.addListener(onRemoved);
      void browser.tabs.get(tabId).catch(() => {
        cleanup();
        resolve(true);
      });
    });

  // -------------------------------------------------------------------------
  // Debugger (native input)
  // -------------------------------------------------------------------------

  const getCdp = async (tabId: number): Promise<CdpTab | null> => {
    if (run?.inputMode === 'compatible') return null;
    let s = cdpSessions.get(tabId);
    if (!s) {
      s = new CdpTab(tabId);
      cdpSessions.set(tabId, s);
    }
    if (s.isAttached) return s;
    return (await s.attach()) ? s : null;
  };

  const detachAll = async () => {
    for (const s of cdpSessions.values()) await s.detach();
    cdpSessions.clear();
  };

  browser.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId == null) return;
    cdpSessions.get(source.tabId)?.markDetached(reason);
    // The user dismissed Chrome's debugging bar: respect that for the rest
    // of the run.
    if (run && runActive() && reason === 'canceled_by_user') setRunStatus({ inputMode: 'compatible' });
  });

  // Debugger events (e.g. Input.dragIntercepted) go to their tab's session.
  browser.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId != null) cdpSessions.get(source.tabId)?.onEvent(method, params);
  });

  // Attach before the first step. Chrome's debugging bar resizes the
  // viewport as it appears, so let layout settle before anything measures.
  const prepareInput = async (tabId: number) => {
    if (!run || run.inputMode === 'compatible') return;
    if (!(await getCdp(tabId))) {
      setRunStatus({ inputMode: 'compatible' });
      return;
    }
    await sleep(300);
  };

  const guard = async <T>(cdp: CdpTab, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (!cdp.isAttached || /not attached|detached|cannot access/i.test(errorMessage(err))) {
        throw new InputLost(errorMessage(err));
      }
      throw err;
    }
  };

  // Screenshot of the run tab (base64 JPEG). For the vision agent it is
  // downscaled so 1 image px == 1 CSS px — candidate rects and click_at
  // coordinates then line up with the image; `maxWidth` caps it for failure
  // snapshots. Null on failure: that agent turn proceeds text-only.
  const captureTab = async (tabId: number, dpr: number, maxWidth = Infinity): Promise<string | null> => {
    let b64: string | null = null;
    const cdp = await getCdp(tabId);
    if (cdp) b64 = await cdp.screenshot();
    if (!b64) {
      try {
        const tab = await browser.tabs.get(tabId);
        if (tab.active && tab.windowId != null) {
          const url = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
          b64 = url.slice(url.indexOf(',') + 1);
        }
      } catch {
        // not capturable
      }
    }
    if (!b64) return null;
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      // 8000px is the API's hard limit; 1/dpr is the 1:1-CSS-px scale.
      const scale = Math.min(1 / (dpr || 1), 8000 / Math.max(bmp.width, bmp.height), maxWidth / bmp.width);
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(bmp, 0, 0, w, h);
      const out = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 })).arrayBuffer());
      let s = '';
      for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
      return btoa(s);
    } catch {
      return null;
    }
  };

  // -------------------------------------------------------------------------
  // Replay: element steps
  // -------------------------------------------------------------------------

  // Records a repair and saves it to the workflow — but only when the step
  // visibly did something. A repair that changes nothing on the page is
  // usually the wrong element, so it is reported without being saved.
  // Did a repaired action actually do something? Typing and dropdowns have
  // already checked their own value; a click can only be judged by the page
  // reacting, so compare a fingerprint taken just before the click (URL, text
  // length, element count, field values) with one taken after it settles. A
  // click that landed on a dead lookalike changes nothing.
  const repairWorked = async (
    step: Step,
    before: string | undefined,
    tabId: number,
    fast: boolean,
  ): Promise<boolean> => {
    if (step.type !== 'click' && step.type !== 'dblclick') return true;
    const changed = await settle(tabId, fast);
    if (!before) return changed;
    const framePath = (step as { target?: TargetInfo }).target?.framePath ?? [];
    const after = await toFrames<{ ok: true; mark: string }>(tabId, { kind: 'replay.mark', framePath }, 4_000);
    // No answer: the frame is gone, which means the click navigated.
    if (!after?.mark) return true;
    return after.mark !== before || changed;
  };

  const recordRepair = async (
    workflow: Workflow,
    i: number,
    step: Step,
    fresh: string[],
    by: RepairRecord['by'],
    note: string | undefined,
    tabId: number,
    fast: boolean,
    mark?: string,
  ) => {
    const verified = await repairWorked(step, mark, tabId, fast);
    const target = (workflow.steps[i] as { target?: TargetInfo } | undefined)?.target;
    const before = target ? [...target.selectors] : [];
    if (verified && fresh.length) await patchStepSelectors(workflow, i, fresh);
    if (!run) return;
    setRunStatus({
      healedSteps: [...run.healedSteps, i],
      repairs: [
        ...run.repairs,
        { index: i, by, note, verified, before, after: target ? [...target.selectors] : fresh },
      ],
    });
  };

  // Repair a saved workflow step with fresh selectors from a successful AI
  // fix, so the next run is deterministic. `workflow` is the run's copy.
  const patchStepSelectors = async (workflow: Workflow, i: number, fresh: string[]) => {
    const apply = (wf: Workflow): Workflow | null => {
      const t = (wf.steps[i] as { target?: TargetInfo } | undefined)?.target;
      if (!t) return null;
      t.selectors = [...fresh, ...t.selectors.filter((s) => !fresh.includes(s))].slice(0, 10);
      wf.healCount += 1;
      wf.updatedAt = Date.now();
      return wf;
    };
    apply(workflow);
    const saved = await updateWorkflow(workflow.id, apply);
    if (saved) pushIfSignedIn(saved);
  };

  // Text healer first; if it has no confident answer, the vision agent does
  // the action itself (null). Otherwise the candidate index to use.
  const askHealer = async (
    workflow: Workflow,
    i: number,
    step: ElementStep,
    nf: { candidates: Candidate[]; pageTitle: string; pageUrl: string },
  ): Promise<number | null> => {
    let verdict;
    try {
      verdict = await healStep({
        step: { intent: step.target.intent, target: step.target },
        candidates: nf.candidates,
        page: { title: nf.pageTitle, url: nf.pageUrl },
        objective: workflow.objective,
      });
    } catch (err) {
      throw new Error(`element not found: ${step.target.intent}. AI repair failed: ${describeAiError(err)}`);
    }
    // A low-confidence pick is a guess; acting on it risks clicking the
    // wrong control silently. Let the vision agent, which sees the page,
    // decide instead.
    if (verdict.match == null || verdict.confidence === 'low') {
      await recoverStepWithAgent(workflow, step, verdict.reason, i);
      return null;
    }
    return verdict.match;
  };

  // Vision-agent recovery for one failed recorded step. When the recovery
  // was a single element action, the saved step is repaired with that
  // element's fresh selectors so the next run replays deterministically.
  const recoverStepWithAgent = async (workflow: Workflow, step: ElementStep, healReason: string, i: number) => {
    let result: AgentRunResult;
    try {
      result = await runAgentStepInTab(recoveryGoal(step), workflow.objective);
    } catch (err) {
      throw new Error(
        `element not found: ${step.target.intent}. Text repair failed (${healReason}) ` +
          `and the vision agent could not complete it either: ${errorMessage(err)}`,
      );
    }
    const fresh = selectorsFromRecovery(result.performed);
    const target = (workflow.steps[i] as { target?: TargetInfo } | undefined)?.target;
    const before = target ? [...target.selectors] : [];
    if (fresh) await patchStepSelectors(workflow, i, fresh);
    if (run) {
      setRunStatus({
        healedSteps: [...run.healedSteps, i],
        repairs: [
          ...run.repairs,
          {
            index: i,
            by: 'agent',
            note: result.note,
            // The agent performed the action itself and reported success.
            verified: true,
            before,
            after: target ? [...target.selectors] : [],
          },
        ],
      });
    }
  };

  // Locate, hovering to reveal the element first when it's hidden behind a
  // hover menu (up to three levels of nested menus).
  const locateRevealing = async (
    tabId: number,
    cdp: CdpTab,
    msg: Extract<BgToContentMessage, { kind: 'replay.locate' }>,
    fast: boolean,
  ): Promise<LocateResult> => {
    let loc = await locateInTab(tabId, msg);
    for (let n = 0; n < 3; n++) {
      if (loc.ok || !('hover' in loc)) return loc;
      const at = loc.hover;
      await guard(cdp, () => cdp.move(at.x, at.y));
      await sleep(fast ? 250 : 450);
      loc = await locateInTab(tabId, { ...msg, hover: n < 2 });
    }
    return loc;
  };

  const locateError = (loc: LocateResult): string => {
    if (loc.ok) return '';
    if (loc.notFound) return 'element not found';
    if ('hover' in loc) return 'the element stayed hidden';
    return loc.error;
  };

  const performNative = async (
    tabId: number,
    step: Exclude<ElementStep, { type: 'select' }>,
    at: { x: number; y: number; inputType?: string },
    cdp: CdpTab,
    fast: boolean,
  ) => {
    const framePath = step.target.framePath;
    await toTop(tabId, { kind: 'ui.clearPoint', x: at.x, y: at.y }, 2_000);
    switch (step.type) {
      case 'click':
        await guard(cdp, () => cdp.click(at.x, at.y));
        break;
      case 'dblclick':
        await guard(cdp, () => cdp.click(at.x, at.y, 2));
        break;
      case 'type': {
        if (at.inputType && SET_DIRECTLY.has(at.inputType)) {
          await toFrames(tabId, { kind: 'replay.setValue', framePath, value: step.text });
        } else {
          await guard(cdp, () => cdp.click(at.x, at.y));
          await toFrames(tabId, { kind: 'replay.selectAll', framePath });
          if (step.text) {
            await guard(cdp, () => cdp.insertText(step.text, fast ? 0 : step.text.length > 40 ? 8 : 30));
          } else {
            await guard(cdp, () => cdp.key('Backspace'));
          }
        }
        const check = await toFrames<ExecResult>(tabId, { kind: 'replay.verify', framePath, value: step.text });
        if (check && !check.ok) {
          // Masked or framework-controlled inputs can transform typed text.
          // Set the recorded value directly, then check again.
          await toFrames(tabId, { kind: 'replay.setValue', framePath, value: step.text });
          const again = await toFrames<ExecResult>(tabId, { kind: 'replay.verify', framePath, value: step.text });
          if (again && !again.ok) throw new Error(`${step.target.intent}: ${'error' in again ? again.error : 'value mismatch'}`);
        }
        break;
      }
    }
  };

  const execElementNative = async (
    workflow: Workflow,
    i: number,
    step: Exclude<ElementStep, { type: 'select' }> | KeyStep,
    cdp: CdpTab,
    fast: boolean,
  ) => {
    const tabId = run!.tabId;
    if (step.type === 'key') {
      if (step.target) {
        const loc = await locateInTab(tabId, {
          kind: 'replay.locate',
          target: step.target,
          fast,
          timeoutMs: 3_000,
          hover: false,
        });
        if (loc.ok) await toFrames(tabId, { kind: 'replay.focus', framePath: step.target.framePath });
        // Not found: the key goes to whatever has focus — usually the field
        // typed into just before, which is where the user pressed it.
      }
      await guard(cdp, () => cdp.key(step.key, step.mods));
      return;
    }

    const loc = await locateRevealing(tabId, cdp, { kind: 'replay.locate', target: step.target, fast }, fast);
    if (loc.ok) {
      await performNative(tabId, step, loc, cdp, fast);
      // Leo recognised the element itself — no AI was needed.
      if (loc.repairedBy === 'local' && loc.healedSelectors?.length) {
        await recordRepair(workflow, i, step, loc.healedSelectors, 'local', loc.repairNote, tabId, fast, loc.mark);
      }
      return;
    }
    if (!loc.notFound) throw new Error(`${step.target.intent}: ${locateError(loc)}`);

    const index = await askHealer(workflow, i, step, loc);
    if (index == null) return; // the vision agent did the action
    const healed = await locateInTab(tabId, {
      kind: 'replay.locateCandidate',
      index,
      framePath: step.target.framePath,
      fast,
    });
    if (!healed.ok) throw new Error(`AI repair failed: ${'error' in healed ? healed.error : 'element not found'}`);
    await performNative(tabId, step, healed, cdp, fast);
    await recordRepair(workflow, i, step, healed.healedSelectors ?? [], 'ai', undefined, tabId, fast, healed.mark);
  };

  // Page-level events (debugger unavailable, and native <select>).
  const execElementCompat = async (workflow: Workflow, i: number, step: ElementStep | KeyStep, fast: boolean) => {
    const tabId = run!.tabId;
    const result = await execInTab(tabId, { kind: 'replay.exec', step, fast });
    if (result.ok) {
      if (result.repairedBy === 'local' && result.healedSelectors?.length) {
        await recordRepair(workflow, i, step, result.healedSelectors, 'local', result.repairNote, tabId, fast, result.mark);
      }
      return;
    }
    if (!('notFound' in result) || !result.notFound) throw new Error(result.error);
    if (step.type === 'key') throw new Error('element not found');

    const index = await askHealer(workflow, i, step, result);
    if (index == null) return;
    const healed = await execInTab(tabId, { kind: 'replay.execCandidate', index, step, fast });
    if (!healed.ok) {
      throw new Error(`AI repair failed during execution: ${'error' in healed ? healed.error : 'unknown'}`);
    }
    await recordRepair(workflow, i, step, healed.healedSelectors ?? [], 'ai', undefined, tabId, fast, healed.mark);
  };

  // Drags (HTML5 drag-and-drop, sortable lists, sliders) with real mouse
  // input; page-level events when the debugger isn't available.
  const execDragStep = async (step: DragStep, fast: boolean) => {
    const tabId = run!.tabId;
    const cdp = await getCdp(tabId);
    if (cdp) {
      try {
        const fromMsg = { kind: 'replay.locate' as const, target: step.from, fast, pos: step.fromPos };
        let from = await locateRevealing(tabId, cdp, fromMsg, fast);
        if (!from.ok) throw new Error(`Drag start (${step.from.intent}): ${locateError(from)}`);
        const to = await locateInTab(tabId, { kind: 'replay.locate', target: step.to, fast, pos: step.toPos, hover: false });
        if (!to.ok) throw new Error(`Drop target (${step.to.intent}): ${locateError(to)}`);
        // Bringing the drop target into view may have scrolled the page;
        // measure the start again.
        from = await locateInTab(tabId, { ...fromMsg, fast: true, hover: false });
        if (!from.ok) throw new Error(`Drag start (${step.from.intent}): ${locateError(from)}`);
        await toTop(tabId, { kind: 'ui.clearPoint', x: from.x, y: from.y }, 2_000);
        await toTop(tabId, { kind: 'ui.clearPoint', x: to.x, y: to.y }, 2_000);
        const start = from;
        await guard(cdp, () => cdp.drag(start, to, fast ? 8 : 16));
        return;
      } catch (err) {
        if (!(err instanceof InputLost)) throw err;
        setRunStatus({ inputMode: 'compatible' });
      }
    }
    const res = await execInTab(tabId, { kind: 'replay.drag', step, fast });
    if (!res.ok) throw new Error('error' in res ? res.error : 'the drag could not be performed');
  };

  const execElement = async (workflow: Workflow, i: number, step: ElementStep | KeyStep, fast: boolean) => {
    if (step.type !== 'select') {
      const cdp = await getCdp(run!.tabId);
      if (cdp) {
        try {
          await execElementNative(workflow, i, step, cdp, fast);
          return;
        } catch (err) {
          if (!(err instanceof InputLost)) throw err;
          setRunStatus({ inputMode: 'compatible' });
        }
      }
    }
    await execElementCompat(workflow, i, step, fast);
  };

  // -------------------------------------------------------------------------
  // Replay: AI agent steps
  // -------------------------------------------------------------------------

  // Hand the goal + live page (screenshot + DOM snapshot) to Claude, which
  // observes and acts until the goal is met. Throws when it can't.
  const runAgentStepInTab = async (goal: string, objective?: string): Promise<AgentRunResult> => {
    const tabId = run!.tabId;
    const observe = async (): Promise<AgentSnapshot> => {
      const snap = await toTop<AgentSnapshot>(tabId, { kind: 'agent.snapshot' });
      if (!snap) throw new Error('the page did not respond');
      return snap;
    };
    const act = async (action: AgentAction): Promise<{ ok: boolean; error?: string; healedSelectors?: string[] }> => {
      const cdp = action.kind === 'scroll' ? null : await getCdp(tabId);
      if (cdp) {
        try {
          const loc = await toTop<LocateResult>(tabId, { kind: 'agent.locate', action });
          if (!loc) return { ok: false, error: 'the page did not respond' };
          if (!loc.ok) return { ok: false, error: 'error' in loc ? loc.error : 'element not found' };
          await toTop(tabId, { kind: 'ui.clearPoint', x: loc.x, y: loc.y }, 2_000);
          if (action.kind === 'type') {
            await guard(cdp, () => cdp.click(loc.x, loc.y));
            await toTop(tabId, { kind: 'replay.selectAll', framePath: [] });
            await guard(cdp, () => cdp.insertText(action.text));
          } else if (action.kind === 'key') {
            await toTop(tabId, { kind: 'replay.focus', framePath: [] });
            await guard(cdp, () => cdp.key(action.key));
          } else {
            await guard(cdp, () => cdp.click(loc.x, loc.y));
          }
          await settle(tabId, true);
          return { ok: true, healedSelectors: loc.healedSelectors };
        } catch (err) {
          if (!(err instanceof InputLost)) return { ok: false, error: errorMessage(err) };
          setRunStatus({ inputMode: 'compatible' });
        }
      }
      const res = await toTop<ExecResult>(tabId, { kind: 'agent.act', action });
      if (!res) return { ok: false, error: 'the page did not respond' };
      return res.ok ? { ok: true, healedSelectors: res.healedSelectors } : { ok: false, error: 'error' in res ? res.error : 'failed' };
    };

    let result: AgentRunResult;
    try {
      result = await runAgentStep(
        goal,
        new Date(),
        {
          observe,
          act,
          capture: (dpr: number) => captureTab(tabId, dpr),
          onProgress: (note) => {
            if (!cancelRequested) setRunStatus({ agentNote: note });
          },
          signal: runAbort?.signal,
        },
        objective,
      );
    } catch (err) {
      if (err instanceof AiError && err.code === 'cancelled') throw new Error('Run cancelled.');
      throw new Error(`AI step failed: ${describeAiError(err)}`);
    } finally {
      setRunStatus({ agentNote: undefined });
    }
    if (!result.success) throw new Error(`AI step could not complete: ${result.note}`);
    return result;
  };

  // -------------------------------------------------------------------------
  // Replay: navigation, tabs, downloads, user input
  // -------------------------------------------------------------------------

  const navigateTo = async (tabId: number, url: string, fast: boolean) => {
    const nav = watchNavigation(tabId);
    try {
      await browser.tabs.update(tabId, { url });
      if ((await withTimeout(nav.result, 30_000)) === TIMEOUT) throw new Error(`Could not open ${shortUrl(url)}.`);
    } finally {
      nav.dispose();
    }
    await waitForContentReady(tabId);
    await settle(tabId, fast);
  };

  // The previous step should have navigated (link, form submit, redirect).
  const navWait = async (tabId: number, hint: string, armed: Watch<void> | undefined, fast: boolean) => {
    const own = armed ? null : watchNavigation(tabId);
    const w = (armed ?? own)!;
    try {
      if ((await withTimeout(w.result, armed ? 20_000 : 5_000)) === TIMEOUT) {
        // No navigation seen. Fine if we're already where recording landed
        // (e.g. the step was skipped, or the run resumed here).
        const tab = await browser.tabs.get(tabId);
        if (!(hint && tab.url && samePage(tab.url, hint))) {
          throw new Error(`The page did not navigate${hint ? ` to ${shortUrl(hint)}` : ''}.`);
        }
      }
    } finally {
      own?.dispose();
    }
    await waitForContentReady(tabId);
    await settle(tabId, fast);
  };

  const downloadWait = async (armed: Watch<void> | undefined) => {
    const own = armed ? null : watchDownload();
    const w = (armed ?? own)!;
    try {
      if ((await withTimeout(w.result, 60_000)) === TIMEOUT) throw new Error('Timed out waiting for the download.');
    } finally {
      own?.dispose();
    }
  };

  const surfaceMenu = async (tabId: number) => {
    try {
      await setUiVisible(true);
      await ensureMenuInTab(tabId);
    } catch {
      // best-effort
    }
  };

  const switchTab = async (armed: Watch<number> | undefined, fast: boolean) => {
    const opener = run!.tabId;
    let newTabId: number | null = null;
    if (armed) {
      const r = await withTimeout(armed.result, 15_000);
      if (r !== TIMEOUT) newTabId = r;
    }
    if (newTabId == null) {
      // Not armed (skipped/resumed): the newest tab this one opened.
      const opened = (await browser.tabs.query({})).filter((t) => t.openerTabId === opener && t.id != null);
      newTabId = opened[opened.length - 1]?.id ?? null;
    }
    if (newTabId == null) throw new Error('The expected new tab did not open.');
    setRunStatus({ tabId: newTabId, tabStack: [...run!.tabStack, opener] });
    await browser.tabs.update(newTabId, { active: true }).catch(() => {});
    await waitForLoad(newTabId, 30_000);
    await waitForContentReady(newTabId);
    await prepareInput(newTabId);
    void surfaceMenu(newTabId);
    await settle(newTabId, fast);
  };

  const closeTab = async (fast: boolean) => {
    const current = run!.tabId;
    const stack = [...run!.tabStack];
    const opener = stack.pop();
    if (opener == null) throw new Error('There is no previous tab to return to.');
    expectedCloses.add(current);
    // Popups usually close themselves (sign-in done); otherwise close it,
    // as the user did while recording.
    if (!(await waitForTabClose(current, 5_000))) await browser.tabs.remove(current).catch(() => {});
    await cdpSessions.get(current)?.detach();
    cdpSessions.delete(current);
    setRunStatus({ tabId: opener, tabStack: stack });
    await browser.tabs.update(opener, { active: true }).catch(() => {});
    await waitForContentReady(opener);
    await prepareInput(opener);
    await settle(opener, fast);
  };

  // Secrets and files are never stored: pause while the user provides them.
  const waitForUser = async (tabId: number, target: TargetInfo, what: 'password' | 'file') => {
    await execInTab(tabId, { kind: 'replay.highlight', target });
    setRunStatus({ status: 'waiting-user', waitingFor: what });
    const proceed = await new Promise<boolean>((resolve) => {
      continueResolver = resolve;
    });
    continueResolver = null;
    if (!proceed) {
      cancelRequested = true;
      throw new Error('Run cancelled.');
    }
    setRunStatus({ status: 'running', waitingFor: undefined });
  };

  // -------------------------------------------------------------------------
  // Replay: the run loop
  // -------------------------------------------------------------------------

  const runStep = async (
    workflow: Workflow,
    i: number,
    step: Step,
    pending: Expectation,
    freshTab: boolean,
    fast: boolean,
  ): Promise<void> => {
    const tabId = run!.tabId;
    switch (step.type) {
      case 'navigate':
        // The first navigate was consumed by opening the run tab there.
        if (i === 0 && freshTab) break;
        await navigateTo(tabId, step.url, fast);
        break;
      case 'nav-wait':
        await navWait(tabId, step.urlHint, pending.nav, fast);
        break;
      case 'download':
        await downloadWait(pending.download);
        break;
      case 'switch-tab':
        await switchTab(pending.newTab, fast);
        break;
      case 'close-tab':
        await closeTab(fast);
        break;
      case 'upload':
        await waitForUser(tabId, step.target, 'file');
        break;
      case 'type':
        if (step.secret) await waitForUser(tabId, step.target, 'password');
        else await execElement(workflow, i, step, fast);
        break;
      case 'click':
      case 'dblclick':
      case 'select':
      case 'key':
        await execElement(workflow, i, step, fast);
        break;
      case 'agent':
        await runAgentStepInTab(step.goal, workflow.objective);
        break;
      case 'drag':
        await execDragStep(step, fast);
        break;
    }
    if (ACTING.includes(step.type)) await settle(run!.tabId, fast);
  };

  const stopRun = (status: 'cancelled' | 'error', at: number, error?: string) =>
    setRunStatus({ status, resumeFrom: at, agentNote: undefined, waitingFor: undefined, ...(error ? { error } : {}) });

  const execute = async (workflow: Workflow, from: number, freshTab: boolean, fast: boolean) => {
    let pending: Expectation = NONE;
    activeWorkflow = workflow;
    try {
      const firstTab = run!.tabId;
      if (freshTab) await waitForLoad(firstTab, 30_000);
      await waitForContentReady(firstTab);
      // Surface the floating menu on the run tab so progress + End run are
      // reachable there (best-effort).
      void surfaceMenu(firstTab);
      await prepareInput(firstTab);

      for (let i = from; i < workflow.steps.length; i++) {
        if (cancelRequested) {
          stopRun('cancelled', i);
          return;
        }
        const step = workflow.steps[i];
        setRunStatus({ stepIndex: i, status: 'running', error: undefined, waitingFor: undefined });
        const started = Date.now();
        const healedBefore = run!.healedSteps.length;
        const armed = arm(workflow.steps[i + 1], run!.tabId);
        try {
          await runStep(workflow, i, step, pending, freshTab, fast);
          pending.dispose();
          pending = armed;
          logStep(i, step.type, run!.healedSteps.length > healedBefore ? 'healed' : 'ok', started);
        } catch (err) {
          armed.dispose();
          if (cancelRequested) {
            stopRun('cancelled', i);
            return;
          }
          const message = errorMessage(err);
          // What the page looked like when the step failed.
          const shot = await captureTab(run!.tabId, 1, 960).catch(() => null);
          failureShot = shot ? `data:image/jpeg;base64,${shot}` : null;
          logStep(i, step.type, 'failed', started, message, Boolean(shot));
          // Pause instead of aborting: the user decides whether to retry
          // the step, skip it, or end the run here.
          setRunStatus({ status: 'step-failed', error: message, agentNote: undefined });
          const choice = await new Promise<FailChoice>((resolve) => {
            failureResolver = resolve;
          });
          failureResolver = null;
          if (choice.action === 'end') {
            stopRun(cancelRequested ? 'cancelled' : 'error', i, message);
            return;
          }
          if (choice.action === 'taught') {
            // The user just performed these steps in the page, so they are
            // done: log them and carry on with the step after them.
            for (let n = 0; n < choice.count; n++) {
              logStep(i + n, workflow.steps[i + n].type, 'taught', started);
            }
            i += choice.count - 1;
            pending.dispose();
            pending = NONE;
            continue;
          }
          if (choice.action === 'retry') {
            // The loop's i++ brings us back to the same step.
            i--;
            continue;
          }
          logStep(i, step.type, 'skipped', Date.now());
          pending.dispose();
          pending = NONE;
        }
      }
      await toFrames(run!.tabId, { kind: 'replay.cursorHide' }, 2_000);
      setRunStatus({ status: 'done', stepIndex: workflow.steps.length, error: undefined, resumeFrom: undefined });
    } catch (err) {
      setRunStatus({ status: 'error', error: errorMessage(err) });
    } finally {
      pending.dispose();
      if (keepalive) clearInterval(keepalive);
      keepalive = null;
      activeWorkflow = null;
      teach = null;
      await detachAll();
      await saveRunRecord().catch(() => {});
    }
  };

  const runWorkflow = async (
    id: string,
    opts: { fromStep?: number; tabId?: number; tabStack?: number[] } = {},
  ): Promise<{ ok: boolean; error?: string }> => {
    if (runActive()) return { ok: false, error: 'A run is already in progress.' };
    if (await getRec()) return { ok: false, error: 'Stop recording first.' };
    const workflow = await getWorkflow(id);
    if (!workflow) return { ok: false, error: 'Workflow not found.' };
    const firstNav = workflow.steps.find((s) => s.type === 'navigate');
    const startUrl = workflow.startUrl || (firstNav?.type === 'navigate' ? firstNav.url : '');
    const from = Math.min(Math.max(0, opts.fromStep ?? 0), workflow.steps.length);
    // Speed is sampled once per run so a mid-run settings change can't leave
    // the run half verbose, half fast.
    const fast = (await getSettings()).speed === 'agent';

    let tabId: number;
    let freshTab = false;
    if (opts.tabId != null) {
      const tab = await browser.tabs.get(opts.tabId).catch(() => null);
      if (tab?.id == null) {
        return { ok: false, error: "The run's tab was closed, so it can't resume. Run it again from the start." };
      }
      tabId = tab.id;
      await browser.tabs.update(tabId, { active: true }).catch(() => {});
    } else {
      if (!startUrl) return { ok: false, error: 'This workflow has no start page.' };
      const tab = await browser.tabs.create({ url: startUrl, active: true });
      if (tab.id == null) return { ok: false, error: 'Could not open a tab.' };
      tabId = tab.id;
      freshTab = true;
    }

    cancelRequested = false;
    runAbort = new AbortController();
    failureShot = null;
    run = {
      workflowId: workflow.id,
      workflowName: workflow.name,
      tabId,
      tabStack: opts.tabStack ?? [],
      stepIndex: from,
      totalSteps: workflow.steps.length,
      status: 'running',
      healedSteps: [],
      repairs: [],
      inputMode: 'native',
      startedAt: Date.now(),
      log: [],
    };
    persistRun();
    broadcast();

    // MV3 service workers idle out after ~30s without events; storage reads
    // reset the idle timer for the duration of the run.
    keepalive = setInterval(() => void browser.storage.session.get(REC_KEY), 20_000);
    void execute(workflow, from, freshTab, fast);
    return { ok: true };
  };

  const cancelRun = () => {
    cancelRequested = true;
    runAbort?.abort();
    continueResolver?.(false);
    failureResolver?.({ action: 'end' });
  };

  // -------------------------------------------------------------------------
  // "Show me": the user performs the step Leo could not, Leo watches, and
  // that step is replaced by what they did.
  // -------------------------------------------------------------------------

  const startTeaching = async (): Promise<{ ok: boolean; error?: string }> => {
    if (!run || run.status !== 'step-failed' || !activeWorkflow) {
      return { ok: false, error: 'There is no failed step to take over.' };
    }
    teach = { tabId: run.tabId, stepIndex: run.stepIndex, steps: [] };
    setRunStatus({ status: 'teaching', teachSteps: [] });
    await browser.tabs.sendMessage(run.tabId, { kind: 'rec.attach' }).catch(() => {});
    return { ok: true };
  };

  const pushTeachStep = (step: Step, replaceLastClicks?: number) => {
    if (!teach) return;
    const holder: RecState = {
      active: true,
      tabId: teach.tabId,
      tabStack: [],
      startedAt: 0,
      steps: teach.steps,
      lastInteractiveAt: 0,
    };
    pushStep(holder, step, replaceLastClicks);
    teach.steps = holder.steps;
    setRunStatus({ teachSteps: [...teach.steps] });
  };

  const finishTeaching = async (save: boolean): Promise<{ ok: boolean; error?: string }> => {
    if (!teach) return { ok: false, error: 'Leo is not watching right now.' };
    const { tabId, stepIndex, steps } = teach;
    const workflow = activeWorkflow;
    if (!save || steps.length === 0) {
      teach = null;
      await browser.tabs.sendMessage(tabId, { kind: 'rec.detach' }).catch(() => {});
      setRunStatus({ status: 'step-failed', teachSteps: undefined });
      return save ? { ok: false, error: 'Nothing was recorded yet: do the step in the page first.' } : { ok: true };
    }
    if (!workflow) return { ok: false, error: 'The run has ended.' };
    teach = null;
    await browser.tabs.sendMessage(tabId, { kind: 'rec.detach' }).catch(() => {});

    // Replace the failed step with what the user did, both in the copy this
    // run is executing and in storage, so the next run does it by itself.
    workflow.steps.splice(stepIndex, 1, ...steps);
    const saved = await updateWorkflow(workflow.id, (stored) => {
      stored.steps = structuredClone(workflow.steps);
      stored.updatedAt = Date.now();
      return stored;
    });
    if (saved) pushIfSignedIn(saved);
    setRunStatus({
      status: 'running',
      error: undefined,
      teachSteps: undefined,
      totalSteps: workflow.steps.length,
    });
    failureResolver?.({ action: 'taught', count: steps.length });
    return { ok: true };
  };

  // Put a repaired step back to the selectors it had before.
  const undoRepair = async (index: number): Promise<{ ok: boolean; error?: string }> => {
    if (!run) return { ok: false, error: 'There is no run to undo.' };
    const repair = [...run.repairs].reverse().find((r) => r.index === index && r.verified);
    if (!repair) return { ok: false, error: 'That step has no saved repair.' };
    const saved = await updateWorkflow(run.workflowId, (stored) => {
      const target = (stored.steps[index] as { target?: TargetInfo } | undefined)?.target;
      if (!target) return null;
      target.selectors = [...repair.before];
      stored.healCount = Math.max(0, stored.healCount - 1);
      stored.updatedAt = Date.now();
      return stored;
    });
    if (!saved) return { ok: false, error: 'That step is gone.' };
    const live = (activeWorkflow?.steps[index] as { target?: TargetInfo } | undefined)?.target;
    if (live && activeWorkflow?.id === run.workflowId) live.selectors = [...repair.before];
    pushIfSignedIn(saved);
    setRunStatus({
      repairs: run.repairs.filter((r) => r !== repair),
      healedSteps: run.healedSteps.filter((h) => h !== index),
    });
    return { ok: true };
  };

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  // Session pickup: re-read the fe session on any top-frame navigation to the
  // fe origin so the extension reflects sign-in/out without manual refresh.
  const onFeNavigation = (details: { frameId: number }) => {
    if (details.frameId !== 0) return;
    void refreshAccount().then(broadcast);
  };
  const feFilter = { url: [{ urlPrefix: FE_URL }] };
  browser.webNavigation.onCompleted.addListener(onFeNavigation, feFilter);
  browser.webNavigation.onHistoryStateUpdated.addListener(onFeNavigation, feFilter);

  // Visibility is a single global flag in storage.local; every floating-menu
  // content script watches it.
  const setUiVisible = (visible: boolean) => browser.storage.local.set({ [UI_OPEN_KEY]: visible });

  // Make sure a tab has a menu to react to the flag: tabs opened before the
  // extension loaded have no content script.
  const ensureMenuInTab = async (tabId: number) => {
    try {
      await browser.tabs.sendMessage(tabId, { kind: 'ui.ping' });
    } catch {
      try {
        await browser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/leo-ui.js'] });
      } catch {
        // Restricted page (chrome://, web store, …) — nothing to inject into.
      }
    }
  };

  // Toolbar icon: toggle the floating menu.
  browser.action.onClicked.addListener((tab) => {
    void (async () => {
      const res = await browser.storage.local.get(UI_OPEN_KEY);
      const next = !res[UI_OPEN_KEY];
      await setUiVisible(next);
      if (next && tab.id != null) await ensureMenuInTab(tab.id);
    })();
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    cdpSessions.delete(tabId);

    // Recording follows the user back to the opener when a tab closes;
    // closing the only recorded tab saves what was recorded so far.
    void (async () => {
      const outcome = await recLock(async (): Promise<{ changed: boolean; autosave?: RecState }> => {
        const rec = await getRec();
        if (!rec) return { changed: false };
        if (rec.tabId === tabId) {
          const opener = rec.tabStack.pop();
          if (opener != null) {
            pushStep(rec, { type: 'close-tab' });
            rec.tabId = opener;
            await setRec(rec);
            return { changed: true };
          }
          await setRec(null);
          return { changed: true, autosave: rec };
        }
        if (rec.tabStack.includes(tabId)) {
          rec.tabStack = rec.tabStack.filter((t) => t !== tabId);
          await setRec(rec);
        }
        return { changed: false };
      });
      if (outcome.autosave) await saveRecording(outcome.autosave, '');
      if (outcome.changed) broadcast();
    })();

    if (expectedCloses.delete(tabId)) return;
    if (run && runActive() && run.tabId === tabId) {
      cancelRun();
      setRunStatus({ status: 'cancelled', error: 'The run tab was closed.' });
    }
  });

  browser.runtime.onMessage.addListener((msg: PanelMessage | ContentMessage, sender, sendResponse) => {
    void (async () => {
      try {
        switch (msg.kind) {
          case 'rec.step':
            // While teaching, what the user does goes into the step being
            // replaced rather than into a recording.
            if (teach && sender.tab?.id === teach.tabId) pushTeachStep(msg.step, msg.replaceLastClicks);
            else await appendRecStep(msg.step, msg.replaceLastClicks, sender.tab?.id);
            return { ok: true };
          case 'rec.isRecording': {
            const rec = await getRec();
            const watching =
              Boolean(rec && sender.tab?.id === rec.tabId) || Boolean(teach && sender.tab?.id === teach.tabId);
            return { recording: watching };
          }
          case 'panel.getState':
            return await panelState();
          case 'panel.startRecording':
            return await startRecording(sender.tab?.id);
          case 'panel.stopRecording':
            return await stopRecording(msg.name);
          case 'panel.discardRecording':
            await discardRecording();
            return { ok: true };
          case 'panel.deleteWorkflow':
            await deleteWorkflow(msg.id);
            removeRemote(msg.id);
            broadcast();
            return { ok: true };
          case 'panel.renameWorkflow': {
            const name = msg.name.trim();
            if (!name) return { ok: false, error: 'Name cannot be empty.' };
            const saved = await updateWorkflow(msg.id, (wf) => ({ ...wf, name, updatedAt: Date.now() }));
            if (saved) pushIfSignedIn(saved);
            broadcast();
            return { ok: true };
          }
          case 'panel.updateWorkflowSteps': {
            const steps = validateSteps(msg.steps);
            if (!steps.ok) {
              return {
                ok: false,
                error: steps.error.includes('goal') ? 'Every AI instruction needs a description.' : steps.error,
              };
            }
            const saved = await updateWorkflow(msg.id, (wf) => ({ ...wf, steps: steps.value, updatedAt: Date.now() }));
            if (saved) pushIfSignedIn(saved);
            broadcast();
            return { ok: true };
          }
          case 'panel.run':
            return await runWorkflow(msg.id);
          case 'panel.resumeRun': {
            if (!run || runActive() || run.resumeFrom == null) return { ok: false, error: 'Nothing to resume.' };
            return await runWorkflow(run.workflowId, {
              fromStep: run.resumeFrom,
              tabId: run.tabId,
              tabStack: run.tabStack,
            });
          }
          case 'panel.cancelRun':
            cancelRun();
            return { ok: true };
          case 'panel.getFailureShot':
            return { dataUrl: failureShot };
          case 'panel.dismissRun':
            // Only a finished run can be dismissed; an active one must be
            // cancelled first.
            if (run && !runActive()) {
              run = null;
              persistRun();
              broadcast();
            }
            return { ok: true };
          case 'panel.continueRun':
            continueResolver?.(true);
            return { ok: true };
          case 'panel.skipStep':
            failureResolver?.({ action: 'skip' });
            return { ok: true };
          case 'panel.retryStep':
            failureResolver?.({ action: 'retry' });
            return { ok: true };
          case 'panel.teachStep':
            return await startTeaching();
          case 'panel.finishTeaching':
            return await finishTeaching(msg.save);
          case 'panel.undoRepair':
            return await undoRepair(msg.index);
          case 'panel.getAccount':
            if (msg.refresh || !accountFetched) await refreshAccount();
            return { account };
          case 'panel.signIn':
            await browser.tabs.create({ url: `${FE_URL}/?from=extension`, active: true });
            return { ok: true };
          case 'panel.signOut':
            await signOutFe();
            await refreshAccount();
            broadcast();
            return { ok: true };
          case 'panel.getSettings':
            return await getSettings();
          case 'panel.setSettings':
            await setSettings(msg.settings);
            broadcast();
            return { ok: true };
          default:
            return undefined;
        }
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    })().then(sendResponse);
    return true;
  });

  // ---------------------------------------------------------------------------
  // E2E hook. Only in builds made with WXT_LEO_E2E=true (the e2e suite); the
  // condition is a build-time constant, so production bundles drop it.
  // ---------------------------------------------------------------------------

  if (import.meta.env.WXT_LEO_E2E === 'true') {
    Object.assign(globalThis, {
      leoTest: {
        startRecording: async (url: string) => {
          const tab = (await browser.tabs.query({})).find((t) => t.url === url);
          if (tab?.id == null) return { ok: false, error: `no tab at ${url}` };
          return startRecording(tab.id);
        },
        stopRecording: (name: string) => stopRecording(name),
        discardRecording: async () => {
          await discardRecording();
          return { ok: true };
        },
        run: (id: string) => runWorkflow(id),
        resumeRun: () =>
          run && run.resumeFrom != null
            ? runWorkflow(run.workflowId, { fromStep: run.resumeFrom, tabId: run.tabId, tabStack: run.tabStack })
            : { ok: false, error: 'Nothing to resume.' },
        state: () => panelState(),
        saveWorkflow: async (wf: Workflow) => {
          await saveWorkflow(wf);
          return { ok: true };
        },
        continueRun: () => void continueResolver?.(true),
        retryStep: () => void failureResolver?.({ action: 'retry' }),
        skipStep: () => void failureResolver?.({ action: 'skip' }),
        teachStep: () => startTeaching(),
        finishTeaching: (save: boolean) => finishTeaching(save),
        undoRepair: (index: number) => undoRepair(index),
        cancelRun: () => cancelRun(),
        failureShot: () => failureShot,
        runLog: async () => (await browser.storage.local.get(RUN_LOGS_KEY))[RUN_LOGS_KEY] ?? [],
      },
    });
  }

  // Check the session (and pull the cloud copy if signed in) every time the
  // service worker wakes, so another device's changes appear without any
  // user action.
  void refreshAccount();
  void restoreRun();
});
