import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { useLive } from './components/live';
import { Card, Notice, Spinner } from './components/ui';
import Status from './pages/Status';
import Models from './pages/Models';
import Connect from './pages/Connect';
import System from './pages/System';
import Settings from './pages/Settings';
import Activity from './pages/Activity';

const PAGES = [
  { id: 'status', label: 'Status' },
  { id: 'models', label: 'Models' },
  { id: 'connect', label: 'Connect' },
  { id: 'system', label: 'System' },
  { id: 'activity', label: 'Activity' },
  { id: 'settings', label: 'Settings' },
] as const;

type PageId = (typeof PAGES)[number]['id'];

function currentPage(): PageId {
  const hash = window.location.hash.replace('#', '');
  return (PAGES.find((p) => p.id === hash)?.id ?? 'status') as PageId;
}

export default function App() {
  const [page, setPage] = useState<PageId>(currentPage);
  const [session, setSession] = useState<{ passwordSet: boolean; authenticated: boolean; loopback: boolean; containerised: boolean; version: string } | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const load = useCallback(() => { void api.session().then(setSession).catch(() => setSession(null)); }, []);

  useEffect(() => {
    load();
    const onHash = (): void => setPage(currentPage());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [load]);

  const go = useCallback((id: string) => {
    window.location.hash = id;
    setPage(id as PageId);
  }, []);

  // The nav's status dot comes from the same stream the gauges use, so it is
  // never a separate poll telling a different story.
  const live = useLive(Boolean(session?.authenticated));

  if (!session) {
    return (
      <div className="login">
        <div className="row"><Spinner /> <span className="mono">reaching perch…</span></div>
      </div>
    );
  }

  if (!session.authenticated) {
    if (!session.passwordSet) {
      return (
        <div className="login">
          <Card title="Not from here">
            <p className="sub">
              This console has no password, so it only answers on the machine it runs on.
              Set one from that machine with <span className="mono">./bin/perch console-password</span>,
              then reload this page.
            </p>
          </Card>
        </div>
      );
    }
    return (
      <div className="login">
        <Card title="perch">
          <p className="sub">Sign in to the console.</p>
          {error && <Notice tone="bad">{error}</Notice>}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setSigningIn(true); setError(null);
              void api.signIn(password)
                .then(() => { setPassword(''); load(); })
                .catch((err: Error) => setError(err.message))
                .finally(() => setSigningIn(false));
            }}
          >
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <button className="primary" type="submit" disabled={signingIn || !password}>
              {signingIn ? <Spinner /> : 'Sign in'}
            </button>
          </form>
        </Card>
      </div>
    );
  }

  const tunnelUp = live.tick !== null && live.connected;

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          <span aria-hidden="true">🪶</span>
          <span>perch <small>{session.version}</small></span>
        </div>
        {PAGES.map((p) => (
          <button
            key={p.id}
            className="nav-item"
            aria-current={page === p.id}
            onClick={() => go(p.id)}
          >
            {p.label}
            {p.id === 'status' && (
              <span
                className={`dot ${tunnelUp ? 'pulse live' : ''}`}
                style={{ background: tunnelUp ? 'var(--good)' : 'var(--ink-faint)' }}
                title={tunnelUp ? 'live' : 'not receiving updates'}
              />
            )}
          </button>
        ))}
        <div className="sidebar-foot">
          {live.tick?.host?.hostname ?? 'perch'}
          {session.passwordSet && (
            <button className="ghost sm" style={{ display: 'block', marginTop: 6, padding: '2px 0' }}
              onClick={() => void api.signOut().then(load)}>
              Sign out
            </button>
          )}
        </div>
      </nav>

      <main className="main">
        {/* Standing, not dismissible. In a container perch cannot tell a
            request from this machine apart from one off the network, so the
            only thing keeping the console private is how the port was
            published — which is exactly the kind of fact that gets forgotten. */}
        {session.containerised && !session.passwordSet && (
          <Notice tone="bad">
            <strong>No console password.</strong> perch is running in a container, so it cannot tell
            a request from this machine apart from one off your network — the only thing keeping this
            console private is that the port is published on <span className="mono">127.0.0.1</span>.
            {' '}
            <a href="#settings" onClick={() => go('settings')}>Set a password</a> and the protection
            no longer depends on that.
          </Notice>
        )}
        {page === 'status' && <Status go={go} />}
        {page === 'models' && <Models />}
        {page === 'connect' && <Connect />}
        {page === 'system' && <System />}
        {page === 'activity' && <Activity />}
        {page === 'settings' && <Settings />}
      </main>
    </div>
  );
}
