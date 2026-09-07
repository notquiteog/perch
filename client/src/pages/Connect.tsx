import { useCallback, useEffect, useState } from 'react';
import { api, type TokenRecord, type TunnelPage } from '../api';
import { Card, CodeBlock, Copy, Notice, Spinner, Tag } from '../components/ui';

/**
 * Setup, in the order a person actually does it, and with as little carried
 * between the two machines by hand as the design allows: type the SSH host,
 * run one command over there, paste back the one line it prints. perch does
 * the rest — the address, the unit, starting the tunnel, enabling it at boot
 * and minting a token — and finishes by showing the two values Tern wants.
 */
export default function Connect() {
  const [page, setPage] = useState<TunnelPage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad' | 'info'; text: string } | null>(null);
  const [form, setForm] = useState({ host: '', user: 'perch', sshPort: 22, remotePort: 11434, torProxy: '' });
  const [paste, setPaste] = useState('');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenRecord[]>([]);
  const [advanced, setAdvanced] = useState(false);

  const refresh = useCallback(async () => {
    const [t, tk] = await Promise.all([api.tunnel(), api.tokens()]);
    setPage(t);
    setTokens(tk.tokens.filter((x) => !x.revokedAt));
    setForm((f) => ({
      ...f,
      host: t.config.host || f.host,
      user: t.config.user,
      sshPort: t.config.sshPort,
      remotePort: t.config.remotePort,
      torProxy: t.config.torProxy,
    }));
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => { void api.tunnel().then(setPage).catch(() => {}); }, 5000);
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
    } finally {
      setBusy(null);
    }
  };

  if (!page) return <div className="row"><Spinner /> <span className="mono">loading…</span></div>;

  const hasKey = Boolean(page.publicKey);
  const hasHost = Boolean(page.config.host);
  const paired = Boolean(page.config.configuredAt && page.config.remoteBind);
  const running = page.status.active === 'active';
  const done = paired && running;

  return (
    <>
      <div className="page-head">
        <h1>Connect to Tern</h1>
        <p>
          This machine dials out to the box Tern runs on and holds a tunnel open. Nothing
          listens on your home connection, no port is forwarded on your router, and the
          model endpoint never exists anywhere but loopback at either end.
        </p>
      </div>

      {message && <Notice tone={message.tone}><span style={{ whiteSpace: 'pre-wrap' }}>{message.text}</span></Notice>}

      {/* When it is up, the thing you came here for goes at the top. */}
      {done && (
        <Card title="Put these in Tern" sub="Admin → AI model. Set the provider to Ollama.">
          <div className="field" style={{ maxWidth: 560 }}>
            <label>Base URL</label>
            <CodeBlock text={page.ternBaseUrl} />
            <span className="hint">
              If Tern cannot resolve that name, use <span className="mono">{page.ternBaseUrlLiteral}</span> instead.
            </span>
          </div>
          <div className="field" style={{ maxWidth: 560 }}>
            <label>API key</label>
            {newToken ? (
              <>
                <CodeBlock text={newToken} wrap />
                <span className="hint">Copy it now — this is the only time it is shown.</span>
              </>
            ) : (
              <div className="row">
                <span className="hint">
                  {tokens.length} token{tokens.length === 1 ? '' : 's'} already issued. perch keeps only a hash,
                  so if you no longer have it, make another.
                </span>
                <button className="sm" disabled={busy !== null}
                  onClick={() => void run('token', async () => { setNewToken((await api.createToken('Tern', ['use', 'manage'])).token); })}>
                  {busy === 'token' ? <Spinner /> : 'New token'}
                </button>
              </div>
            )}
          </div>
          <div className="row">
            <Tag tone="good">tunnel running</Tag>
            <Tag tone={page.status.enabled === 'enabled' ? 'good' : 'warn'}>
              {page.status.enabled === 'enabled' ? 'starts at boot' : 'not started at boot'}
            </Tag>
            <Tag tone={page.status.endpointUp ? 'good' : 'bad'}>
              {page.status.endpointUp ? 'endpoint listening' : 'endpoint down'}
            </Tag>
          </div>
        </Card>
      )}

      <Card title={done ? 'Setup' : undefined}>
        <ol className="steps">
          {/* 1 */}
          <li className={hasKey ? 'done' : ''}>
            <h3>A key for the tunnel</h3>
            <p>
              Generated here and never leaves this machine. It is used for nothing but
              holding the tunnel open, and the far side restricts it to exactly that.
            </p>
            {hasKey ? (
              <p className="sub" style={{ marginBottom: 0 }}>
                <Tag tone="good">key ready</Tag> Private half stays at{' '}
                <span className="mono">{page.config.keyPath}</span>.
              </p>
            ) : (
              <button className="primary" disabled={busy !== null}
                onClick={() => void run('key', api.generateKey, 'Key generated.')}>
                {busy === 'key' ? <Spinner /> : 'Generate a key'}
              </button>
            )}
          </li>

          {/* 2 */}
          <li className={hasHost ? 'done' : ''}>
            <h3>Where Tern runs</h3>
            <p>The machine you would SSH into to administer Tern. That is the only thing you have to know.</p>
            <div className="row" style={{ alignItems: 'flex-end', maxWidth: 620 }}>
              <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 220 }}>
                <label htmlFor="host">SSH host</label>
                <input id="host" type="text" placeholder="mail.example.com" value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })} />
              </div>
              <div className="field" style={{ marginBottom: 0, width: 110 }}>
                <label htmlFor="sshPort">Port</label>
                <input id="sshPort" type="number" value={form.sshPort}
                  onChange={(e) => setForm({ ...form, sshPort: Number(e.target.value) })} />
              </div>
              <button disabled={busy !== null || !form.host} style={{ marginBottom: 1 }}
                onClick={() => void run('save', () => api.saveTunnel({ host: form.host, sshPort: form.sshPort, user: form.user, remotePort: form.remotePort, torProxy: form.torProxy }), 'Saved.')}>
                {busy === 'save' ? <Spinner /> : 'Save'}
              </button>
            </div>

            <div className="row" style={{ marginTop: 10 }}>
              <button className="ghost sm" onClick={() => setAdvanced(!advanced)}>
                {advanced ? 'Hide' : 'Show'} advanced settings
              </button>
              {page.config.torProxy && <Tag tone="accent">over Tor</Tag>}
            </div>
            {advanced && (
              <>
                <div className="grid cols-2" style={{ maxWidth: 480, marginTop: 8 }}>
                  <div className="field">
                    <label htmlFor="user">Tunnel account</label>
                    <input id="user" type="text" value={form.user}
                      onChange={(e) => setForm({ ...form, user: e.target.value })} />
                    <span className="hint">Created for you on the Tern box, with no shell. Not your own login.</span>
                  </div>
                  <div className="field">
                    <label htmlFor="remotePort">Port over there</label>
                    <input id="remotePort" type="number" value={form.remotePort}
                      onChange={(e) => setForm({ ...form, remotePort: Number(e.target.value) })} />
                    <span className="hint">Where Tern will find the model. Change it only if 11434 is taken.</span>
                  </div>
                </div>
                <div className="field" style={{ maxWidth: 480 }}>
                  <label htmlFor="torProxy">Dial out through a SOCKS proxy</label>
                  <div className="row">
                    <input id="torProxy" type="text" placeholder="empty = connect directly" value={form.torProxy}
                      onChange={(e) => setForm({ ...form, torProxy: e.target.value })} style={{ maxWidth: 220 }} />
                    <button className="sm" disabled={busy !== null || form.torProxy === page.config.torProxy}
                      onClick={() => void run('save', () => api.saveTunnel({ torProxy: form.torProxy }), form.torProxy ? 'Saved — the tunnel will dial out through the proxy.' : 'Saved — connecting directly.')}>
                      {busy === 'save' ? <Spinner /> : 'Save'}
                    </button>
                    {!form.torProxy && (
                      <button className="ghost sm" onClick={() => setForm({ ...form, torProxy: '127.0.0.1:9050' })}>
                        Use Tor
                      </button>
                    )}
                  </div>
                  <span className="hint">
                    <span className="mono">127.0.0.1:9050</span> for a system Tor. The Tern box then never learns
                    this machine&apos;s address, and its SSH host above can be an <span className="mono">.onion</span>,
                    which means it needs no public SSH port at all. perch waits longer and retries more slowly when
                    this is set, because Tor is slow to build a circuit.
                  </span>
                </div>
              </>
            )}
          </li>

          {/* 3 */}
          <li className={paired ? 'done' : ''}>
            <h3>Run one command on the Tern box</h3>
            <p>
              It creates the locked-down account, installs the key with restrictions so it can
              do nothing but hold this one port open, teaches sshd to reap dead tunnels, and
              prints one line to bring back.
            </p>
            {hasKey && hasHost ? (
              <>
                <CodeBlock text={page.setupCommand!} wrap />
                <details style={{ marginTop: 10 }}>
                  <summary style={{ cursor: 'pointer', color: 'var(--ink-dim)', fontSize: 12.5 }}>
                    Rather read the script before running it
                  </summary>
                  <div style={{ marginTop: 8 }}><CodeBlock text={page.setupManual} wrap /></div>
                </details>
              </>
            ) : (
              <p className="sub">Generate a key and enter the host first.</p>
            )}
          </li>

          {/* 4 */}
          <li className={paired ? 'done' : ''}>
            <h3>Paste what it printed</h3>
            <p>
              The last thing the script prints is a line beginning{' '}
              <span className="mono">perch-pair:</span>. Paste that line — or just select the
              whole output and paste all of it — and perch will finish the setup: the address,
              the service, starting the tunnel, starting it at boot, and a token.
            </p>
            <div className="field" style={{ maxWidth: 620 }}>
              <textarea
                rows={3}
                placeholder="perch-pair:v1:10.89.0.1:11434"
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
              />
              <span className="hint">
                perch cannot work this address out for itself: it belongs to the Tern box, and the
                tunnel key is restricted to <span className="mono">nologin</span>, so there is nothing
                it can ask.
              </span>
            </div>
            <button
              className="primary"
              disabled={busy !== null || !paste.trim() || !hasKey || !hasHost}
              onClick={() => void run('pair', async () => {
                const r = await api.pairTunnel(paste);
                if (r.token) setNewToken(r.token);
                setPaste('');
                const up = r.status.active === 'active';
                setMessage({
                  tone: up ? 'good' : 'bad',
                  text: up
                    ? `Connected. Tern's base URL is ${r.baseUrl}.`
                    : `Saved, but the tunnel did not come up: ${(r.steps.started?.output || '').trim().split('\n').slice(-3).join('\n') || 'see the log below'}`,
                });
              })}
            >
              {busy === 'pair' ? <Spinner /> : 'Connect'}
            </button>
          </li>

          {/* 5 */}
          <li className={running ? 'done' : ''}>
            <h3>The tunnel</h3>
            <p>
              systemd owns the connection, so it comes back after a dropped line, a router
              reboot or a power cut — not just while this page is open.
            </p>
            <div className="row" style={{ marginBottom: 10 }}>
              <Tag tone={running ? 'good' : 'bad'}>{page.status.active}</Tag>
              <Tag tone={page.status.enabled === 'enabled' ? 'good' : ''}>
                {page.status.enabled === 'enabled' ? 'starts at boot' : 'not started at boot'}
              </Tag>
              <Tag tone={page.status.endpointUp ? 'good' : 'bad'}>
                {page.status.endpointUp ? 'endpoint listening' : 'endpoint down'}
              </Tag>
              {page.config.remoteBind && paired && (
                <span className="hint mono">landing on {page.config.remoteBind}:{page.config.remotePort}</span>
              )}
            </div>
            <div className="row">
              <button disabled={busy !== null || !paired}
                onClick={() => void run('restart', () => api.tunnelAction(running ? 'restart' : 'start'), running ? 'Restarted.' : 'Started.')}>
                {busy === 'restart' ? <Spinner /> : running ? 'Restart' : 'Start'}
              </button>
              {running && (
                <button disabled={busy !== null} onClick={() => void run('stop', () => api.tunnelAction('stop'), 'Stopped.')}>
                  {busy === 'stop' ? <Spinner /> : 'Stop'}
                </button>
              )}
              <button className="ghost" disabled={busy !== null}
                onClick={() => void run('logs', async () => {
                  const r = await api.tunnelAction('logs');
                  setMessage({ tone: 'info', text: r.output.split('\n').slice(-12).join('\n') });
                })}>
                {busy === 'logs' ? <Spinner /> : 'Recent log'}
              </button>
            </div>
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: 'pointer', color: 'var(--ink-dim)', fontSize: 12.5 }}>What systemd runs</summary>
              <div style={{ marginTop: 8 }}><CodeBlock text={page.sshCommand} wrap /></div>
            </details>
          </li>
        </ol>
      </Card>

      <Card title="If you would rather do it by hand" sub="Everything above is ordinary SSH; nothing here is proprietary.">
        <p className="sub">
          The tunnel is one <span className="mono">ssh -R</span> away, and the far side needs only an
          account whose <span className="mono">authorized_keys</span> line permits it. The setup script
          is in the repository as <span className="mono">deploy/tern-side-setup.sh</span> and the systemd
          unit as <span className="mono">deploy/perch-tunnel.service.tmpl</span>. See{' '}
          <span className="mono">docs/REMOTE.md</span> for the whole thing written out, including what
          each option is for and what breaks without it.
        </p>
        <Copy text={page.sshCommand} label="Copy the ssh command" />
      </Card>
    </>
  );
}
