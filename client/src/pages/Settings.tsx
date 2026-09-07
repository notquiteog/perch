import { useCallback, useEffect, useState } from 'react';
import { api, relative, type TokenRecord } from '../api';
import { Card, CodeBlock, Empty, Notice, Spinner, Tag, Toggle } from '../components/ui';

export default function Settings() {
  const [tokens, setTokens] = useState<TokenRecord[]>([]);
  const [settings, setSettings] = useState<{ allowManage: boolean; keepAlive: string; unloadWhenIdle: boolean } | null>(null);
  const [routes, setRoutes] = useState<Array<{ method: string; path: string; scope: string }>>([]);
  const [proxyInfo, setProxyInfo] = useState<{ maxConcurrent: number; port: number } | null>(null);
  const [passwordSet, setPasswordSet] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState('Tern');
  const [tokenManage, setTokenManage] = useState(true);
  const [password, setPassword] = useState('');
  const [keepAlive, setKeepAlive] = useState('10m');

  const refresh = useCallback(async () => {
    const [tk, st, se] = await Promise.all([api.tokens(), api.settings(), api.session()]);
    setTokens(tk.tokens);
    setSettings(st.settings);
    setRoutes(st.proxy.routes);
    setProxyInfo({ maxConcurrent: st.proxy.maxConcurrent, port: st.proxy.port });
    setKeepAlive(st.settings.keepAlive);
    setPasswordSet(se.passwordSet);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

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

  if (!settings) return <div className="row"><Spinner /> <span className="mono">loading…</span></div>;

  const live = tokens.filter((t) => !t.revokedAt);

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
        <p>Who may use this perch, what it will do for them, and how it behaves when nobody is asking.</p>
      </div>

      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      <Card
        title="API tokens"
        sub="One per thing that connects. Shown once when created and stored only as a hash, so a token that is lost has to be replaced rather than looked up."
      >
        {fresh && (
          <div style={{ marginBottom: 14 }}>
            <Notice tone="good">Copy this now — it will not be shown again.</Notice>
            <CodeBlock text={fresh} wrap />
          </div>
        )}

        {live.length === 0 ? (
          <Empty>No tokens yet. Nothing can use this perch until there is one.</Empty>
        ) : (
          <table>
            <thead>
              <tr><th>Name</th><th>Token</th><th>May</th><th className="right">Last used</th><th /></tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} style={{ opacity: t.revokedAt ? 0.5 : 1 }}>
                  <td>{t.name}</td>
                  <td className="mono">{t.prefix}…</td>
                  <td>
                    <div className="row" style={{ gap: 5 }}>
                      <Tag>use</Tag>
                      {t.scopes.includes('manage') && <Tag tone="accent">manage models</Tag>}
                      {t.revokedAt && <Tag tone="bad">revoked</Tag>}
                    </div>
                  </td>
                  <td className="right mono">{relative(t.lastUsedAt)}</td>
                  <td className="right">
                    <div className="row end" style={{ gap: 6 }}>
                      {!t.revokedAt && (
                        <button className="sm danger" disabled={busy !== null}
                          onClick={() => { if (confirm(`Revoke "${t.name}"? Anything using it stops working at once.`)) void run('revoke', () => api.revokeToken(t.id), 'Revoked.'); }}>
                          Revoke
                        </button>
                      )}
                      {t.revokedAt && (
                        <button className="sm ghost" disabled={busy !== null}
                          onClick={() => void run('delete', () => api.deleteToken(t.id), 'Removed.')}>
                          Remove
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="row" style={{ marginTop: 16, alignItems: 'flex-end' }}>
          <div className="field" style={{ marginBottom: 0, maxWidth: 220 }}>
            <label htmlFor="tname">New token</label>
            <input id="tname" type="text" value={tokenName} onChange={(e) => setTokenName(e.target.value)} />
          </div>
          <label className="row" style={{ gap: 6, fontSize: 12.5, color: 'var(--ink-dim)', marginBottom: 8 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={tokenManage} onChange={(e) => setTokenManage(e.target.checked)} />
            may download and delete models
          </label>
          <button className="primary" disabled={busy !== null || !tokenName.trim()} style={{ marginBottom: 8 }}
            onClick={() => void run('create', async () => {
              const r = await api.createToken(tokenName.trim(), tokenManage ? ['use', 'manage'] : ['use']);
              setFresh(r.token);
            })}>
            {busy === 'create' ? <Spinner /> : 'Create'}
          </button>
        </div>
      </Card>

      <Card title="Behaviour">
        <Toggle
          checked={settings.allowManage}
          label="Allow model management over the tunnel"
          hint="Lets Tern's Admin page download and remove models on this machine. Convenient, and also the most destructive thing a leaked token could do. Off here overrides every token's scope."
          onChange={(v) => void run('manage', () => api.saveSettings({ allowManage: v }))}
        />
        <Toggle
          checked={settings.unloadWhenIdle}
          label="Drop the model from memory when idle"
          hint="After a minute with nothing generating, unload it. That frees the VRAM and with it the context cache holding whatever was last written — which on this machine is somebody's email. Costs a few seconds' load on the next request."
          onChange={(v) => void run('idle', () => api.saveSettings({ unloadWhenIdle: v }))}
        />
        <div className="field" style={{ maxWidth: 260, marginTop: 14 }}>
          <label htmlFor="ka">Keep loaded for</label>
          <div className="row">
            <input id="ka" type="text" value={keepAlive} onChange={(e) => setKeepAlive(e.target.value)} style={{ maxWidth: 120 }} />
            <button className="sm" disabled={busy !== null || keepAlive === settings.keepAlive}
              onClick={() => void run('ka', () => api.saveSettings({ keepAlive }), 'Saved.')}>
              {busy === 'ka' ? <Spinner /> : 'Save'}
            </button>
          </div>
          <span className="hint">A duration such as 30s, 10m or 1h. −1 never unloads; 0 unloads immediately after each answer.</span>
        </div>
      </Card>

      <Card
        title="Console password"
        sub="Without one, the console only answers on this machine. Set one to reach it from your laptop over your own network."
      >
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ marginBottom: 0, maxWidth: 260 }}>
            <label htmlFor="pw">{passwordSet ? 'Change the password' : 'Set a password'}</label>
            <input id="pw" type="password" value={password} placeholder="at least 10 characters"
              onChange={(e) => setPassword(e.target.value)} />
          </div>
          <button disabled={busy !== null || password.length < 10} style={{ marginBottom: 8 }}
            onClick={() => void run('pw', async () => { await api.setConsolePassword(password); setPassword(''); }, 'Password set.')}>
            {busy === 'pw' ? <Spinner /> : 'Save'}
          </button>
          {passwordSet && (
            <button className="ghost" style={{ marginBottom: 8 }} disabled={busy !== null}
              onClick={() => { if (confirm('Remove the password? The console will then only answer on this machine.')) void run('pwoff', () => api.setConsolePassword(null), 'Password removed.'); }}>
              Remove
            </button>
          )}
        </div>
      </Card>

      <Card
        title="What the tunnel exposes"
        sub={`Every endpoint reachable from the Tern box, and nothing else. Anything not on this list answers 404 whatever token it is given. At most ${proxyInfo?.maxConcurrent ?? '—'} generations run at once.`}
      >
        <table>
          <thead><tr><th>Method</th><th>Path</th><th className="right">Needs</th></tr></thead>
          <tbody>
            {routes.map((r) => (
              <tr key={`${r.method} ${r.path}`}>
                <td className="mono" style={{ width: 80 }}>{r.method}</td>
                <td className="mono">{r.path}</td>
                <td className="right">{r.scope === 'manage' ? <Tag tone="accent">manage</Tag> : <Tag>use</Tag>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="sub" style={{ marginTop: 12, marginBottom: 0 }}>
          Ollama&apos;s own API is wider than this. <span className="mono">/api/create</span> and{' '}
          <span className="mono">/api/push</span> can write a model onto this machine or ship one off it,
          so they are not in the table and cannot be reached.
        </p>
      </Card>
    </>
  );
}
