import { useCallback, useEffect, useState } from 'react';
import { api, relative, type Overview, type TuningKey } from '../api';
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

export default function System() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad' | 'info'; text: string } | null>(null);
  const [logs, setLogs] = useState<{ service: string; text: string } | null>(null);
  const [knobs, setKnobs] = useState<Record<string, string>>({});
  const [tuning, setTuning] = useState<TuningKey[]>([]);

  const refresh = useCallback(async () => { setOverview(await api.overview()); }, []);

  // Not on the five-second poll with the rest: reading these means the host
  // helper asking podman what two containers were created with, and the
  // answer only changes when somebody on this page changes it.
  const loadTuning = useCallback(async () => {
    try { setTuning((await api.ollamaEnv()).keys); } catch { /* the card falls back to placeholders */ }
  }, []);

  useEffect(() => {
    void refresh();
    void loadTuning();
    const t = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(t);
  }, [refresh, loadTuning]);

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
      await loadTuning();
      setMessage({ tone: r.ok ? 'good' : 'bad', text: r.ok ? (ok ?? 'Done.') : (r.output.trim().split('\n').slice(-4).join('\n') || 'That did not work.') });
    } catch (e) {
      setMessage({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
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
  const containers = overview.host?.containers ?? [];
  const bootOn = overview.host?.boot.enabled === 'enabled';
  const anyRunning = containers.some((c) => c.status.toLowerCase().startsWith('up'));

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

      <Card title="Containers" sub="Everything perch runs, by podman: the console, Ollama, and whichever optional services are switched on.">
        {containers.length === 0 ? (
          <p className="sub">Nothing reported. Either they are not running, or the helper cannot see them.</p>
        ) : (
          <table>
            <thead><tr><th>Container</th><th>State</th><th className="right">Started</th></tr></thead>
            <tbody>
              {containers.map((c) => (
                <tr key={c.name}>
                  <td className="mono">{c.name}</td>
                  <td>{c.status.toLowerCase().startsWith('up') ? <Tag tone="good">{c.status}</Tag> : <Tag tone="bad">{c.status}</Tag>}</td>
                  <td className="right mono">{c.startedAt ? relative(c.startedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="row" style={{ marginTop: 14 }}>
          <button className="primary" disabled={!hostUp || busy !== null}
            onClick={() => void run('start', () => api.containerAction('start'), 'Containers started.')}>
            {busy === 'start' ? <Spinner /> : 'Start'}
          </button>
          <button disabled={!hostUp || busy !== null || !anyRunning}
            onClick={() => void run('restart', () => api.containerAction('restart'), 'Containers restarted.')}>
            {busy === 'restart' ? <Spinner /> : 'Restart'}
          </button>
          <button className="danger" disabled={!hostUp || busy !== null || !anyRunning}
            onClick={() => {
              if (confirm('Stop perch and Ollama? Tern will lose the model until they are back.')) {
                void run('stop', () => api.containerAction('stop'), 'Containers stopped.');
              }
            }}>
            {busy === 'stop' ? <Spinner /> : 'Stop'}
          </button>
          <button disabled={!hostUp || busy !== null}
            onClick={() => void run('pull', () => api.containerAction('pull'), 'Images pulled. Restart to run them.')}>
            {busy === 'pull' ? <Spinner /> : 'Update images'}
          </button>
        </div>
        <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>
          Stopping perch stops this console too — it is served by the same container, so the page
          will go blank until you start it again from a terminal.
        </p>
      </Card>

      <ContainerSizes hostUp={hostUp} />

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
