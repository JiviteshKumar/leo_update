import { useCallback, useEffect, useState } from 'react';
import type {
  PanelMessage,
  PanelState,
  Settings,
  Step,
  Workflow,
} from '@/utils/types';
import { DEFAULT_CURSOR_COLOR, DEFAULT_MODEL, DEFAULT_SPEED, STATE_UPDATE } from '@/utils/types';

const CURSOR_PRESETS = ['#4c8bf5', '#f5b301', '#e5484d', '#46a758', '#a855f7'];

type View = 'new' | 'saved' | 'settings';

const send = <T,>(msg: PanelMessage): Promise<T> =>
  browser.runtime.sendMessage(msg) as Promise<T>;

const stepLabel = (step: Step): string => {
  switch (step.type) {
    case 'navigate':
      return `Go to ${step.url}`;
    case 'nav-wait':
      return 'Wait for the page to load';
    case 'click':
      return step.target.intent;
    case 'dblclick':
      return `Double ${step.target.intent.toLowerCase()}`;
    case 'type':
      return step.secret
        ? `${step.target.intent} (typed manually at run time)`
        : `${step.target.intent}: "${step.text.slice(0, 30)}${step.text.length > 30 ? '...' : ''}"`;
    case 'select':
      return `${step.target.intent}: ${step.label}`;
    case 'key':
      return `Press ${step.key}`;
    case 'download':
      return 'Wait for the file download';
  }
};

export function App() {
  const [state, setState] = useState<PanelState | null>(null);
  const [view, setView] = useState<View>('new');
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [flash, setFlash] = useState<string | null>(null);
  const [settings, setSettingsState] = useState<Settings>({
    apiKey: '',
    model: DEFAULT_MODEL,
    cursorColor: DEFAULT_CURSOR_COLOR,
    speed: DEFAULT_SPEED,
  });

  const refresh = useCallback(() => {
    void send<PanelState>({ kind: 'panel.getState' }).then(setState).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const onMessage = (msg: { kind?: string }) => {
      if (msg?.kind === STATE_UPDATE) refresh();
    };
    browser.runtime.onMessage.addListener(onMessage);
    const poll = setInterval(refresh, 1500);
    void send<Settings>({ kind: 'panel.getSettings' }).then(setSettingsState).catch(() => {});
    return () => {
      browser.runtime.onMessage.removeListener(onMessage);
      clearInterval(poll);
    };
  }, [refresh]);

  const showError = (error?: string) => {
    if (!error) return;
    setFlash(error);
    setTimeout(() => setFlash(null), 5000);
  };

  if (!state) {
    return (
      <div className="shell">
        <header className="header"><span className="brand">Leo</span></header>
      </div>
    );
  }

  const { rec, run, workflows } = state;
  const running =
    run &&
    (run.status === 'running' ||
      run.status === 'waiting-user' ||
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
          <label className="field">
            <span>Anthropic API key</span>
            <input
              type="password"
              placeholder="sk-ant-..."
              value={settings.apiKey}
              onChange={(e) => setSettingsState({ ...settings, apiKey: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Repair model</span>
            <select
              value={settings.model}
              onChange={(e) => setSettingsState({ ...settings, model: e.target.value })}
            >
              <option value="claude-opus-4-8">Claude Opus 4.8 (recommended)</option>
              <option value="claude-sonnet-5">Claude Sonnet 5</option>
              <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
            </select>
          </label>
          <p className="hint">
            When a website changes and a recorded step breaks, Leo asks Claude to find
            the same control on the new page and repairs the workflow. Without a key,
            replay still works but broken steps fail instead of self-healing.
          </p>
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
          This step needs a password. Type it into the highlighted field on the
          page, then press Continue. Leo never stores passwords.
        </p>
      )}
      {run.status === 'step-failed' && (
        <p className="hint">
          This step could not complete. Try it again, skip it and continue with
          the rest of the workflow, or end the run here.
        </p>
      )}
      <div className="progress">
        <div
          className={`bar ${run.status}`}
          style={{ width: `${Math.round((run.stepIndex / Math.max(run.totalSteps, 1)) * 100)}%` }}
        />
      </div>
      <p className="hint">
        Step {Math.min(run.stepIndex + 1, run.totalSteps)} of {run.totalSteps}
        {run.healedSteps.length > 0 && ` (${run.healedSteps.length} repaired by AI)`}
      </p>
      {(run.status === 'error' || run.status === 'step-failed') && (
        <p className="error">{run.error}</p>
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
            <button className="ghost" onClick={() => void send({ kind: 'panel.skipStep' })}>
              Skip step
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

      {view === 'saved' && (
        <section className="list">
          {workflows.length === 0 && (
            <p className="hint">Nothing yet. Record your first workflow in the New tab.</p>
          )}
          {workflows.map((wf: Workflow) => (
            <div className="workflow" key={wf.id}>
              {renamingId === wf.id ? (
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
                  <div className="wf-meta">
                    {wf.steps.length} steps
                    {wf.healCount > 0 && ` · repaired ${wf.healCount}x by AI`}
                  </div>
                </div>
              )}
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
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
