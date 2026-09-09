import { useCallback, useEffect, useState } from 'react';
import { api, human, relative, type PerchSettings, type ServiceInfo, type TokenRecord } from '../api';
import { Card, CodeBlock, Empty, Notice, Spinner, Tag, Toggle } from '../components/ui';

export default function Settings() {
  const [tokens, setTokens] = useState<TokenRecord[]>([]);
  const [settings, setSettings] = useState<PerchSettings | null>(null);
  // Edited per service and saved on blur, so a half-typed proxy URL is never
  // sent — the server refuses a malformed one, and refusing on every keystroke
  // would be a form that argues while you type.
  const [proxyDraft, setProxyDraft] = useState<Record<string, string>>({});
  // Held separately from `settings` because the key is never sent back: the
  // field is blank until somebody types in it, and a blank one on save means
  // "leave the stored key alone" rather than "clear it".
  const [upstreamDraft, setUpstreamDraft] = useState<Record<string, { url?: string; key?: string }>>({});
  const [services, setServices] = useState<ServiceInfo[]>([]);
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
    setServices(st.services);
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
          <span className="hint">A duration such as 30s, 10m or 1h. <span className="mono">-1</span> never unloads; <span className="mono">0</span> unloads immediately after each answer.</span>
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
        title="Services"
        sub="Each is a separate endpoint on its own port, with its own allowlist. Switching one on is a compose overlay and a re-run of the installer; they are off by default because each is another claim on the same GPU."
      >
        {services.map((svc) => (
          <div key={svc.id} style={{ borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 12 }}>
            <div className="row between">
              <div>
                <strong>{svc.label}</strong>{' '}
                {svc.enabled ? <Tag tone="good">on, port {svc.port}</Tag> : <Tag>off</Tag>}
                {svc.id === 'chat' && <Tag tone="accent">always on</Tag>}
              </div>
              <span className="hint mono">~{human(svc.vramHintBytes)} on the card</span>
            </div>
            <p className="sub" style={{ margin: '6px 0 0' }}>{svc.blurb}</p>
            <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              {svc.api.map((shape) => <Tag key={shape}>{shape}</Tag>)}
            </div>
            {/* What is BEHIND this service, when it is not the container perch
                ships. Only chat has a choice today; the control is drawn from
                `upstreamApis` rather than from `svc.id === 'chat'`, so a
                second one later is a list entry on the server and nothing
                here. */}
            {svc.upstreamApis.length > 1 && (
              <div style={{ marginTop: 10, padding: 10, border: '1px solid var(--line)', borderRadius: 6 }}>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <span className="hint">Behind it</span>
                  {svc.upstreamApis.map((shape) => (
                    <button
                      key={shape}
                      className={(settings?.upstreams?.[svc.id]?.api || svc.upstreamApis[0]) === shape ? '' : 'ghost'}
                      disabled={busy !== null}
                      onClick={() => void run(`upstream-${svc.id}`, () => api.saveSettings({ upstreams: { [svc.id]: { api: shape } } }))}
                    >
                      {shape === 'ollama' ? 'Ollama (this box)' : shape === 'openai' ? 'OpenAI-compatible' : 'Anthropic'}
                    </button>
                  ))}
                </div>
                <p className="hint" style={{ margin: '6px 0 0' }}>
                  {(settings?.upstreams?.[svc.id]?.api || svc.upstreamApis[0]) === 'ollama'
                    ? 'The models on this machine. Every endpoint is streamed straight through — perch never reads a request body.'
                    : 'perch becomes the front door for a hosted API: the same token, the same allowlist, the same proxy and the same activity log, in front of somebody else’s models. Endpoints that shape does not serve are translated, and pulling or deleting a model is refused — there is no file here to fetch or remove.'}
                </p>
                {(settings?.upstreams?.[svc.id]?.api || svc.upstreamApis[0]) !== 'ollama' && (
                  <>
                    <label style={{ display: 'block', marginTop: 8 }}>
                      <span className="hint">Its address</span>
                      <input
                        className="mono"
                        style={{ width: '100%', marginTop: 4 }}
                        placeholder="https://api.openai.com/v1"
                        value={upstreamDraft[svc.id]?.url ?? settings?.upstreams?.[svc.id]?.url ?? ''}
                        onChange={(e) => setUpstreamDraft({ ...upstreamDraft, [svc.id]: { ...upstreamDraft[svc.id], url: e.target.value } })}
                        onBlur={() => {
                          const url = upstreamDraft[svc.id]?.url;
                          if (url === undefined || url === (settings?.upstreams?.[svc.id]?.url ?? '')) return;
                          void run(`upstream-url-${svc.id}`, () => api.saveSettings({ upstreams: { [svc.id]: { url } } }));
                        }}
                      />
                      <span className="hint">
                        The server’s root — https://api.groq.com/openai/v1, https://openrouter.ai/api/v1,
                        https://api.together.xyz/v1, https://api.anthropic.com. Anything speaking one of these
                        shapes works, listed here or not.
                      </span>
                    </label>
                    <label style={{ display: 'block', marginTop: 8 }}>
                      <span className="hint">perch’s key for it</span>
                      <input
                        type="password"
                        className="mono"
                        style={{ width: '100%', marginTop: 4 }}
                        placeholder={settings?.upstreams?.[svc.id]?.hasKey ? 'a key is stored — leave blank to keep it' : 'sk-…'}
                        value={upstreamDraft[svc.id]?.key ?? ''}
                        onChange={(e) => setUpstreamDraft({ ...upstreamDraft, [svc.id]: { ...upstreamDraft[svc.id], key: e.target.value } })}
                        onBlur={() => {
                          const key = upstreamDraft[svc.id]?.key;
                          if (!key) return;
                          void run(`upstream-key-${svc.id}`, async () => {
                            await api.saveSettings({ upstreams: { [svc.id]: { key } } });
                            setUpstreamDraft({ ...upstreamDraft, [svc.id]: { ...upstreamDraft[svc.id], key: '' } });
                          }, 'Key saved.');
                        }}
                      />
                      <span className="hint">
                        This is perch’s credential for that service, never a caller’s token. A client on the far
                        end of a tunnel holds a perch token and never sees this one, so it rotates here without
                        touching anything — and a leaked perch token cannot be replayed against the provider.
                      </span>
                    </label>
                  </>
                )}
              </div>
            )}
            {/* Where this service's upstream is, and how it is reached. Both
                are per service because the four upstreams are four different
                servers: a chat model on a rented box across the internet and a
                whisper container one bridge away are not the same journey and
                should not share one decision. */}
            <label style={{ display: 'block', marginTop: 8 }}>
              <span className="hint">
                Upstream <span className="mono">{svc.upstream}</span> — proxy
              </span>
              <input
                className="mono"
                style={{ width: '100%', marginTop: 4 }}
                placeholder="direct — or socks5h://127.0.0.1:9150 for Tor"
                value={proxyDraft[svc.id] ?? settings?.proxies?.[svc.id] ?? ''}
                onChange={(e) => setProxyDraft({ ...proxyDraft, [svc.id]: e.target.value })}
                onBlur={() => {
                  const value = proxyDraft[svc.id];
                  if (value === undefined || value === (settings?.proxies?.[svc.id] ?? '')) return;
                  void run(`proxy-${svc.id}`, () => api.saveSettings({ proxies: { [svc.id]: value } }));
                }}
              />
              <span className="hint">
                {(settings?.proxies?.[svc.id] ?? '')
                  ? 'This service reaches its upstream through that proxy; the others are unaffected.'
                  : `Empty is a direct connection. Preset with ${svc.proxyEnv} in .env.`}
              </span>
            </label>
            {svc.ternField && (
              <p className="hint" style={{ margin: '4px 0 0' }}>
                Goes in Tern under <span className="mono">{svc.ternField}</span>.
              </p>
            )}
            {!svc.enabled && svc.overlay && (
              <p className="hint" style={{ margin: '4px 0 0' }}>
                To switch on: re-run <span className="mono">sudo ./install.sh</span> and say yes, or add{' '}
                <span className="mono">{svc.overlay}</span> to COMPOSE_FILE in .env.
              </p>
            )}
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', color: 'var(--ink-dim)', fontSize: 12.5 }}>
                What it exposes ({svc.routes.length} endpoint{svc.routes.length === 1 ? '' : 's'})
              </summary>
              <table style={{ marginTop: 8 }}>
                <tbody>
                  {svc.routes.map((r) => (
                    <tr key={`${r.method} ${r.path}`}>
                      <td className="mono" style={{ width: 80 }}>{r.method}</td>
                      <td className="mono">{r.path}</td>
                      <td className="right">{r.scope === 'manage' ? <Tag tone="accent">manage</Tag> : <Tag>use</Tag>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </div>
        ))}
        <p className="sub" style={{ marginTop: 14, marginBottom: 0 }}>
          Anything not listed above answers 404 whatever token it is given. Enabled services want{' '}
          <strong>{human(services.filter((s) => s.enabled).reduce((n, s) => n + s.vramHintBytes, 0))}</strong>{' '}
          between them — if that is more than the card has, whichever was used last holds it and the
          others fall back to system memory.
        </p>
      </Card>

    </>
  );
}
