import { useCallback, useEffect, useState } from 'react';
import type {
  Account,
  PanelMessage,
  PanelState,
  Settings,
  Step,
  Workflow,
} from '@/utils/types';
import { DEFAULT_CURSOR_COLOR, DEFAULT_SPEED, STATE_UPDATE, describeStep } from '@/utils/types';

const CURSOR_PRESETS = ['#4c8bf5', '#f5b301', '#e5484d', '#46a758', '#a855f7'];

type View = 'new' | 'saved' | 'settings';

const send = <T,>(msg: PanelMessage): Promise<T> => {
  // After the extension reloads, this content script is orphaned and
  // runtime.sendMessage throws *synchronously* ("Extension context
  // invalidated") — so a .catch() on the result wouldn't help. Swallow it and
  // return a promise that never settles; the stale menu gets torn down by the
  // content script's onInvalidated handler.
  try {
    if (!browser.runtime?.id) return new Promise<T>(() => {});
    return browser.runtime.sendMessage(msg) as Promise<T>;
  } catch {
    return new Promise<T>(() => {});
  }
};

const stepLabel = (step: Step): string => describeStep(step);

export function App() {
  const [state, setState] = useState<PanelState | null>(null);
  const [view, setView] = useState<View>('new');
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Step editor: id of the workflow whose steps are open, and the working copy.
  const [editingStepsId, setEditingStepsId] = useState<string | null>(null);
  const [draftSteps, setDraftSteps] = useState<Step[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  // undefined = not checked yet, null = checked and signed out.
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [settings, setSettingsState] = useState<Settings>({
    cursorColor: DEFAULT_CURSOR_COLOR,
    speed: DEFAULT_SPEED,
  });

  const refresh = useCallback(() => {
    void send<PanelState>({ kind: 'panel.getState' }).then(setState).catch(() => {});
    // Served from the background's cache; only sign-in/out refetches.
    void send<{ account: Account | null }>({ kind: 'panel.getAccount' })
      .then((res) => setAccount(res.account))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const onMessage = (msg: { kind?: string }) => {
      if (msg?.kind === STATE_UPDATE) refresh();
    };
    browser.runtime.onMessage.addListener(onMessage);
    const poll = setInterval(() => {
      // Stop polling once this content script is orphaned by a reload.
      if (!browser.runtime?.id) {
        clearInterval(poll);
        return;
      }
      refresh();
    }, 1500);
    void send<Settings>({ kind: 'panel.getSettings' }).then(setSettingsState).catch(() => {});
    return () => {
      clearInterval(poll);
      try {
        browser.runtime.onMessage.removeListener(onMessage);
      } catch {
        // context already invalidated
      }
    };
  }, [refresh]);

  const showError = (error?: string) => {
    if (!error) return;
    setFlash(error);
    setTimeout(() => setFlash(null), 5000);
  };

  // account === undefined means the first session check hasn't answered yet;
  // show a brief loading state instead of flashing the sign-in gate.
  if (!state || account === undefined) {
    return (
      <div className="shell">
        <header className="header"><span className="brand">Leo</span></header>
        <p className="hint">Loading…</p>
      </div>
    );
  }

  // Signed-out gate: every feature requires a Leo Cloud account. The
  // background picks the session up on its own once sign-in completes in
  // the opened tab, which lifts this gate automatically.
  if (account === null) {
    return (
      <div className="shell">
        <header className="header">
          <span className="brand">Leo</span>
          <span className="tagline">Teach your browser a task once.</span>
        </header>
        <section className="card">
          <h2>Sign in to get started</h2>
          <p className="hint">
            Leo needs a Leo Cloud account to record, run and sync your
            workflows. Signing in opens the Leo web app in a new tab &mdash;
            once you&apos;re done, this menu unlocks by itself.
          </p>
          <button className="primary" onClick={() => void send({ kind: 'panel.signIn' })}>
            Sign in
          </button>
        </section>
      </div>
    );
  }

  const { rec, run, workflows } = state;
  const running =
    run &&
    (run.status === 'running' ||
      run.status === 'waiting-user' ||
      run.status === 'teaching' ||
      run.status === 'step-failed');

  // ---------------------------------------------------------------------------
  // Settings screen
  // ---------------------------------------------------------------------------

  if (view === 'settings') {
    return (
      <div className="shell">
        <header className="header">
          <button className="ghost small" onClick={() => setView('new')}>
            &#8592; Back
          </button>
          <span className="brand">Settings</span>
        </header>
        <section className="card">
          <h2>Leo Cloud</h2>
          {/* The signed-out case never reaches this screen: the gate in the
              main render path replaces the whole menu until signed in. */}
          <p className="hint">
            Signed in as <strong>{account.email}</strong>
          </p>
          <div className="row">
            <button
              className="ghost"
              onClick={() => {
                setAccount(null);
                void send({ kind: 'panel.signOut' });
              }}
            >
              Sign out
            </button>
          </div>
        </section>
        <section className="card">
          <div className="field">
            <span>Replay speed</span>
            <label className="radio">
              <input
                type="radio"
                name="speed"
                checked={settings.speed === 'verbose'}
                onChange={() => setSettingsState({ ...settings, speed: 'verbose' })}
              />
              <span className="radio-text">
                <strong>Verbose</strong>
                <em>
                  Replays at normal user speed — the cursor glides, text is typed
                  key by key, so you can watch every step.
                </em>
              </span>
            </label>
            <label className="radio">
              <input
                type="radio"
                name="speed"
                checked={settings.speed === 'agent'}
                onChange={() => setSettingsState({ ...settings, speed: 'agent' })}
              />
              <span className="radio-text">
                <strong>Agent</strong>
                <em>Does everything as soon as possible — ultra fast.</em>
              </span>
            </label>
          </div>
          <label className="field">
            <span>Pointer color</span>
            <div className="swatches">
              {CURSOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`swatch ${settings.cursorColor === c ? 'active' : ''}`}
                  style={{ background: c, boxShadow: `0 0 8px ${c}` }}
                  onClick={() => setSettingsState({ ...settings, cursorColor: c })}
                  title={c}
                />
              ))}
              <input
                type="color"
                value={settings.cursorColor}
                onChange={(e) =>
                  setSettingsState({ ...settings, cursorColor: e.target.value })
                }
                title="Custom color"
              />
            </div>
          </label>
          <div className="row">
            <button
              className="primary"
              onClick={() => {
                void send<{ ok: boolean }>({ kind: 'panel.setSettings', settings }).then(() => {
                  setView('new');
                  refresh();
                });
              }}
            >
              Save settings
            </button>
          </div>
        </section>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Main screen: header + tabs, run/recording status shown on every tab
  // ---------------------------------------------------------------------------

  const runCard = run && (
    <section className="card">
      <h2>
        {run.status === 'done' && 'Run finished'}
        {run.status === 'error' && 'Run failed'}
        {run.status === 'cancelled' && 'Run cancelled'}
        {run.status === 'running' && `Running: ${run.workflowName}`}
        {run.status === 'waiting-user' && 'Your turn'}
        {run.status === 'step-failed' && 'Step failed'}
        {run.status === 'teaching' && 'Show Leo how'}
        {!running && (
          <button
            className="ghost small dismiss"
            title="Dismiss"
            onClick={() => void send({ kind: 'panel.dismissRun' })}
          >
            &#10005;
          </button>
        )}
      </h2>
      {run.status === 'waiting-user' && (
        <p className="hint">
          {run.waitingFor === 'file'
            ? 'This step needs a file. Choose it in the highlighted field on the page, then press Continue. Leo never stores your files.'
            : 'This step needs a password. Type it into the highlighted field on the page, then press Continue. Leo never stores passwords.'}
        </p>
      )}
      {running && run.inputMode === 'compatible' && (
        <p className="hint">
          Compatibility mode: Chrome&apos;s debugger isn&apos;t available, so Leo is using
          page-level input. A few sites ignore it.
        </p>
      )}
      {run.status === 'step-failed' && (
        <p className="hint">
          This step could not complete. Try it again, show Leo how to do it, skip
          it and continue with the rest of the workflow, or end the run here.
        </p>
      )}
      {run.status === 'teaching' && (
        <>
          <p className="hint">
            Do this step yourself in the page. Leo is watching, and what you do
            replaces the step it could not complete — so next time it runs on its
            own.
          </p>
          {(run.teachSteps ?? []).length ? (
            <ol className="steps">
              {(run.teachSteps ?? []).map((s, i) => (
                <li key={i}>{stepLabel(s)}</li>
              ))}
            </ol>
          ) : (
            <p className="hint">Nothing captured yet.</p>
          )}
        </>
      )}
      <div className="progress">
        <div
          className={`bar ${run.status}`}
          style={{ width: `${Math.round((run.stepIndex / Math.max(run.totalSteps, 1)) * 100)}%` }}
        />
      </div>
      <p className="hint">
        Step {Math.min(run.stepIndex + 1, run.totalSteps)} of {run.totalSteps}
        {run.healedSteps.length > 0 && ` (${run.healedSteps.length} repaired)`}
      </p>
      {run.repairs.length > 0 && (
        <ul className="repairs">
          {run.repairs.map((r, i) => (
            <li key={`${r.index}:${i}`}>
              <span>
                Step {r.index + 1} repaired{' '}
                {r.by === 'local' ? 'by Leo' : r.by === 'ai' ? 'by AI' : 'by the AI agent'}
                {r.note ? `: ${r.note}` : ''}
                {!r.verified && ' — not saved, the page did not react'}
              </span>
              {r.verified && (
                <button
                  className="link"
                  onClick={() => {
                    void send<{ ok: boolean; error?: string }>({
                      kind: 'panel.undoRepair',
                      index: r.index,
                    }).then((res) => showError(res.error));
                  }}
                >
                  Undo
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {run.status === 'running' && run.agentNote && (
        <p className="hint agent-note">✦ {run.agentNote}</p>
      )}
      {(run.status === 'error' || run.status === 'step-failed') && (
        <p className="error">{run.error}</p>
      )}
      {(run.status === 'error' || run.status === 'step-failed') && run.log.some((e) => e.screenshot) && (
        <FailureShot key={`${run.workflowId}:${run.startedAt}:${run.log.length}`} />
      )}
      <div className="row">
        {run.status === 'waiting-user' && (
          <button className="primary" onClick={() => void send({ kind: 'panel.continueRun' })}>
            Continue
          </button>
        )}
        {run.status === 'step-failed' && (
          <>
            <button className="primary" onClick={() => void send({ kind: 'panel.retryStep' })}>
              Retry step
            </button>
            <button
              className="ghost"
              onClick={() => {
                void send<{ ok: boolean; error?: string }>({ kind: 'panel.teachStep' }).then((res) =>
                  showError(res.error),
                );
              }}
            >
              Show me how
            </button>
            <button className="ghost" onClick={() => void send({ kind: 'panel.skipStep' })}>
              Skip step
            </button>
          </>
        )}
        {!running && run.status !== 'done' && run.resumeFrom != null && (
          <button
            className="primary"
            onClick={() => {
              void send<{ ok: boolean; error?: string }>({ kind: 'panel.resumeRun' }).then((res) =>
                showError(res.error),
              );
            }}
          >
            Resume from step {run.resumeFrom + 1}
          </button>
        )}
        {run.status === 'teaching' && (
          <>
            <button
              className="primary"
              onClick={() => {
                void send<{ ok: boolean; error?: string }>({
                  kind: 'panel.finishTeaching',
                  save: true,
                }).then((res) => showError(res.error));
              }}
            >
              Done, carry on
            </button>
            <button
              className="ghost"
              onClick={() => void send({ kind: 'panel.finishTeaching', save: false })}
            >
              Never mind
            </button>
          </>
        )}
        {running && (
          <button className="ghost" onClick={() => void send({ kind: 'panel.cancelRun' })}>
            End run
          </button>
        )}
      </div>
    </section>
  );

  return (
    <div className="shell">
      <header className="header">
        <span className="brand">Leo</span>
        <span className="tagline">Teach your browser a task once.</span>
        <button className="ghost small" title="Settings" onClick={() => setView('settings')}>
          &#9881;
        </button>
      </header>

      <nav className="tabs">
        <button
          className={`tab ${view === 'new' ? 'active' : ''}`}
          onClick={() => setView('new')}
        >
          New
        </button>
        <button
          className={`tab ${view === 'saved' ? 'active' : ''}`}
          onClick={() => setView('saved')}
        >
          Saved Runs
        </button>
      </nav>

      {flash && <div className="flash">{flash}</div>}
      {runCard}

      {view === 'new' && (
        <>
          {rec && !saving && (
            <section className="card">
              <h2>
                <span className="rec-dot" /> Recording
              </h2>
              <p className="hint">
                Perform the task normally in the tab. Every click, keystroke and page
                change is captured.
              </p>
              <ol className="steps">
                {rec.steps.map((s, i) => (
                  <li key={i}>{stepLabel(s)}</li>
                ))}
              </ol>
              <div className="row">
                <button className="primary" onClick={() => setSaving(true)}>
                  Stop and save
                </button>
                <button
                  className="ghost"
                  onClick={() => void send({ kind: 'panel.discardRecording' })}
                >
                  Discard
                </button>
              </div>
            </section>
          )}

          {rec && saving && (
            <section className="card">
              <h2>Name this workflow</h2>
              <label className="field">
                <span>Name</span>
                <input
                  autoFocus
                  placeholder="Download monthly invoice"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                />
              </label>
              <div className="row">
                <button
                  className="primary"
                  onClick={() => {
                    void send<{ ok: boolean; error?: string }>({
                      kind: 'panel.stopRecording',
                      name: saveName,
                    }).then((res) => {
                      showError(res.error);
                      setSaving(false);
                      setSaveName('');
                      if (!res.error) setView('saved');
                    });
                  }}
                >
                  Save workflow
                </button>
                <button className="ghost" onClick={() => setSaving(false)}>
                  Back
                </button>
              </div>
            </section>
          )}

          {!rec && (
            <section className="card">
              <button
                className="record"
                disabled={Boolean(running)}
                onClick={() => {
                  void send<{ ok: boolean; error?: string }>({
                    kind: 'panel.startRecording',
                  }).then((res) => showError(res.error));
                }}
              >
                <span className="rec-dot" /> Start recording
              </button>
              <p className="hint">
                Records the active tab. Do the task once; Leo remembers it forever.
              </p>
            </section>
          )}

        </>
      )}

      {/* StepEditor defined below */}
      {view === 'saved' && (
        <section className="list">
          {workflows.length === 0 && (
            <p className="hint">Nothing yet. Record your first workflow in the New tab.</p>
          )}
          {workflows.map((wf: Workflow) => (
            <div className="workflow" key={wf.id}>
              {editingStepsId === wf.id ? (
                <StepEditor
                  steps={draftSteps}
                  onChange={setDraftSteps}
                  onSave={() => {
                    void send<{ ok: boolean; error?: string }>({
                      kind: 'panel.updateWorkflowSteps',
                      id: wf.id,
                      steps: draftSteps,
                    }).then((res) => {
                      if (res?.ok === false) showError(res.error);
                      else setEditingStepsId(null);
                    });
                  }}
                  onCancel={() => setEditingStepsId(null)}
                />
              ) : renamingId === wf.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      void send({ kind: 'panel.renameWorkflow', id: wf.id, name: renameValue });
                      setRenamingId(null);
                    }
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                />
              ) : (
                <div className="wf-main">
                  <div className="wf-name">{wf.name}</div>
                  {wf.objective && <div className="wf-objective">{wf.objective}</div>}
                  <div className="wf-meta">
                    {wf.steps.length} steps
                    {wf.healCount > 0 && ` · repaired ${wf.healCount}x by AI`}
                  </div>
                </div>
              )}
              {editingStepsId !== wf.id && (
              <div className="wf-actions">
                <button
                  className="primary small"
                  disabled={Boolean(running) || Boolean(rec)}
                  onClick={() => {
                    void send<{ ok: boolean; error?: string }>({
                      kind: 'panel.run',
                      id: wf.id,
                    }).then((res) => showError(res.error));
                  }}
                >
                  Run
                </button>
                <button
                  className="ghost small"
                  onClick={() => {
                    setEditingStepsId(wf.id);
                    setDraftSteps(wf.steps);
                  }}
                >
                  Edit
                </button>
                <button
                  className="ghost small"
                  onClick={() => {
                    setRenamingId(wf.id);
                    setRenameValue(wf.name);
                  }}
                >
                  Rename
                </button>
                <button
                  className="ghost small danger"
                  onClick={() => {
                    if (confirm(`Delete "${wf.name}"?`)) {
                      void send({ kind: 'panel.deleteWorkflow', id: wf.id });
                    }
                  }}
                >
                  Delete
                </button>
              </div>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

// What the page looked like when the step failed, fetched on demand (it's a
// few hundred KB, so it isn't part of the polled state).
function FailureShot() {
  const [open, setOpen] = useState(false);
  const [shot, setShot] = useState<string | null | undefined>(undefined);
  if (!open) {
    return (
      <button
        className="link"
        onClick={() => {
          setOpen(true);
          void send<{ dataUrl: string | null }>({ kind: 'panel.getFailureShot' }).then((r) =>
            setShot(r?.dataUrl ?? null),
          );
        }}
      >
        Show the page when it failed
      </button>
    );
  }
  if (shot === undefined) return <p className="hint">Loading…</p>;
  if (shot === null) return <p className="hint">No screenshot was captured.</p>;
  return (
    <img
      src={shot}
      alt="The page when the step failed"
      style={{ width: '100%', border: '1px solid #444', borderRadius: 6, marginTop: 6 }}
    />
  );
}

// ---------------------------------------------------------------------------
// Step editor: delete recorded steps and insert natural-language AI steps for
// dynamic actions ("select last month") that can't be a fixed click.
// ---------------------------------------------------------------------------

function StepEditor({
  steps,
  onChange,
  onSave,
  onCancel,
}: {
  steps: Step[];
  onChange: (steps: Step[]) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const insertAgent = (at: number) => {
    const next = [...steps];
    next.splice(at, 0, { type: 'agent', goal: '' });
    onChange(next);
  };
  const removeAt = (at: number) => onChange(steps.filter((_, i) => i !== at));
  const setGoal = (at: number, goal: string) =>
    onChange(steps.map((s, i) => (i === at && s.type === 'agent' ? { ...s, goal } : s)));

  const insertRow = (at: number) => (
    <button className="link insert-ai" onClick={() => insertAgent(at)}>
      ＋ AI instruction
    </button>
  );

  return (
    <div className="step-editor">
      <h2>Edit steps</h2>
      <p className="hint">
        Delete recorded steps, or insert an AI instruction for a dynamic action
        (e.g. &ldquo;in the open date picker, go to last month and select the
        1st to the last day&rdquo;). The AI sees a screenshot of the page while
        it works.
      </p>
      <ol className="steps editing">
        {insertRow(0)}
        {steps.map((s, i) => (
          <li key={i} className={s.type === 'agent' ? 'agent-step' : ''}>
            <div className="step-row">
              {s.type === 'agent' ? (
                <textarea
                  className="agent-goal"
                  placeholder="Describe the action for the AI…"
                  value={s.goal}
                  onChange={(e) => setGoal(i, e.target.value)}
                />
              ) : (
                <span className="step-text">{stepLabel(s)}</span>
              )}
              <button
                className="ghost small danger"
                title="Delete step"
                onClick={() => removeAt(i)}
              >
                ✕
              </button>
            </div>
            {insertRow(i + 1)}
          </li>
        ))}
      </ol>
      <div className="row">
        <button className="primary" onClick={onSave}>
          Save
        </button>
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
