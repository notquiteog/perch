import { useEffect, useState } from 'react';
import { api, duration, human, relative, type Overview } from '../api';
import { useLive } from '../components/live';
import { Card, CodeBlock, Empty, Meter, Notice, Sparkline, Spinner, Stat, Tag } from '../components/ui';

export default function Status({ go }: { go: (page: string) => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useLive(true);

  useEffect(() => {
    const load = (): void => { void api.overview().then(setOverview).catch((e: Error) => setError(e.message)); };
    load();
    // The stream carries the fast-moving numbers; this is for the rest, which
    // changes on the scale of somebody clicking something.
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!overview) return <div className="row"><Spinner /> <span className="mono">reading the machine…</span></div>;

  const host = live.tick?.host ?? overview.host;
  const loaded = live.tick?.loaded ?? overview.loaded;
  const tp = live.tick?.throughput ?? overview.throughput;
  const gpu = host?.gpus?.[0];

  const ramTotal = (host?.mem.totalKb ?? 0) * 1024;
  const ramUsed = ramTotal - (host?.mem.availableKb ?? 0) * 1024;
  const ramPct = ramTotal ? (ramUsed / ramTotal) * 100 : 0;

  const vramTotal = (gpu?.memTotalMb ?? 0) * 1024 * 1024;
  const vramUsed = (gpu?.memUsedMb ?? 0) * 1024 * 1024;
  const vramPct = vramTotal ? (vramUsed / vramTotal) * 100 : 0;

  const cpuPct = host?.cpu.load1 && host.cpu.cores ? Math.min(100, (host.cpu.load1 / host.cpu.cores) * 100) : 0;

  return (
    <>
      <div className="page-head">
        <h1>Status</h1>
        <p>
          What this machine is doing right now. The numbers move once a second;
          nothing here is written down.
        </p>
      </div>

      {!overview.hostPresent && (
        <Notice tone="info">
          The host helper is not running, so perch cannot see the GPU, control containers
          or drive the tunnel. Install it with <span className="mono">sudo ./install.sh</span>,
          or run <span className="mono">./bin/perch hostd-install</span>.
        </Notice>
      )}
      {overview.hostPresent && overview.hostStale && (
        <Notice tone="bad">The host helper has stopped reporting. Check <span className="mono">systemctl status perch-hostd</span>.</Notice>
      )}
      {!overview.ollama.ok && (
        <Notice tone="bad">Ollama is not answering: {overview.ollama.error}</Notice>
      )}

      <div className="grid cols-4">
        <Card>
          {/* Without the host helper there is no telemetry at all, and a
              confident "0 B of 0 B" reads as a broken gauge rather than as a
              missing one. */}
          {ramTotal > 0 ? (
            <>
              <Stat
                label="Memory"
                value={human(ramUsed).split(' ')[0]}
                unit={`${human(ramUsed).split(' ')[1]} of ${human(ramTotal)}`}
                note={`${Math.round(ramPct)}% in use`}
              />
              <Meter pct={ramPct} />
              <Sparkline data={live.history.ram} max={100} />
            </>
          ) : (
            <Stat label="Memory" value="—" note="needs the host helper" />
          )}
        </Card>

        <Card>
          {gpu ? (
            <>
              <Stat
                label="VRAM"
                value={human(vramUsed).split(' ')[0]}
                unit={`${human(vramUsed).split(' ')[1]} of ${human(vramTotal)}`}
                note={gpu.name}
              />
              <Meter pct={vramPct} />
              <Sparkline data={live.history.vram} max={100} />
            </>
          ) : (
            <>
              <Stat label="VRAM" value="—" note={host ? 'no GPU detected; the model runs on the CPU' : 'needs the host helper'} />
            </>
          )}
        </Card>

        <Card>
          {gpu && gpu.utilPct !== null ? (
            <>
              <Stat
                label="GPU"
                value={Math.round(gpu.utilPct)}
                unit="%"
                note={[gpu.tempC !== null ? `${Math.round(gpu.tempC)}°C` : null, gpu.powerW !== null ? `${Math.round(gpu.powerW)} W` : null].filter(Boolean).join(' · ') || 'busy'}
              />
              <Meter pct={gpu.utilPct} />
              <Sparkline data={live.history.gpuUtil} max={100} />
            </>
          ) : (
            host ? (
              <>
                <Stat label="CPU" value={Math.round(cpuPct)} unit="%" note={`load ${host.cpu.load1?.toFixed(2) ?? '—'} over ${host.cpu.cores ?? '?'} cores`} />
                <Meter pct={cpuPct} />
                <Sparkline data={live.history.cpu} max={100} />
              </>
            ) : (
              <Stat label="CPU" value="—" note="needs the host helper" />
            )
          )}
        </Card>

        <Card>
          <Stat
            label="Throughput"
            value={tp.current.toFixed(1)}
            unit="tok/s"
            note={
              tp.last
                ? `last answer ${tp.last.toFixed(1)} tok/s${tp.ttftMs !== null ? `, first token in ${(tp.ttftMs / 1000).toFixed(1)}s` : ''}`
                : 'nothing generating'
            }
          />
          <Meter pct={Math.min(100, (tp.current / Math.max(tp.average || 30, 10)) * 100)} />
          <Sparkline data={live.history.tokens} />
        </Card>
      </div>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <Card
          title="In memory"
          sub="Models Ollama is holding. Each one keeps its weights and its context window resident until the keep-alive runs out."
          right={<span className="row" style={{ gap: 6 }}>
            <span className={`pulse ${live.connected ? 'live' : ''}`} style={{ background: live.connected ? 'var(--good)' : 'var(--ink-faint)' }} />
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{live.connected ? 'live' : 'reconnecting'}</span>
          </span>}
        >
          {loaded.length === 0 ? (
            <Empty>
              Nothing is resident. The next request loads whichever model it asks for, which takes a few
              seconds longer than the rest; on this machine the sizing suggests{' '}
              <span className="mono">{overview.sizing.recommended.name}</span>.
            </Empty>
          ) : (
            <table>
              <thead>
                <tr><th>Model</th><th className="right">Size</th><th className="right">On GPU</th><th className="right">Until</th></tr>
              </thead>
              <tbody>
                {loaded.map((m) => (
                  <tr key={m.name}>
                    <td className="mono">{m.name}</td>
                    <td className="right mono">{human(m.size)}</td>
                    <td className="right">
                      {m.size_vram > 0
                        ? <Tag tone="good">{Math.round((m.size_vram / m.size) * 100)}%</Tag>
                        : <Tag tone="warn">CPU</Tag>}
                    </td>
                    <td className="right mono">{relative(m.expires_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {overview.inFlight > 0 && (
            <p className="sub" style={{ marginTop: 12, marginBottom: 0 }}>
              <Spinner /> {overview.inFlight} generation{overview.inFlight === 1 ? '' : 's'} in flight.
            </p>
          )}
        </Card>

        <Card
          title="Connections to Tern"
          sub="Each machine running Tern has its own tunnel out of here."
        >
          {overview.connections.filter((c) => !c.retiredAt).length === 0 ? (
            <>
              <Empty>No connections yet.</Empty>
              <div style={{ textAlign: 'center' }}>
                <button className="primary" onClick={() => go('connect')}>Add a connection</button>
              </div>
            </>
          ) : (
            <table>
              <thead>
                <tr><th>Connection</th><th>Tunnel</th><th className="right">Boot</th><th className="right">Base URL</th></tr>
              </thead>
              <tbody>
                {overview.connections.filter((c) => !c.retiredAt).map((c) => (
                  <tr key={c.id}>
                    <td>
                      {c.name}
                      <div className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{c.user}@{c.host}</div>
                    </td>
                    <td>
                      {c.status.active === 'active'
                        ? <Tag tone="good">running</Tag>
                        : c.status.configured ? <Tag tone="bad">{c.status.active}</Tag> : <Tag>unfinished</Tag>}
                    </td>
                    <td className="right">{c.status.enabled === 'enabled' ? <Tag tone="good">yes</Tag> : <Tag>no</Tag>}</td>
                    <td className="right mono" style={{ fontSize: 11 }}>{c.status.configured ? c.ternBaseUrl : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <table style={{ marginTop: 12 }}>
            <tbody>
              <tr>
                <td>Model endpoint</td>
                <td className="right">{overview.endpointUp ? <Tag tone="good">listening</Tag> : <Tag tone="bad">down</Tag>}</td>
              </tr>
              <tr><td>Tokens issued</td><td className="right mono">{overview.tokens}</td></tr>
            </tbody>
          </table>
        </Card>
      </div>

      <div className="grid cols-3" style={{ marginTop: 14 }}>
        <Card title="This machine">
          <table>
            <tbody>
              <tr><td>Host</td><td className="right mono">{host?.hostname ?? '—'}</td></tr>
              <tr><td>Up</td><td className="right mono">{duration(host?.uptimeSeconds ?? null)}</td></tr>
              <tr><td>Kernel</td><td className="right mono">{host?.kernel ?? '—'}</td></tr>
              <tr><td>Ollama</td><td className="right mono">{overview.ollama.version ?? '—'}</td></tr>
              <tr><td>perch</td><td className="right mono">{overview.version}</td></tr>
            </tbody>
          </table>
        </Card>

        <Card title="Models on disk">
          <Stat label="Stored" value={human(overview.modelBytes)} note={`${overview.modelCount} model${overview.modelCount === 1 ? '' : 's'}`} />
          {host?.disk.totalKb ? (
            <>
              <Meter pct={host.disk.usedPct ?? 0} />
              <p className="sub" style={{ marginTop: 8, marginBottom: 0 }}>
                {human((host.disk.availableKb ?? 0) * 1024)} free on {host.disk.path}
              </p>
            </>
          ) : null}
          <div style={{ marginTop: 12 }}>
            <button className="sm" onClick={() => go('models')}>Manage models</button>
          </div>
        </Card>

        <Card title="Recommended for this box" sub={`Sized from ${overview.sizing.basis === 'vram' ? 'the GPU' : 'system memory'}.`}>
          <Stat label="Model" value={<span className="mono" style={{ fontSize: 17 }}>{overview.sizing.recommended.name}</span>} />
          <p className="sub" style={{ marginTop: 8, marginBottom: 0 }}>{overview.sizing.recommended.note}</p>
        </Card>
      </div>
    </>
  );
}
