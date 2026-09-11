import { useCallback, useEffect, useState } from 'react';
import {
  ApiError, api, relative,
  type ContainerAction, type ContainerName, type ContainerSize, type Overview, type TuningKey,
} from '../api';
import { Card, Notice, Spinner, Tag, Toggle } from '../components/ui';
import ContainerSizes from './ContainerSizes';

// Ollama reads these when it starts, so changing one writes .env — and then
// the container has to be recreated before anything reads it. A restart is
// not enough: compose fixes a container's environment when it *creates* it,
// so a restarted container hands back the values it already had and the new
// one sits in the file doing nothing. Each knob is worth a sentence too: they
// are what decides whether a small box feels fast or feels broken.
interface Knob {
  key: string;
  label: string;
  hint: string;
  /** The container that reads it, and so the one a change has to recreate. */
  container: 'ollama' | 'perch';
  options?: string[];
  placeholder?: string;
}

const CONTAINER_LABEL: Record<Knob['container'], string> = { ollama: 'Ollama', perch: 'perch' };

const OLLAMA_KNOBS: Knob[] = [
  {
    key: 'OLLAMA_NUM_PARALLEL',
    container: 'ollama',
    label: 'Requests at once',
    hint: 'How many people Ollama answers simultaneously. Each slot holds its own context window of KV cache, so this is a memory decision as much as a speed one. One slot means everyone queues behind whoever asked first.',
    placeholder: '2',
  },
  {
    key: 'OLLAMA_KV_CACHE_TYPE',
    container: 'ollama',
    label: 'Context cache precision',
    hint: 'q8_0 halves what each slot’s context costs at close to no quality cost, which is what makes several slots affordable. q4_0 halves it again and does cost quality. f16 turns the saving off. Needs flash attention on.',
    options: ['q8_0', 'q4_0', 'f16'],
  },
  {
    key: 'OLLAMA_FLASH_ATTENTION',
    container: 'ollama',
    label: 'Flash attention',
    hint: 'Faster attention and less memory per token. Required for the cache precision setting above to do anything.',
    options: ['1', '0'],
  },
  {
    key: 'OLLAMA_MAX_LOADED_MODELS',
    container: 'ollama',
    label: 'Models resident at once',
    hint: 'Two holds a language model and an embedding model at once, so meaning search does not evict the model you are chatting with and make the next reply reload it. Ollama’s own default is three, which on a small box means two models nobody is using hold the memory the one in use needs. A ceiling rather than a reservation — anything that will not fit beside what is already there is not kept.',
    placeholder: '2',
  },
  {
    key: 'OLLAMA_MAX_QUEUE',
    container: 'ollama',
    label: 'Queue depth',
    hint: 'How many requests wait once every slot is busy. The default of 512 is deep enough that a loaded box looks like a hung spinner for minutes; a short queue answers "busy" instead.',
    placeholder: '32',
  },
];

/**
 * What stops when this container does.
 *
 * Every one of these actions interrupts something somebody may be in the
 * middle of, and the console is the only thing in a position to say what. A
 * confirmation that reads "are you sure?" teaches people to click through it;
 * one that names what is about to break is read.
 */
const INTERRUPTS: Record<string, string> = {
  perch: 'this console and the model endpoint it serves',
  ollama: 'the model endpoint and anything generating an answer right now',
  whisper: 'dictation',
  comfy: 'image and video generation',
  kokoro: 'speech',
};

function whatStops(c: ContainerSize): string {
  return INTERRUPTS[c.id] ?? c.label;
}

/**
 * The sentence shown before a disruptive action, or null where there is
 * nothing to warn about. Starting something that is not running costs nothing
 * and is not worth a dialog.
 */
