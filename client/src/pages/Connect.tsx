import { useCallback, useEffect, useState } from 'react';
import { api, relative, type Connection, type TokenRecord } from '../api';
import { Card, CodeBlock, Copy, Empty, Notice, Spinner, Tag } from '../components/ui';

/**
 * Connections: one per machine running Tern. Each has its own account on the
 * far side, its own key and its own systemd unit, so removing one leaves the
 * others untouched.
 */
export default function Connect() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [endpointUp, setEndpointUp] = useState(false);
  const [tokens, setTokens] = useState<TokenRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad' | 'info'; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', host: '', sshPort: 22, user: 'perch', remotePort: 11434, torProxy: '' });

  const refresh = useCallback(async () => {
    const [c, tk] = await Promise.all([api.connections(), api.tokens()]);
    setConnections(c.connections);
    setEndpointUp(c.endpointUp);
    setTokens(tk.tokens.filter((t) => !t.revokedAt));
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => { void api.connections().then((c) => { setConnections(c.connections); setEndpointUp(c.endpointUp); }).catch(() => {}); }, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const run = async (label: string, fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    setBusy(label); setMessage(null);
    try {
      await fn();
      await refresh();
      if (ok) setMessage({ tone: 'good', text: ok });
    } catch (e) {
      setMessage({ tone: 'bad', text: (e as Error).message });
    } finally { setBusy(null); }
  };

  if (loading) return <div className="row"><Spinner /> <span className="mono">loading…</span></div>;

  const live = connections.filter((c) => !c.retiredAt);
  const retired = connections.filter((c) => c.retiredAt);

  return (
    <>
      <div className="page-head">
        <h1>Connections</h1>
        <p>
          Each machine running Tern gets its own connection: its own account on that box,
          its own key and its own service here. This machine dials out to all of them, so
          nothing listens on your home connection and no port is forwarded on your router.
        </p>
      </div>

      {message && <Notice tone={message.tone}><span style={{ whiteSpace: 'pre-wrap' }}>{message.text}</span></Notice>}
      {!endpointUp && (
        <Notice tone="bad">
          The model endpoint is not listening on this machine, so no tunnel has anything to carry.
          Start the containers under System.
        </Notice>
      )}

      <div className="row between" style={{ marginBottom: 14 }}>
        <span className="mono" style={{ color: 'var(--ink-faint)', fontSize: 12 }}>
          {live.length} connection{live.length === 1 ? '' : 's'}
          {tokens.length ? ` · ${tokens.length} token${tokens.length === 1 ? '' : 's'}` : ' · no tokens yet'}
        </span>
        <button className="primary" onClick={() => { setAdding(!adding); setMessage(null); }}>
          {adding ? 'Cancel' : 'Add a connection'}
        </button>
      </div>

      {adding && (
        <Card title="A new connection" sub="The machine Tern runs on, as SSH reaches it. That is the only thing you need to know — the rest is worked out during setup.">
          <div className="row" style={{ alignItems: 'flex-end', maxWidth: 700 }}>
            <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}>
              <label htmlFor="cname">Name</label>
              <input id="cname" type="text" placeholder="Mail VPS" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="field" style={{ marginBottom: 0, flex: 1.4, minWidth: 200 }}>
              <label htmlFor="chost">SSH host</label>
              <input id="chost" type="text" placeholder="mail.example.com" value={form.host}
                onChange={(e) => setForm({ ...form, host: e.target.value })} />
            </div>
            <div className="field" style={{ marginBottom: 0, width: 90 }}>
              <label htmlFor="cport">Port</label>
              <input id="cport" type="number" value={form.sshPort}
                onChange={(e) => setForm({ ...form, sshPort: Number(e.target.value) })} />
            </div>
          </div>
          <div className="grid cols-3" style={{ maxWidth: 700, marginTop: 12 }}>
            <div className="field">
              <label htmlFor="cuser">Account there</label>
              <input id="cuser" type="text" value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} />
              <span className="hint">Created for you, with no shell.</span>
            </div>
            <div className="field">
              <label htmlFor="crport">Port there</label>
              <input id="crport" type="number" value={form.remotePort} onChange={(e) => setForm({ ...form, remotePort: Number(e.target.value) })} />
              <span className="hint">Where Tern finds the model.</span>
            </div>
            <div className="field">
              <label htmlFor="ctor">SOCKS proxy</label>
              <input id="ctor" type="text" placeholder="empty = direct" value={form.torProxy}
                onChange={(e) => setForm({ ...form, torProxy: e.target.value })} />
              <span className="hint">127.0.0.1:9050 for Tor.</span>
            </div>
          </div>
          <button className="primary" disabled={busy !== null || !form.host || !form.name}
            onClick={() => void run('add', async () => {
              await api.createConnection(form);
              setAdding(false);
              setForm({ name: '', host: '', sshPort: 22, user: 'perch', remotePort: 11434, torProxy: '' });
            }, 'Connection created, with a key. Open it to finish setup.')}>
            {busy === 'add' ? <Spinner /> : 'Create'}
          </button>
        </Card>
      )}

      {live.length === 0 && !adding && (
        <Card><Empty>No connections yet. Add one to point a Tern install at this machine.</Empty></Card>
      )}

      {live.map((c) => (
        <ConnectionCard
          key={c.id}
          c={c}
          open={open === c.id}
          busy={busy}
          onToggle={() => setOpen(open === c.id ? null : c.id)}
          onRun={run}
          setMessage={setMessage}
        />
      ))}

      {retired.length > 0 && (
        <Card
          title="Removed, and still to clean up over there"
          sub="perch has deleted the service, the key and the settings on this machine. It cannot touch the other one: the tunnel key is restricted so it can hold a port open and nothing else, which is the point of it — a credential here that could clean up remotely could also do everything else."
        >
          {retired.map((c) => (
            <div key={c.id} style={{ borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 12 }}>
              <div className="row between">
                <div>
                  <strong>{c.name}</strong>{' '}
                  <span className="mono" style={{ color: 'var(--ink-faint)', fontSize: 12 }}>{c.user}@{c.host}</span>
                  <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>removed {relative(c.retiredAt)}</div>
                </div>
                <button className="sm" disabled={busy !== null}
                  onClick={() => void run(`forget-${c.id}`, () => api.forgetConnection(c.id), 'Forgotten.')}>
                  {busy === `forget-${c.id}` ? <Spinner /> : 'Done — forget it'}
                </button>
              </div>
              {c.uninstallCommand && (
                <div style={{ marginTop: 10 }}>
                  <p className="sub" style={{ marginBottom: 6 }}>Run this on {c.host}. It takes out only this connection's key, and removes the account only if no other key is left — so another perch using that server keeps working. Safe to run twice.</p>
                  <CodeBlock text={c.uninstallCommand} wrap />
                </div>
              )}
            </div>
          ))}
        </Card>
      )}
    </>
  );
}

