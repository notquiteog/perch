import { useCallback, useEffect, useState } from 'react';
import { api, human, type VoiceStatus } from '../api';
import { Card, Notice, Spinner, Tag } from '../components/ui';

/**
 * The speech model, which is the one model on this machine the console could
 * not see anything about.
 *
 * It deliberately does not look like the Ollama cards above it, because
 * whisper.cpp is not that kind of server. It holds one model, chosen when the
 * container starts, and has no API for listing, downloading or removing
 * anything — so there is no table of what is on disk, and a Download button
 * would be a lie. What there is instead:
 *
 *   - which model the container was started with, read from the environment
 *     compose gave it rather than from a value this console remembers;
 *   - whether the transcriber is answering, polled;
 *   - a way to change the model, which writes WHISPER_MODEL and recreates the
 *     container — and then a live wait while the new weights come down,
 *     because the port does not open until they are on disk.
 *
 * That last point is the whole reason this card can show progress at all: a
 * refused connection on a machine that was just told to change model is not a
 * fault, it is the download. Saying so is more use than a red badge.
 */
export default function Dictation() {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState('');
  const [message, setMessage] = useState<{ tone: 'good' | 'bad' | 'info'; text: string } | null>(null);
  const [log, setLog] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setStatus(await api.voice()); } catch { /* the overview already says when the console is unreachable */ }
  }, []);

  useEffect(() => {
    void refresh();
    // Faster while it is coming back up, because that is the only window in
    // which this number changes at all.
    const t = setInterval(() => { void refresh(); }, status?.starting ? 3000 : 10_000);
    return () => clearInterval(t);
  }, [refresh, status?.starting]);

  if (!status) return null;

  // What .env asks for, and what the container actually has. They differ when
  // a change was written and not applied — a failed restart, or a perch that
  // has not been recreated since — and conflating them is how the card comes
  // to say a switch worked when it did not.
  const current = status.running ?? status.model;
  const change = async (target: string): Promise<void> => {
    setBusy(true);
    setMessage({ tone: 'info', text: `Switching to ${target}. The container is being recreated and will fetch the weights if it does not have them; dictation is down until it answers again.` });
    try {
      const r = await api.setSpeechModel(target);
      if (!r.ok) setMessage({ tone: 'bad', text: r.set?.output || 'the console could not write the new model' });
      else if (r.applied && !r.applied.ok) setMessage({ tone: 'bad', text: `The model was written but the container did not come back: ${r.applied.output}` });
      else setMessage({ tone: 'good', text: `${target} is set. It answers once the weights are on disk.` });
    } catch (e) {
      setMessage({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(false);
      setChoice('');
      await refresh();
    }
  };

  const showLog = async (): Promise<void> => {
    try { const r = await api.logs('whisper'); setLog(r.output || '(nothing yet)'); }
    catch (e) { setMessage({ tone: 'bad', text: (e as Error).message }); }
  };

  return (
    <Card
      title="Speech recognition"
      sub="Voice models for whisper.cpp: one of them, chosen when the container starts. It has no model API, so this is a setting and a restart rather than a download button."
      right={!status.enabled ? <Tag>off</Tag>
        : status.ok ? <Tag tone="good">answering</Tag>
        : status.starting ? <Tag tone="warn">starting</Tag>
        : <Tag tone="bad">not answering</Tag>}
    >
      {message && <Notice tone={message.tone === 'info' ? 'info' : message.tone}>{message.text}</Notice>}

      {/* Written but not running. Worth its own notice rather than a quiet
          mismatch, because from the outside it looks exactly like the switch
          having worked — and the fix is one button, not a diagnosis. */}
      {status.enabled && status.pending && (
        <Notice tone="warn">
          <div>
            <span className="mono">{status.model}</span> is set, but whisper is still running{' '}
            <span className="mono">{status.running}</span>. The container has to be recreated to pick it
            up — the weights come down on the way if it does not have them.
          </div>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button className="sm" disabled={busy} onClick={() => { setChoice(status.model); void change(status.model); }}>
              {busy ? <Spinner /> : `Apply ${status.model}`}
            </button>
          </div>
        </Notice>
      )}

      {/* A machine without dictation still gets the list, greyed. The models
          are worth reading before deciding whether to switch it on — which is
          a compose overlay and a re-run of the installer, not a button here. */}
      {!status.enabled && (
        <Notice tone="info">
          Dictation is not switched on for this machine, so none of these is in use. To switch it on:
          re-run <span className="mono">sudo ./install.sh</span> and say yes, or add{' '}
          <span className="mono">compose.voice.yml</span> to COMPOSE_FILE and <span className="mono">voice</span>{' '}
          to PERCH_SERVICES in .env. The model is chosen at the same time; whisper.cpp fetches it on
          first start.
        </Notice>
      )}

      {/* The port does not open until the weights are on disk, so a refused
          connection right after a change is the download, not a fault. There
          is no byte count to show — nothing exposes one — and the container's
          own log is the only place the progress exists. */}
      {status.enabled && !status.ok && status.starting && (
        <Notice tone="info">
          <span className="row" style={{ gap: 8 }}>
            <Spinner />
            <span>
              The transcriber is not listening yet. whisper.cpp does not open its port until the model file
              is on disk, so on a first start or after a change this is the weights coming down — {' '}
              <span className="mono">{current}</span> is {human(status.catalog.find((m) => m.name === current)?.sizeBytes ?? 0)}.
              Nothing reports a percentage for it; the container&rsquo;s log is where it is visible.
            </span>
          </span>
        </Notice>
      )}
      {status.enabled && !status.ok && !status.starting && status.error && <Notice tone="bad">{status.error}</Notice>}

      <table>
        <tbody>
          {status.catalog.map((m) => (
            <tr key={m.name} style={{ opacity: !status.enabled ? 0.55 : (m.name === current || !status.ok ? 1 : 0.85) }}>
              <td style={{ width: '28%' }}>
                <div className="mono">{m.name}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
                  {human(m.sizeBytes)} download · wants {human(m.needsBytes)}
                </div>
              </td>
              <td style={{ color: 'var(--ink-dim)', fontSize: 12.5 }}>{m.note}</td>
              <td className="right" style={{ width: 120 }}>
                {!status.enabled ? null
                  : m.name === current ? <Tag tone="good">in use</Tag>
                  : <button className="sm" disabled={busy} onClick={() => { setChoice(m.name); }}>Use</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {choice && choice !== current && (
        <Notice tone="info">
          <div>
            Switch to <span className="mono">{choice}</span>? <span className="mono">WHISPER_MODEL</span> is written to{' '}
            <span className="mono">.env</span> and the whisper container is recreated, so dictation stops until it
            has the new weights and answers again.
          </div>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button className="sm" disabled={busy} onClick={() => void change(choice)}>{busy ? <Spinner /> : 'Switch and restart'}</button>
            <button className="sm" disabled={busy} onClick={() => setChoice('')}>Cancel</button>
          </div>
        </Notice>
      )}

      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        {status.enabled && <button className="sm" onClick={() => void showLog()}>Container log</button>}
        {status.enabled && !status.modelKnown && (
          <span className="sub" style={{ margin: 0 }}>
            The console was not told which model this container was started with, so it is showing the default.
            Re-run <span className="mono">./bin/perch up</span> to pass it through.
          </span>
        )}
      </div>
      {log !== null && <pre className="code" style={{ marginTop: 10, maxHeight: 320, overflowY: 'auto' }}>{log}</pre>}
    </Card>
  );
}
