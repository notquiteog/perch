import { useCallback, useEffect, useState } from 'react';
import { api, human, pullModel, relative, type ModelChoice, type ModelInfo, type LoadedModel, type PullView, type Sizing } from '../api';
import { Card, Empty, Notice, Spinner, Tag } from '../components/ui';
import Dictation from './Dictation';
import Generation from './Generation';

export default function Models() {
  const [installed, setInstalled] = useState<ModelInfo[]>([]);
  const [loaded, setLoaded] = useState<LoadedModel[]>([]);
  const [catalog, setCatalog] = useState<ModelChoice[]>([]);
  const [embedCatalog, setEmbedCatalog] = useState<ModelChoice[]>([]);
  const [uncensored, setUncensored] = useState<ModelChoice[]>([]);
  const [showUncensored, setShowUncensored] = useState(false);
  const [sizing, setSizing] = useState<Sizing | null>(null);
  const [totalHuman, setTotalHuman] = useState('0 B');
  const [busy, setBusy] = useState<string | null>(null);
  // Downloads as the server sees them. It owns them now — a pull survives
  // this page being closed — so the page reads them rather than holding them:
  // `polled` is every job the server knows about, `live` is the finer-grained
  // stream for the ones started here, and the stream wins where both have an
  // opinion because it is newer.
  const [polled, setPolled] = useState<PullView[]>([]);
  const [live, setLive] = useState<Record<string, PullView>>({});
  // Dismissing is this page's opinion, not the console's: the record stays
  // there for a minute and a half so a browser closed during the download can
  // still be told how it went. Without remembering the dismissal here the
  // next poll would put the card straight back, five seconds later, which
  // reads as a button that does not work.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [reachable, setReachable] = useState<{ ok: boolean; error?: string; at?: string } | null>(null);
  const [custom, setCustom] = useState('');
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const data = await api.models();
    setInstalled(data.installed);
    setLoaded(data.loaded);
    setCatalog(data.catalog);
    setEmbedCatalog(data.embedCatalog);
    setUncensored(data.uncensoredCatalog);
    setSizing(data.sizing);
    setTotalHuman(data.totalHuman);
    setPolled(data.pulls ?? []);
    setReachable({ ok: data.ok, error: data.error, at: data.at });
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const pulls: PullView[] = (() => {
    const merged = new Map<string, PullView>();
    for (const p of polled) merged.set(p.name, p);
    for (const [name, p] of Object.entries(live)) merged.set(name, p);
    for (const name of dismissed) merged.delete(name);
    return [...merged.values()].sort((a, b) => a.startedAt - b.startedAt);
  })();
  const pullOf = (name: string): PullView | undefined => pulls.find((p) => p.name === name);
  const isPulling = (name: string): boolean => pullOf(name)?.state === 'running';

  // Ollama tags an untagged name with `:latest` when it stores it, so
  // "gemma3:1b" in the catalogue and "gemma3:1b" in /api/tags are the same
  // thing — and so are "phi4-mini" and "phi4-mini:latest".
  const isInstalled = (name: string): boolean =>
    installed.some((m) => m.name === name || m.name === `${name}:latest` || `${m.name}:latest` === name);

  const isLoaded = (name: string): boolean => loaded.some((m) => m.name === name);

  const startPull = (name: string): void => {
    setMessage(null);
    // Starting the same name again is asking to see it again.
    setDismissed((d) => { if (!d.has(name)) return d; const next = new Set(d); next.delete(name); return next; });
    setLive((m) => ({ ...m, [name]: { name, state: 'running', status: 'starting', completed: 0, total: 0, pct: null, bytesPerSec: null, etaSeconds: null, startedAt: Date.now(), endedAt: null } }));
    pullModel(
      name,
      (p) => setLive((m) => ({ ...m, [name]: p })),
      (error) => {
        if (error) setMessage({ tone: 'bad', text: error });
        else { setMessage({ tone: 'good', text: `${name} is ready.` }); setLive((m) => ({ ...m, [name]: { ...m[name]!, state: 'done', status: 'ready', pct: 100 } })); }
        void refresh();
      },
    );
  };

  const cancelPull = async (name: string): Promise<void> => {
    try { await api.cancelPull(name); setMessage({ tone: 'good', text: `${name} download cancelled.` }); }
    catch (e) { setMessage({ tone: 'bad', text: (e as Error).message }); }
    finally { void refresh(); }
  };

  // A finished card is worth reading for a moment and then gone.
  const dismissPull = (name: string): void => {
    setLive((m) => { const { [name]: _gone, ...rest } = m; return rest; });
    setDismissed((d) => new Set(d).add(name));
  };

  const act = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label);
    setMessage(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setMessage({ tone: 'bad', text: (e as Error).message });
      // Whatever went wrong, the table should show what is actually there
      // afterwards rather than what it assumed would be.
      await refresh().catch(() => {});
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
          What is on this machine, what is in memory, and what else would run here — language
          models, embeddings, speech, images, video and audio. Sizes are the download; the note
          beside each one is about the memory it wants while it works.
        </p>
      </div>

      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      {/* An Ollama that is not answering says so. Before this it was caught
          into an empty list, so a container that was down looked exactly like
          a machine with nothing on it — on the box whose whole job is holding
          models, the one thing this page must not say by accident. */}
      {reachable && !reachable.ok && (
        <Notice tone="bad">
          Ollama is not answering: {reachable.error ?? 'no reason given'}. Nothing below is current until it does.
        </Notice>
      )}

      {pulls.map((p) => (
        <PullCard key={p.name} pull={p} onCancel={() => void cancelPull(p.name)} onDismiss={() => dismissPull(p.name)} />
      ))}

      <Card
        title="Installed"
        sub={`${installed.length} model${installed.length === 1 ? '' : 's'}, ${totalHuman} on disk.`}
        right={<LiveTag at={reachable?.at} ok={reachable?.ok} />}
      >
        {installed.length === 0 ? (
          <Empty>{reachable && !reachable.ok ? 'Ollama is not answering, so there is nothing to list.' : 'Nothing downloaded yet. Pick one below.'}</Empty>
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
        title="Language models"
        sub={
          sizing
            ? `The LLMs this machine can hold, judged against ${human(sizing.usableBytes)} of usable ${sizing.basis === 'vram' ? 'video memory' : 'system memory'}. Anything greyed out would run, but slowly, by spilling out of ${sizing.basis === 'vram' ? 'the GPU into system memory' : 'memory onto disk'}.`
            : 'The LLMs this machine can hold.'
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
                      <button className="sm" disabled={isPulling(m.name)} onClick={() => startPull(m.name)}>
                        {isPulling(m.name) ? 'Downloading…' : 'Download'}
                      </button>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card
        title="Embedding models"
        sub="For search by meaning rather than by word — a client sends text and gets back a vector. Small enough to sit beside a language model without competing for room, and served on the same endpoint."
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
                    : <button className="sm" disabled={isPulling(m.name)} onClick={() => startPull(m.name)}>{isPulling(m.name) ? 'Downloading…' : 'Download'}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card
        title="Uncensored variants"
        sub="Abliterated builds, where the refusal behaviour has been ablated out of the weights. Useful when a stock model declines something ordinary — a firm complaint, a debt letter, a frank review — and the work and the machine are both yours."
        right={
          <button className="sm" onClick={() => setShowUncensored(!showUncensored)}>
            {showUncensored ? 'Hide' : `Show ${uncensored.length}`}
          </button>
        }
      >
        {showUncensored && (
          <>
            <Notice tone="info">
              Ablation is not free: it can soften instruction-following and make a model a little
              likelier to invent detail, so compare one against the stock model on your own mail
              rather than assuming it is an upgrade. And anywhere this model&apos;s output goes
              out without a person reading it first — a responder, a scheduled job — its own
              refusals were the last check before an odd prompt became an odd sent message, so
              it is worth keeping a human in that loop while you get a feel for it.
            </Notice>
            <table>
              <tbody>
                {uncensored.map((m) => (
                  <tr key={m.name} style={{ opacity: fits(m) ? 1 : 0.45 }}>
                    <td style={{ width: '34%' }}>
                      <div className="mono" style={{ fontSize: 12 }}>{m.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
                        {m.params} · {human(m.sizeBytes)} download · wants {human(m.needsBytes)}
                      </div>
                    </td>
                    <td style={{ color: 'var(--ink-dim)', fontSize: 12.5 }}>{m.note}</td>
                    <td className="right" style={{ width: 110 }}>
                      {isInstalled(m.name)
                        ? <Tag tone="good">installed</Tag>
                        : <button className="sm" disabled={isPulling(m.name)} onClick={() => startPull(m.name)}>{isPulling(m.name) ? 'Downloading…' : 'Download'}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>

      <Dictation />

      <Generation />

      <Card title="Something else" sub="Any tag from ollama.com, for example huihui_ai/phi4-abliterated:14b or gemma3:12b. This is the language-model endpoint; the generation models above are files rather than tags.">
        <div className="row">
          <input
            type="text"
            placeholder="model:tag"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && custom.trim()) { startPull(custom.trim()); setCustom(''); } }}
            style={{ maxWidth: 300 }}
          />
          <button disabled={!custom.trim() || isPulling(custom.trim())} onClick={() => { startPull(custom.trim()); setCustom(''); }}>Download</button>
        </div>
      </Card>
    </>
  );
}


function fmtRate(bytesPerSec: number | null): string {
  return bytesPerSec && bytesPerSec > 0 ? `${human(bytesPerSec)}/s` : '';
}

function fmtEta(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '';
  if (seconds < 60) return `${seconds}s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m left`;
  return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m left`;
}

/**
 * One download.
 *
 * The percentage is the server's, summed across every layer. The old bar read
 * whichever layer Ollama last mentioned, which meant it restarted from zero
 * several times and reached "100%" more than once during a single download —
 * on a 17 GB model over a domestic line that is the difference between a
 * progress bar and a decoration.
 */
function PullCard({ pull, onCancel, onDismiss }: { pull: PullView; onCancel: () => void; onDismiss: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (pull.state !== 'running') return undefined;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [pull.state]);
  const elapsed = Math.max(0, Math.round(((pull.endedAt ?? Date.now()) - pull.startedAt) / 1000));
  const title = pull.state === 'running' ? `Downloading ${pull.name}`
    : pull.state === 'done' ? `${pull.name} is ready`
    : pull.state === 'cancelled' ? `${pull.name} — cancelled`
    : `${pull.name} — failed`;
  return (
    <Card
      title={title}
      right={pull.state === 'running'
        ? <button className="sm danger" onClick={onCancel}>Cancel</button>
        : <button className="sm" onClick={onDismiss}>Dismiss</button>}
    >
      <div className="progress"><i style={{ width: `${pull.state === 'done' ? 100 : (pull.pct ?? 0)}%` }} /></div>
      <p className="sub" style={{ marginTop: 9, marginBottom: 0 }}>
        <span className="mono">{pull.status}</span>
        {pull.pct !== null && <span className="mono"> · {pull.pct}%</span>}
        {pull.total > 0 && <span className="mono"> · {human(pull.completed)} of {human(pull.total)}</span>}
        {pull.state === 'running' && <span className="mono"> · {[fmtRate(pull.bytesPerSec), fmtEta(pull.etaSeconds)].filter(Boolean).join(' · ') || `${elapsed}s`}</span>}
      </p>
      {pull.state === 'running' && (
        <p className="sub" style={{ marginBottom: 0 }}>
          This is a job on the console, not this page. Leaving, reloading or closing the browser will not stop it.
        </p>
      )}
      {pull.error && pull.state === 'error' && <p className="sub" style={{ marginBottom: 0, color: 'var(--bad)' }}>{pull.error}</p>}
    </Card>
  );
}

/** "This is what Ollama said, and this is how long ago it said it." */
function LiveTag({ at, ok }: { at?: string; ok?: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 5000); return () => clearInterval(t); }, []);
  if (!at) return null;
  if (!ok) return <Tag tone="bad">not answering</Tag>;
  const age = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000));
  return age > 30 ? <Tag tone="warn">{age}s ago</Tag> : <Tag tone="good">live</Tag>;
}
