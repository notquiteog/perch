import { useCallback, useEffect, useState } from 'react';
import { api, human, pullModel, relative, type ModelChoice, type ModelInfo, type LoadedModel, type Sizing } from '../api';
import { Card, Empty, Notice, Spinner, Tag } from '../components/ui';

interface Pull { name: string; status: string; pct: number }

export default function Models() {
  const [installed, setInstalled] = useState<ModelInfo[]>([]);
  const [loaded, setLoaded] = useState<LoadedModel[]>([]);
  const [catalog, setCatalog] = useState<ModelChoice[]>([]);
  const [embedCatalog, setEmbedCatalog] = useState<ModelChoice[]>([]);
  const [sizing, setSizing] = useState<Sizing | null>(null);
  const [totalHuman, setTotalHuman] = useState('0 B');
  const [busy, setBusy] = useState<string | null>(null);
  const [pull, setPull] = useState<Pull | null>(null);
  const [custom, setCustom] = useState('');
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const data = await api.models();
    setInstalled(data.installed);
    setLoaded(data.loaded);
    setCatalog(data.catalog);
    setEmbedCatalog(data.embedCatalog);
    setSizing(data.sizing);
    setTotalHuman(data.totalHuman);
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const isInstalled = (name: string): boolean =>
    installed.some((m) => m.name === name || m.name === `${name}:latest` || m.name.split(':')[0] === name.split(':')[0] && m.name === name);

  const isLoaded = (name: string): boolean => loaded.some((m) => m.name === name);

  const startPull = (name: string): void => {
    setMessage(null);
    setPull({ name, status: 'starting', pct: 0 });
    pullModel(
      name,
      (p) => {
        const pct = p.total && p.completed ? (p.completed / p.total) * 100 : 0;
        setPull({ name, status: p.status, pct });
      },
      (error) => {
        setPull(null);
        setMessage(error ? { tone: 'bad', text: error } : { tone: 'good', text: `${name} is ready.` });
        void refresh();
      },
    );
  };

  const act = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label);
    setMessage(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setMessage({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const fits = (m: ModelChoice): boolean => !sizing || m.needsBytes <= sizing.usableBytes;

  return (
    <>
      <div className="page-head">
        <h1>Models</h1>
        <p>
          What is on this machine, what is in memory, and what else would run here.
          Sizes are the download; the note beside each one is about the memory it wants
          while it works.
        </p>
      </div>

      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      {pull && (
        <Card title={`Downloading ${pull.name}`}>
          <div className="progress"><i style={{ width: `${pull.pct}%` }} /></div>
          <p className="sub" style={{ marginTop: 9, marginBottom: 0 }}>
            <span className="mono">{pull.status}</span>
            {pull.pct > 0 && <span className="mono"> · {pull.pct.toFixed(0)}%</span>}
          </p>
        </Card>
      )}

      <Card title="Installed" sub={`${installed.length} model${installed.length === 1 ? '' : 's'}, ${totalHuman} on disk.`}>
        {installed.length === 0 ? (
          <Empty>Nothing downloaded yet. Pick one below.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Model</th><th>Parameters</th><th>Quantisation</th>
                <th className="right">Size</th><th className="right">Added</th><th className="right">State</th><th />
              </tr>
            </thead>
            <tbody>
              {installed.map((m) => (
                <tr key={m.name}>
                  <td className="mono">{m.name}</td>
                  <td className="mono">{m.details?.parameter_size ?? '—'}</td>
                  <td className="mono">{m.details?.quantization_level ?? '—'}</td>
                  <td className="right mono">{human(m.size)}</td>
                  <td className="right mono">{relative(m.modified_at)}</td>
                  <td className="right">{isLoaded(m.name) ? <Tag tone="good">in memory</Tag> : <Tag>on disk</Tag>}</td>
                  <td className="right">
                    <div className="row end" style={{ gap: 6 }}>
                      {isLoaded(m.name) ? (
                        <button className="sm" disabled={busy !== null} onClick={() => void act('unload', () => api.unloadModel(m.name))}>
                          {busy === 'unload' ? <Spinner /> : 'Unload'}
                        </button>
                      ) : (
                        <button className="sm" disabled={busy !== null} onClick={() => void act('load', () => api.loadModel(m.name))}>
                          {busy === 'load' ? <Spinner /> : 'Load'}
                        </button>
                      )}
                      <button
                        className="sm danger"
                        disabled={busy !== null}
                        onClick={() => {
                          if (confirm(`Delete ${m.name}? It will have to be downloaded again to use it.`)) {
                            void act('delete', () => api.deleteModel(m.name));
                          }
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card
        title="For writing email"
        sub={
          sizing
            ? `Judged against ${human(sizing.usableBytes)} of usable ${sizing.basis === 'vram' ? 'video memory' : 'system memory'}. Anything greyed out would run, but slowly, by spilling out of ${sizing.basis === 'vram' ? 'the GPU into system memory' : 'memory onto disk'}.`
            : undefined
        }
      >
        <table>
          <tbody>
            {catalog.map((m) => (
              <tr key={m.name} style={{ opacity: fits(m) ? 1 : 0.45 }}>
                <td style={{ width: '30%' }}>
                  <div className="mono">{m.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
                    {m.params} · wants {human(m.needsBytes)}
                    {sizing?.recommended.name === m.name && <> · <span style={{ color: 'var(--accent)' }}>recommended</span></>}
                  </div>
                </td>
                <td style={{ color: 'var(--ink-dim)', fontSize: 12.5 }}>{m.note}</td>
                <td className="right" style={{ width: 110 }}>
                  {isInstalled(m.name)
                    ? <Tag tone="good">installed</Tag>
                    : (
                      <button className="sm" disabled={pull !== null} onClick={() => startPull(m.name)}>
                        Download
                      </button>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card
        title="For meaning search"
        sub="Tern embeds mail only for people who switch search on for themselves. These are small enough to sit beside the writing model without competing for room."
      >
        <table>
          <tbody>
            {embedCatalog.map((m) => (
              <tr key={m.name}>
                <td style={{ width: '30%' }}>
                  <div className="mono">{m.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>{m.params} · wants {human(m.needsBytes)}</div>
                </td>
                <td style={{ color: 'var(--ink-dim)', fontSize: 12.5 }}>{m.note}</td>
                <td className="right" style={{ width: 110 }}>
                  {isInstalled(m.name)
                    ? <Tag tone="good">installed</Tag>
                    : <button className="sm" disabled={pull !== null} onClick={() => startPull(m.name)}>Download</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Something else" sub="Any tag from ollama.com/library, for example qwen3:8b or phi4:14b.">
        <div className="row">
          <input
            type="text"
            placeholder="model:tag"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && custom.trim()) startPull(custom.trim()); }}
            style={{ maxWidth: 300 }}
          />
          <button disabled={!custom.trim() || pull !== null} onClick={() => startPull(custom.trim())}>Download</button>
        </div>
      </Card>
    </>
  );
}
