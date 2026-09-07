import { useCallback, useEffect, useState } from 'react';
import { api, relative, type Overview } from '../api';
import { Card, Notice, Spinner, Tag, Toggle } from '../components/ui';

// Ollama reads these when it starts, so changing one writes .env and takes
// effect on the next restart. Each is worth a sentence: they are the knobs
// that decide whether a small box feels fast or feels broken.
const OLLAMA_KNOBS: Array<{ key: string; label: string; hint: string; options?: string[]; placeholder?: string }> = [
  {
    key: 'OLLAMA_NUM_PARALLEL',
    label: 'Requests at once',
    hint: 'How many people Ollama answers simultaneously. Each slot holds its own context window of KV cache, so this is a memory decision as much as a speed one. One slot means everyone queues behind whoever asked first.',
    placeholder: '2',
  },
  {
    key: 'OLLAMA_KV_CACHE_TYPE',
    label: 'Context cache precision',
    hint: 'q8_0 halves what each slot’s context costs at close to no quality cost, which is what makes several slots affordable. q4_0 halves it again and does cost quality. f16 turns the saving off. Needs flash attention on.',
    options: ['q8_0', 'q4_0', 'f16'],
  },
  {
    key: 'OLLAMA_FLASH_ATTENTION',
    label: 'Flash attention',
    hint: 'Faster attention and less memory per token. Required for the cache precision setting above to do anything.',
    options: ['1', '0'],
  },
  {
    key: 'OLLAMA_MAX_LOADED_MODELS',
    label: 'Models resident at once',
    hint: 'Ollama’s own default is three, which on a small box means two models nobody is using hold the memory the one in use needs.',
    placeholder: '1',
  },
  {
    key: 'OLLAMA_MAX_QUEUE',
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

  const refresh = useCallback(async () => { setOverview(await api.overview()); }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const run = async (label: string, fn: () => Promise<{ ok: boolean; output: string }>, ok?: string): Promise<void> => {
    setBusy(label); setMessage(null);
    try {
      const r = await fn();
      await refresh();
      setMessage({ tone: r.ok ? 'good' : 'bad', text: r.ok ? (ok ?? 'Done.') : (r.output.trim().split('\n').slice(-4).join('\n') || 'That did not work.') });
    } catch (e) {
      setMessage({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
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
        <p>The containers, whether they come back after a reboot, and the settings Ollama reads when it starts.</p>
      </div>

      {message && <Notice tone={message.tone}><span style={{ whiteSpace: 'pre-wrap' }}>{message.text}</span></Notice>}

      {!hostUp && (
        <Notice tone="bad">
          The host helper is not answering, so nothing on this page can act. It runs on the machine
          rather than in a container, deliberately — the container never gets podman access. Start it
          with <span className="mono">sudo systemctl start perch-hostd</span>.
        </Notice>
      )}

      <Card title="Containers" sub="perch and Ollama, run by podman.">
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

      <Card title="Ollama tuning" sub="Written into .env. Ollama reads them at startup, so restart the containers afterwards.">
        {OLLAMA_KNOBS.map((k) => (
          <div key={k.key} className="field" style={{ maxWidth: 640 }}>
            <label htmlFor={k.key}>{k.label} <span className="mono" style={{ color: 'var(--ink-faint)', fontWeight: 400 }}>{k.key}</span></label>
            <div className="row">
              {k.options ? (
                <select id={k.key} value={knobs[k.key] ?? ''} style={{ maxWidth: 160 }}
                  onChange={(e) => setKnobs({ ...knobs, [k.key]: e.target.value })}>
                  <option value="">choose…</option>
                  {k.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input id={k.key} type="text" inputMode="numeric" placeholder={k.placeholder} style={{ maxWidth: 160 }}
                  value={knobs[k.key] ?? ''} onChange={(e) => setKnobs({ ...knobs, [k.key]: e.target.value })} />
              )}
              <button className="sm" disabled={!hostUp || !knobs[k.key] || busy !== null}
                onClick={() => void run(k.key, () => api.setOllamaEnv(k.key, knobs[k.key]!), `${k.key} set. Restart the containers to apply it.`)}>
                {busy === k.key ? <Spinner /> : 'Set'}
              </button>
            </div>
            <span className="hint">{k.hint}</span>
          </div>
        ))}
      </Card>

      <Card title="Logs">
        <div className="row">
          {(['perch', 'ollama', 'tunnel'] as const).map((s) => (
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
