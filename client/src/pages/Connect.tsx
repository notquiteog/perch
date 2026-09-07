import { useCallback, useEffect, useState } from 'react';
import { api, type TokenRecord, type TunnelPage } from '../api';
import { Card, CodeBlock, Copy, Notice, Spinner, Tag } from '../components/ui';

/**
 * The setup flow, in the order a person actually does it: make a key, say
 * where Tern lives, authorise the key over there, start the tunnel, then hand
 * Tern its two settings. Each step shows whether it is done, so coming back to
 * a half-finished setup picks up where it left off.
 */
export default function Connect() {
  const [page, setPage] = useState<TunnelPage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad' | 'info'; text: string } | null>(null);
  const [form, setForm] = useState({ host: '', user: 'perch', sshPort: 22, remoteBind: '', remotePort: 11434 });
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenRecord[]>([]);

  const refresh = useCallback(async () => {
    const [t, tk] = await Promise.all([api.tunnel(), api.tokens()]);
    setPage(t);
    setTokens(tk.tokens.filter((x) => !x.revokedAt));
    setForm({
      host: t.config.host,
      user: t.config.user,
      sshPort: t.config.sshPort,
      remoteBind: t.config.remoteBind,
      remotePort: t.config.remotePort,
    });
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
  const hasTarget = Boolean(page.config.host);
  const running = page.status.active === 'active';

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

      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      <Card>
        <ol className="steps">
          {/* 1 — the key */}
          <li className={hasKey ? 'done' : ''}>
            <h3>A key for the tunnel</h3>
            <p>
              Generated here and never leaves this machine. It is used for nothing but
              holding the tunnel open, and the far side restricts it to exactly that.
            </p>
            {hasKey ? (
              <>
                <CodeBlock text={page.publicKey!} wrap />
                <p className="sub" style={{ marginTop: 8, marginBottom: 0 }}>
                  <Tag tone="good">key ready</Tag> Private half stays at{' '}
                  <span className="mono">{page.config.keyPath}</span>.
                </p>
              </>
            ) : (
              <button className="primary" disabled={busy !== null} onClick={() => void run('key', api.generateKey, 'Key generated.')}>
                {busy === 'key' ? <Spinner /> : 'Generate a key'}
              </button>
            )}
          </li>

          {/* 2 — where Tern is */}
          <li className={hasTarget ? 'done' : ''}>
            <h3>Where Tern runs</h3>
            <p>
              The machine you would SSH into to administer Tern. The account below is
              created for you in the next step — it is not your own login.
            </p>
            <div className="grid cols-2" style={{ maxWidth: 620 }}>
              <div className="field">
                <label htmlFor="host">Host</label>
                <input id="host" type="text" placeholder="mail.example.com" value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })} />
                <span className="hint">Hostname or IP of the Tern box.</span>
              </div>
              <div className="field">
                <label htmlFor="sshPort">SSH port</label>
                <input id="sshPort" type="number" value={form.sshPort}
                  onChange={(e) => setForm({ ...form, sshPort: Number(e.target.value) })} />
                <span className="hint">22 unless you moved it.</span>
              </div>
              <div className="field">
                <label htmlFor="user">Tunnel account</label>
                <input id="user" type="text" value={form.user}
                  onChange={(e) => setForm({ ...form, user: e.target.value })} />
                <span className="hint">Created on the Tern box, with no shell.</span>
              </div>
              <div className="field">
                <label htmlFor="remotePort">Port over there</label>
                <input id="remotePort" type="number" value={form.remotePort}
                  onChange={(e) => setForm({ ...form, remotePort: Number(e.target.value) })} />
                <span className="hint">Where Tern will find the model.</span>
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="remoteBind">Address to land on</label>
                <input id="remoteBind" type="text" placeholder="filled in by the setup script" value={form.remoteBind}
                  onChange={(e) => setForm({ ...form, remoteBind: e.target.value })} />
                <span className="hint">
                  Tern runs in a container, so loopback on the Tern box is not reachable from
                  inside it — this is the podman bridge address instead. The setup script in the
                  next step works it out and prints it. Only private addresses are accepted.
                </span>
              </div>
            </div>
            <button
              disabled={busy !== null || !form.host || !form.remoteBind}
              onClick={() => void run('save', () => api.saveTunnel(form), 'Saved, and the tunnel service was rewritten.')}
            >
              {busy === 'save' ? <Spinner /> : 'Save'}
            </button>
          </li>

          {/* 3 — the far side */}
          <li>
            <h3>Authorise the key on the Tern box</h3>
            <p>
              Run this over there, once. It creates the locked-down account, installs the key
              with restrictions so it can do nothing but hold this one port open, and prints
              the address to put in the box above.
            </p>
            {hasKey ? (
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
              <p className="sub">Generate a key first.</p>
            )}
          </li>

          {/* 4 — start it */}
          <li className={running ? 'done' : ''}>
            <h3>Start the tunnel</h3>
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
            </div>
            <div className="row">
              <button className="primary" disabled={busy !== null || !hasTarget}
                onClick={() => void run('start', () => api.tunnelAction(running ? 'restart' : 'start'), running ? 'Restarted.' : 'Started.')}>
                {busy === 'start' ? <Spinner /> : running ? 'Restart' : 'Start'}
              </button>
              {running && (
                <button disabled={busy !== null} onClick={() => void run('stop', () => api.tunnelAction('stop'), 'Stopped.')}>
                  {busy === 'stop' ? <Spinner /> : 'Stop'}
                </button>
              )}
              <button disabled={busy !== null}
                onClick={() => void run('boot', () => api.tunnelAction(page.status.enabled === 'enabled' ? 'disable' : 'enable'),
                  page.status.enabled === 'enabled' ? 'It will no longer start at boot.' : 'It will start at boot.')}>
                {busy === 'boot' ? <Spinner /> : page.status.enabled === 'enabled' ? 'Do not start at boot' : 'Start at boot'}
              </button>
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

          {/* 5 — tell Tern */}
          <li>
            <h3>Give Tern its two settings</h3>
            <p>In Tern, open <strong>Admin → AI model</strong>, set the provider to Ollama, and paste these.</p>

            <div className="field" style={{ maxWidth: 560 }}>
              <label>Base URL</label>
              <CodeBlock text={page.ternBaseUrl} />
              <span className="hint">
                If Tern cannot reach that name, use the address directly:{' '}
                <span className="mono">{page.ternBaseUrlLiteral}</span>
              </span>
            </div>

            <div className="field" style={{ maxWidth: 560 }}>
              <label>API key</label>
              {newToken ? (
                <>
                  <CodeBlock text={newToken} wrap />
                  <span className="hint">
                    Copy it now — this is the only time it is shown. perch keeps a hash, not the token.
                  </span>
                </>
              ) : (
                <>
                  <div className="row">
                    <button
                      disabled={busy !== null}
                      onClick={() => void run('token', async () => {
                        const r = await api.createToken('Tern', ['use', 'manage']);
                        setNewToken(r.token);
                      })}
                    >
                      {busy === 'token' ? <Spinner /> : 'Make a token for Tern'}
                    </button>
                    {tokens.length > 0 && (
                      <span className="hint">
                        {tokens.length} token{tokens.length === 1 ? '' : 's'} already issued — manage them under Settings.
                      </span>
                    )}
                  </div>
                  <span className="hint">
                    Issued with model management, so Tern&apos;s own Admin page can download and
                    remove models on this machine. Drop that under Settings if you would rather it could not.
                  </span>
                </>
              )}
            </div>

            <p className="sub" style={{ marginBottom: 0 }}>
              Then press <strong>Test connection</strong> in Tern. If it fails, the Activity page here
              shows whether the request arrived at all — which tells you whether to look at the tunnel
              or at Tern.
            </p>
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