function ConnectionCard({ c, open, busy, onToggle, onRun, setMessage }: {
  c: Connection;
  open: boolean;
  busy: string | null;
  onToggle: () => void;
  onRun: (label: string, fn: () => Promise<unknown>, ok?: string) => Promise<void>;
  setMessage: (m: { tone: 'good' | 'bad' | 'info'; text: string } | null) => void;
}) {
  const [paste, setPaste] = useState('');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [edit, setEdit] = useState({ host: c.host, sshPort: c.sshPort, user: c.user, remotePort: c.remotePort, torProxy: c.torProxy });

  const running = c.status.active === 'active';
  const paired = c.status.configured;
  const k = (s: string): string => `${s}-${c.id}`;

  return (
    <Card>
      <div className="row between" style={{ cursor: 'pointer' }} onClick={onToggle}>
        <div>
          <strong style={{ fontSize: 14 }}>{c.name}</strong>{' '}
          <span className="mono" style={{ color: 'var(--ink-faint)', fontSize: 12 }}>
            {c.user}@{c.host}{c.sshPort !== 22 ? `:${c.sshPort}` : ''}
          </span>
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            {running ? <Tag tone="good">running</Tag> : paired ? <Tag tone="bad">{c.status.active}</Tag> : <Tag>setup unfinished</Tag>}
            {c.status.enabled === 'enabled' && <Tag tone="good">starts at boot</Tag>}
            {c.torProxy && <Tag tone="accent">over Tor</Tag>}
            {paired && <span className="hint mono">→ {c.remoteBind}:{c.remotePort}</span>}
          </div>
        </div>
        <button className="ghost sm">{open ? 'Close' : 'Open'}</button>
      </div>

      {paired && running && (
        <div style={{ marginTop: 12 }}>
          <p className="sub" style={{ marginBottom: 6 }}>Tern&apos;s base URL, for Admin → AI model:</p>
          <CodeBlock text={c.ternBaseUrl} />
        </div>
      )}

      {open && (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 16 }}>
          <ol className="steps">
            <li className={c.status.hasKey ? 'done' : ''}>
              <h3>Its key</h3>
              <p>Generated here for this connection alone and never leaves this machine, so retiring it cannot strand any other.</p>
              {c.publicKey ? <CodeBlock text={c.publicKey} wrap /> : (
                <button disabled={busy !== null} onClick={() => void onRun(k('key'), () => api.connectionKey(c.id), 'Key generated.')}>
                  {busy === k('key') ? <Spinner /> : 'Generate a key'}
                </button>
              )}
            </li>

            <li className={paired ? 'done' : ''}>
              <h3>Run one command on {c.host}</h3>
              <p>It creates the locked-down account, installs this key with restrictions so it can do nothing but hold one port open, teaches sshd to reap dead tunnels, and prints one line to bring back.</p>
              {c.setupCommand ? <CodeBlock text={c.setupCommand} wrap /> : <p className="sub">Generate a key first.</p>}
              <details style={{ marginTop: 10 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--ink-dim)', fontSize: 12.5 }}>Rather read the script first</summary>
                <div style={{ marginTop: 8 }}><CodeBlock text={c.setupManual} wrap /></div>
              </details>
            </li>

            <li className={paired ? 'done' : ''}>
              <h3>Paste what it printed</h3>
              <p>
                The last line begins <span className="mono">perch-pair:</span>. Paste it — or the whole
                output — and perch finishes: the address, the service, starting it, starting it at boot,
                and a token if there is not one.
              </p>
              <div className="field" style={{ maxWidth: 620 }}>
                <textarea rows={2} placeholder="perch-pair:v1:10.89.0.1:11434" value={paste} onChange={(e) => setPaste(e.target.value)} />
              </div>
              <button className="primary" disabled={busy !== null || !paste.trim() || !c.status.hasKey}
                onClick={() => void onRun(k('pair'), async () => {
                  const r = await api.pairConnection(c.id, paste);
                  if (r.token) setNewToken(r.token);
                  setPaste('');
                  const up = r.connection.status.active === 'active';
                  setMessage({
                    tone: up ? 'good' : 'bad',
                    text: up ? `Connected. Tern's base URL is ${r.connection.ternBaseUrl}.`
                             : `Saved, but the tunnel did not come up: ${(r.steps.started?.output || '').trim().split('\n').slice(-3).join('\n')}`,
                  });
                })}>
                {busy === k('pair') ? <Spinner /> : 'Connect'}
              </button>
              {newToken && (
                <div style={{ marginTop: 12 }}>
                  <Notice tone="good">Copy this token now — it is not shown again.</Notice>
                  <CodeBlock text={newToken} wrap />
                </div>
              )}
            </li>

            <li className={running ? 'done' : ''}>
              <h3>The tunnel</h3>
              <p>systemd owns it, so it comes back after a dropped line, a router reboot or a power cut.</p>
              <div className="row">
                <button disabled={busy !== null || !paired}
                  onClick={() => void onRun(k('run'), () => api.connectionAction(c.id, running ? 'restart' : 'start'), running ? 'Restarted.' : 'Started.')}>
                  {busy === k('run') ? <Spinner /> : running ? 'Restart' : 'Start'}
                </button>
                {running && (
                  <button disabled={busy !== null} onClick={() => void onRun(k('stop'), () => api.connectionAction(c.id, 'stop'), 'Stopped.')}>
                    {busy === k('stop') ? <Spinner /> : 'Stop'}
                  </button>
                )}
                <button disabled={busy !== null}
                  onClick={() => void onRun(k('boot'), () => api.connectionAction(c.id, c.status.enabled === 'enabled' ? 'disable' : 'enable'),
                    c.status.enabled === 'enabled' ? 'It will no longer start at boot.' : 'It will start at boot.')}>
                  {busy === k('boot') ? <Spinner /> : c.status.enabled === 'enabled' ? 'Do not start at boot' : 'Start at boot'}
                </button>
                <button className="ghost" disabled={busy !== null}
                  onClick={() => void onRun(k('logs'), async () => {
                    const r = await api.connectionAction(c.id, 'logs');
                    setMessage({ tone: 'info', text: r.output.split('\n').slice(-12).join('\n') });
                  })}>
                  {busy === k('logs') ? <Spinner /> : 'Recent log'}
                </button>
              </div>
              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--ink-dim)', fontSize: 12.5 }}>What systemd runs</summary>
                <div style={{ marginTop: 8 }}><CodeBlock text={c.sshCommand} wrap /></div>
              </details>
            </li>
          </ol>

          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 14, marginTop: 6 }}>
            <h3 style={{ fontSize: 13, margin: '0 0 10px' }}>Settings</h3>
            <div className="grid cols-3" style={{ maxWidth: 700 }}>
              <div className="field">
                <label>SSH host</label>
                <input type="text" value={edit.host} onChange={(e) => setEdit({ ...edit, host: e.target.value })} />
              </div>
              <div className="field">
                <label>SSH port</label>
                <input type="number" value={edit.sshPort} onChange={(e) => setEdit({ ...edit, sshPort: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>Account there</label>
                <input type="text" value={edit.user} onChange={(e) => setEdit({ ...edit, user: e.target.value })} />
              </div>
              <div className="field">
                <label>Port there</label>
                <input type="number" value={edit.remotePort} onChange={(e) => setEdit({ ...edit, remotePort: Number(e.target.value) })} />
              </div>
              <div className="field" style={{ gridColumn: 'span 2' }}>
                <label>SOCKS proxy</label>
                <div className="row">
                  <input type="text" placeholder="empty = connect directly" value={edit.torProxy}
                    onChange={(e) => setEdit({ ...edit, torProxy: e.target.value })} />
                  {!edit.torProxy && <button className="ghost sm" onClick={() => setEdit({ ...edit, torProxy: '127.0.0.1:9050' })}>Use Tor</button>}
                </div>
                <span className="hint">Over Tor the far side never learns this machine&apos;s address, and its SSH host can be an .onion.</span>
              </div>
            </div>
            <div className="row between">
              <button disabled={busy !== null}
                onClick={() => void onRun(k('save'), () => api.updateConnection(c.id, edit), 'Saved and applied.')}>
                {busy === k('save') ? <Spinner /> : 'Save'}
              </button>
              <button className="danger" disabled={busy !== null}
                onClick={() => {
                  if (!confirm(`Remove "${c.name}"?\n\nThe service, key and settings here are deleted. The account on ${c.host} is not touched — perch will show you the command to run there.`)) return;
                  void onRun(k('rm'), () => api.removeConnection(c.id), 'Removed here. See the cleanup command below.');
                }}>
                {busy === k('rm') ? <Spinner /> : 'Remove this connection'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