function confirmation(c: ContainerSize, action: ContainerAction): string | null {
  // Anything done to perch takes away the container serving this page, and
  // stop is the one with no way back from here: nothing on a page that is
  // gone can start it again.
  const andThePage = c.id === 'perch'
    ? action === 'stop'
      ? ' This page will stop loading, and starting perch again means a terminal on the machine: ./bin/perch up.'
      : ' This page will fail to load for a few seconds and then come back.'
    : '';
  switch (action) {
    case 'stop':
      return `Stopping ${c.label} takes down ${whatStops(c)}.${andThePage} Carry on?`;
    case 'restart':
      return `Restarting ${c.label} interrupts ${whatStops(c)} until it is back.${andThePage} Carry on?`;
    case 'rebuild':
      return `${c.built ? 'Building' : 'Pulling'} ${c.label}’s image again and recreating the container on it. `
        + `That interrupts ${whatStops(c)}, and on a slow line the image alone can take several minutes.${andThePage} Carry on?`;
    default:
      return null;
  }
}

function done(c: ContainerSize, action: ContainerAction): string {
  switch (action) {
    case 'start': return `${c.label} started.`;
    case 'stop': return `${c.label} stopped.`;
    case 'restart': return `${c.label} restarted.`;
    case 'rebuild': return `${c.label}’s image was ${c.built ? 'built' : 'pulled'} again and the container recreated on it.`;
    default: return 'Done.';
  }
}

export default function System() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad' | 'info'; text: string } | null>(null);
  const [logs, setLogs] = useState<{ service: string; text: string } | null>(null);
  const [knobs, setKnobs] = useState<Record<string, string>>({});
  const [tuning, setTuning] = useState<TuningKey[]>([]);
  // Every container perch runs, whether or not podman has one for it — which
  // is the difference that matters here. The host status only lists what
  // exists, and a container that has been stopped is exactly the one somebody
  // has come to this page to start.
  const [containers, setContainers] = useState<ContainerSize[]>([]);
  const [totalMemBytes, setTotalMemBytes] = useState(0);

  const refresh = useCallback(async () => { setOverview(await api.overview()); }, []);

  const refreshContainers = useCallback(async () => {
    try {
      const r = await api.containers();
      setContainers(r.containers);
      setTotalMemBytes(r.totalMemBytes);
    } catch { /* the banner above already says when the console is unreachable */ }
  }, []);

  // Not on the five-second poll with the rest: reading these means the host
  // helper asking podman what two containers were created with, and the
  // answer only changes when somebody on this page changes it.
  const loadTuning = useCallback(async () => {
    try { setTuning((await api.ollamaEnv()).keys); } catch { /* the card falls back to placeholders */ }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshContainers();
    void loadTuning();
    const t = setInterval(() => { void refresh(); void refreshContainers(); }, 5000);
    return () => clearInterval(t);
  }, [refresh, refreshContainers, loadTuning]);

  // Show what each knob is set to rather than an empty box. A blank field
  // beside a greyed-out placeholder reads as "not set", when in fact every one
  // of these has a value — and guessing at the placeholder was how somebody
  // set a knob to the default it already had.
  useEffect(() => {
    if (tuning.length === 0) return;
    setKnobs((prev) => {
      const next = { ...prev };
      for (const t of tuning) if (next[t.key] === undefined && t.configured) next[t.key] = t.configured;
      return next;
    });
  }, [tuning]);

  const run = async (label: string, fn: () => Promise<{ ok: boolean; output: string }>, ok?: string): Promise<void> => {
    setBusy(label); setMessage(null);
    try {
      const r = await fn();
      await refresh();
      await refreshContainers();
      await loadTuning();
      setMessage({ tone: r.ok ? 'good' : 'bad', text: r.ok ? (ok ?? 'Done.') : (r.output.trim().split('\n').slice(-4).join('\n') || 'That did not work.') });
    } catch (e) {
      setMessage({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  /**
   * One action, on one container.
   *
   * Not `run` above, for two reasons: the confirmation has to name what this
   * particular container is about to take down, and a request that acts on
   * perch is answered by the container it is recreating — so the answer never
   * arrives, and a dropped connection there is the action working rather than
   * failing.
   */
  const act = async (c: ContainerSize, action: ContainerAction): Promise<void> => {
    const ask = confirmation(c, action);
    if (ask && !confirm(ask)) return;
    setBusy(`${c.id}:${action}`);
    setMessage(null);
    try {
      const r = await api.containerAction(action, c.id as ContainerName);
      setMessage({
        tone: r.ok ? 'good' : 'bad',
        text: r.ok ? done(c, action) : (r.output.trim().split('\n').slice(-4).join('\n') || 'That did not work.'),
      });
    } catch (e) {
      // An ApiError is the console answering with a refusal, which is a real
      // failure. Anything else on perch is the connection going away with the
      // container, which is what was asked for — reporting that as an error
      // would send somebody to fix a machine that is busy doing as it was told.
      if (c.id === 'perch' && !(e instanceof ApiError)) {
        setMessage({ tone: 'info', text: 'perch is doing that now, which takes this console with it. Reload the page in a few seconds.' });
      } else {
        setMessage({ tone: 'bad', text: (e as Error).message });
      }
    } finally {
      setBusy(null);
      await refresh().catch(() => { /* perch may be the thing that just went away */ });
      await refreshContainers();
    }
  };

  // Writing one of these to .env changes nothing on its own; the container
  // that reads it has to be created again. Both of the things that costs are
  // worth being asked about rather than discovered: recreating Ollama drops
  // the resident model out from under whoever is mid-sentence, and recreating
  // perch recreates the container serving this page, so the answer to the
  // request never arrives and the page goes blank until it is back.
  const applyKnob = async (k: Knob, value: string): Promise<void> => {
    if (!value) return;
    const warning = k.container === 'perch'
      ? 'Recreating perch restarts this console. The page will fail to load for a few seconds and then come back. Carry on?'
      : 'Recreating Ollama drops whatever model is in memory and interrupts anything generating right now. The next request loads it again. Carry on?';
    if (!confirm(warning)) return;
    await run(`${k.key}:apply`, () => api.setOllamaEnv(k.key, value, true),
      `${k.key} set, and ${CONTAINER_LABEL[k.container]} was recreated to read it.`);
  };

  if (!overview) return <div className="row"><Spinner /> <span className="mono">loading…</span></div>;

  const hostUp = overview.hostPresent && !overview.hostStale;
  const bootOn = overview.host?.boot.enabled === 'enabled';
  const anyRunning = containers.some((c) => c.running);

  return (
    <>
      <div className="page-head">
        <h1>System</h1>
        <p>The containers, how big each of them may be, whether they come back after a reboot, and the settings Ollama reads when it starts.</p>
      </div>

      {message && <Notice tone={message.tone}><span style={{ whiteSpace: 'pre-wrap' }}>{message.text}</span></Notice>}

      {!hostUp && (
        <Notice tone="bad">
          The host helper is not answering, so nothing on this page can act. It runs on the machine
          rather than in a container, deliberately — the container never gets podman access. Start it
          with <span className="mono">sudo systemctl start perch-hostd</span>.
        </Notice>
      )}

      <Card
        title="Containers"
        sub="Everything perch runs, by podman: the console, Ollama, and whichever optional services are switched on. Each row acts on that container alone; the buttons underneath act on all of them."
      >
        {!hostUp ? (
          // Every row would say "not running", including the one serving this
          // page. A table of confident wrong answers is worse than no table.
          <p className="sub">
            What podman is running is a question only the host can be asked, and it is not
            answering — so there is nothing to show here rather than a list of containers all
            claiming to be stopped.
          </p>
        ) : containers.length === 0 ? (
          <p className="sub">Nothing reported yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Container</th><th>State</th><th className="right">Started</th><th />
              </tr>
            </thead>
            <tbody>
              {containers.map((c) => (
                <tr key={c.id} style={{ opacity: c.enabled ? 1 : 0.5 }}>
                  <td>
                    <div className="mono">{c.name ?? c.id}</div>
                    <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
                      {c.label}
                      {!c.enabled && ' · not switched on'}
                    </div>
                  </td>
                  <td>
                    {/* No status at all is a container podman has never been
                        asked to create, which is a different thing from one
                        that is stopped — and it is why Start is offered. */}
                    {c.running ? <Tag tone="good">{c.status}</Tag>
                      : c.status ? <Tag tone="bad">{c.status}</Tag>
                        : <Tag>not created</Tag>}
                  </td>
                  <td className="right mono">{c.running && c.startedAt ? relative(c.startedAt) : '—'}</td>
                  <td className="right">
                    <div className="row end" style={{ gap: 6 }}>
                      {c.running ? (
                        <>
                          <button className="sm" disabled={!hostUp || !c.enabled || busy !== null}
                            onClick={() => void act(c, 'restart')}>
                            {busy === `${c.id}:restart` ? <Spinner /> : 'Restart'}
                          </button>
                          <button className="sm danger" disabled={!hostUp || !c.enabled || busy !== null}
                            onClick={() => void act(c, 'stop')}>
                            {busy === `${c.id}:stop` ? <Spinner /> : 'Stop'}
                          </button>
                        </>
                      ) : (
                        <button className="sm" disabled={!hostUp || !c.enabled || busy !== null}
                          onClick={() => void act(c, 'start')}>
                          {busy === `${c.id}:start` ? <Spinner /> : 'Start'}
                        </button>
                      )}
                      <button className="sm" disabled={!hostUp || !c.enabled || busy !== null}
                        onClick={() => void act(c, 'rebuild')}>
                        {busy === `${c.id}:rebuild` ? <Spinner /> : 'Rebuild'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="row" style={{ marginTop: 14 }}>
          <button className="primary" disabled={!hostUp || busy !== null}
            onClick={() => void run('start', () => api.containerAction('start'), 'Containers started.')}>
            {busy === 'start' ? <Spinner /> : 'Start all'}
          </button>
          <button disabled={!hostUp || busy !== null || !anyRunning}
            onClick={() => void run('restart', () => api.containerAction('restart'), 'Containers restarted.')}>
            {busy === 'restart' ? <Spinner /> : 'Restart all'}
          </button>
          <button className="danger" disabled={!hostUp || busy !== null || !anyRunning}
            onClick={() => {
              if (confirm('Stop perch and Ollama? Tern will lose the model until they are back.')) {
                void run('stop', () => api.containerAction('stop'), 'Containers stopped.');
              }
            }}>
            {busy === 'stop' ? <Spinner /> : 'Stop all'}
          </button>
          <button disabled={!hostUp || busy !== null}
            onClick={() => void run('pull', () => api.containerAction('pull'), 'Images pulled. Restart to run them.')}>
            {busy === 'pull' ? <Spinner /> : 'Update images'}
          </button>
        </div>
        <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>
          <strong>Rebuild</strong> fetches that container&rsquo;s image again — built here from the
          Containerfile for perch, pulled from its registry for the rest — and recreates the
          container on it. Both halves are needed: podman decides whether to replace a container
          from its configuration, which a new image under the same tag does not change, so a pull
          on its own leaves the old container running and reports success.
          {' '}
          <strong>Stop</strong> on perch stops this console with it — it is served by the same
          container, so the page will go blank until you start it again with{' '}
          <span className="mono">./bin/perch up</span> from a terminal on the machine.
        </p>
      </Card>

      <ContainerSizes hostUp={hostUp} rows={containers} totalMemBytes={totalMemBytes} refresh={refreshContainers} />

      <Card title="At boot">
        <Toggle
          checked={bootOn}
          disabled={!hostUp || busy !== null}
          label="Start perch when this machine boots"
          hint="A home machine reboots for updates and after power cuts. Without this, Tern quietly has no model until somebody notices and starts it by hand."
          onChange={(v) => void run('boot', () => api.boot(v ? 'enable' : 'disable'), v ? 'perch will start at boot.' : 'perch will not start at boot.')}
        />
        <p className="sub" style={{ marginTop: 12, marginBottom: 0 }}>
          Each connection starts at boot on its own — that switch lives beside the connection,
          under Connect. Containers running with no tunnel looks identical to a broken model
          from Tern&apos;s side, so it is worth having both on.
        </p>
      </Card>

      <Card title="Ollama tuning" sub="Written into .env, which compose reads when it creates a container — so a change here applies on recreate, not on restart.">
        {OLLAMA_KNOBS.map((k) => {
          const row = tuning.find((t) => t.key === k.key);
          const typed = knobs[k.key] ?? '';
          // Against .env rather than against what is running: setting a knob
          // writes the file, so a value already in the file is nothing to
          // write — even while the container is still running the old one.
          const changed = Boolean(typed) && typed !== (row?.configured ?? '');
          const pending = row?.pending ?? false;
          return (
          <div key={k.key} className="field" style={{ maxWidth: 640 }}>
            <label htmlFor={k.key}>{k.label} <span className="mono" style={{ color: 'var(--ink-faint)', fontWeight: 400 }}>{k.key}</span></label>
            <div className="row">
              {k.options ? (
                <select id={k.key} value={typed} style={{ maxWidth: 160 }}
                  onChange={(e) => setKnobs({ ...knobs, [k.key]: e.target.value })}>
                  <option value="">choose…</option>
                  {k.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input id={k.key} type="text" inputMode="numeric" placeholder={k.placeholder} style={{ maxWidth: 160 }}
                  value={typed} onChange={(e) => setKnobs({ ...knobs, [k.key]: e.target.value })} />
              )}
              <button className="sm" disabled={!hostUp || !changed || busy !== null}
                onClick={() => void run(k.key, () => api.setOllamaEnv(k.key, typed),
                  `${k.key} written to .env. ${CONTAINER_LABEL[k.container]} keeps its current value until it is recreated.`)}>
                {busy === k.key ? <Spinner /> : 'Set'}
              </button>
              <button className="sm" disabled={!hostUp || (!changed && !pending) || busy !== null}
                onClick={() => void applyKnob(k, typed || (row?.configured ?? ''))}>
                {busy === `${k.key}:apply` ? <Spinner />
                  : changed ? `Set and recreate ${CONTAINER_LABEL[k.container]}` : `Recreate ${CONTAINER_LABEL[k.container]}`}
              </button>
              {pending && <Tag tone="bad">written, not applied</Tag>}
            </div>
            <span className="hint">
              {k.hint}
              {row && (
                <>
                  {' '}
                  {row.running
                    ? <>{CONTAINER_LABEL[k.container]} is running with <span className="mono">{row.running}</span>.</>
                    : <>What {CONTAINER_LABEL[k.container]} is running with is unknown — nothing could be asked.</>}
                  {pending && <> The value in <span className="mono">.env</span> reaches it when the container is created again, not when it is restarted.</>}
                </>
              )}
            </span>
          </div>
          );
        })}
      </Card>

      <Card title="Logs">
        <div className="row">
          {(['perch', 'ollama', 'whisper', 'comfy', 'kokoro', 'tunnel'] as const).map((s) => (
            <button key={s} className="sm" disabled={!hostUp || busy !== null}
              onClick={() => void (async () => {
                setBusy(s);
                try {
                  const r = await api.logs(s);
                  setLogs({ service: s, text: r.output || '(nothing)' });
                } catch (e) {
                  setMessage({ tone: 'bad', text: (e as Error).message });
                } finally { setBusy(null); }
              })()}>
              {busy === s ? <Spinner /> : s}
            </button>
          ))}
          {logs && <button className="ghost sm" onClick={() => setLogs(null)}>Clear</button>}
        </div>
        {logs && (
          <pre className="code" style={{ marginTop: 12, maxHeight: 360, overflowY: 'auto' }}>{logs.text}</pre>
        )}
      </Card>
    </>
  );
}
