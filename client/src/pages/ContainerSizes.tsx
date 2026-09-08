import { useCallback, useEffect, useState } from 'react';
import { api, human, type ContainerSize } from '../api';
import { Card, Notice, Spinner, Tag } from '../components/ui';

/**
 * How big each container may be.
 *
 * Two numbers per row, and the gap between them is the point. **Configured**
 * is what .env asks for, read from the environment compose handed the console
 * rather than from a value the console remembers. **Running** is what the
 * container was actually created with, read from podman. A limit that has
 * been written but not applied shows as a difference between the two, which is
 * the honest version of "restart to apply" — compose fixes resources when it
 * *creates* a container, so a plain restart would leave the new number in the
 * file doing nothing.
 *
 * Memory limits are not throttles. A container that asks for one byte past its
 * limit is killed, so a limit set too low does not make things slow, it makes
 * them die halfway through loading a model — which is why the server refuses a
 * value below what each one needs and says the number.
 */

/** A limit as a person writes it, in bytes, for adding up and comparing. */
function memBytes(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d+(?:\.\d+)?)\s*([kmgKMG])?[bB]?$/.exec(value.trim());
  if (!m) return null;
  const scale = { g: 1024 ** 3, m: 1024 ** 2, k: 1024, '': 1 }[(m[2] ?? '').toLowerCase() as 'g' | 'm' | 'k' | ''];
  return Math.round(Number(m[1]) * scale);
}

const shownMem = (c: ContainerSize): string => c.configuredMem ?? c.defaultMem;
const shownCpus = (c: ContainerSize): string => c.configuredCpus ?? '0';

export default function ContainerSizes({ hostUp }: { hostUp: boolean }) {
  const [rows, setRows] = useState<ContainerSize[]>([]);
  const [totalMemBytes, setTotalMemBytes] = useState(0);
  const [edit, setEdit] = useState<Record<string, { mem: string; cpus: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad' | 'info'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.containers();
      setRows(r.containers);
      setTotalMemBytes(r.totalMemBytes);
    } catch { /* the page above already says when the console is unreachable */ }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => { void refresh(); }, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  const save = async (c: ContainerSize, apply: boolean): Promise<void> => {
    const pending = edit[c.id] ?? { mem: shownMem(c), cpus: shownCpus(c) };
    // Recreating perch recreates the container serving this page, so the
    // answer to this request never arrives. Saying so first is the difference
    // between "the console is restarting" and "the console is broken".
    if (apply && c.id === 'perch' && !confirm('Recreating perch restarts this console. The page will fail to load for a few seconds and then come back. Carry on?')) return;
    setBusy(c.id);
    setMessage(null);
    try {
      const r = await api.setContainerSize(c.id, { mem: pending.mem, cpus: pending.cpus, apply });
      setRows(r.containers);
      if (!r.ok) setMessage({ tone: 'bad', text: r.set.find((x) => !x.ok)?.output ?? 'the console could not write the new size' });
      else if (r.applied && !r.applied.ok) setMessage({ tone: 'bad', text: `Written, but the container did not come back: ${r.applied.output.trim().split('\n').slice(-3).join('\n')}` });
      else if (apply) setMessage({ tone: 'good', text: `${c.label} was recreated at its new size.` });
      else setMessage({ tone: 'good', text: `Saved. ${c.label} keeps its current size until it is recreated.` });
      setEdit((e) => { const { [c.id]: _gone, ...rest } = e; return rest; });
    } catch (e) {
      setMessage({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  if (rows.length === 0) return null;

  const live = rows.filter((c) => c.enabled);
  // Limits may safely add up to more than the machine has — they are ceilings,
  // not reservations, and nothing is claimed until it is used. Worth saying,
  // because the alternative reading is alarming and wrong.
  const claimed = live.reduce((n, c) => n + (memBytes(shownMem(c)) ?? 0), 0);

  return (
    <Card
      title="Container sizes"
      sub="How much of this machine each container may take. Written into .env, which compose reads when it creates a container — so a change here applies on recreate, not on restart."
      right={<Tag>{live.length} of {rows.length} switched on</Tag>}
    >
      {message && <Notice tone={message.tone}><span style={{ whiteSpace: 'pre-wrap' }}>{message.text}</span></Notice>}

      <table>
        <thead>
          <tr>
            <th>Container</th>
            <th style={{ width: 110 }}>Memory</th>
            <th style={{ width: 90 }}>CPUs</th>
            <th className="right">Running with</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const pending = edit[c.id];
            const mem = pending?.mem ?? shownMem(c);
            const cpus = pending?.cpus ?? shownCpus(c);
            const changed = pending !== undefined && (pending.mem !== shownMem(c) || pending.cpus !== shownCpus(c));
            const configuredBytes = memBytes(shownMem(c));
            // Null means no limit at either end, so "unset here and unlimited
            // there" is agreement rather than drift.
            const drifted = c.running && (c.effectiveMemBytes ?? 0) !== (configuredBytes ?? 0);
            return (
              <tr key={c.id} style={{ opacity: c.enabled ? 1 : 0.5 }}>
                <td>
                  <div className="mono">{c.id}</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
                    {/* The compose name is above; repeating it as a label
                        for the one container named after itself is noise. */}
                    {c.label !== c.id && c.label}
                    {c.label !== c.id && (!c.enabled || !c.running) && ' · '}
                    {!c.enabled ? 'not switched on' : !c.running ? 'not running' : ''}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ink-dim)', marginTop: 4, maxWidth: 460 }}>{c.note}</div>
                  {!c.known && c.enabled && (
                    <div style={{ fontSize: 12, color: 'var(--ink-faint)', marginTop: 4 }}>
                      This container was started before its size was passed through, so the default is
                      shown rather than what it was given. <span className="mono">./bin/perch up</span> fixes that.
                    </div>
                  )}
                </td>
                <td>
                  <input
                    type="text"
                    value={mem}
                    aria-label={`${c.label} memory limit`}
                    placeholder={c.defaultMem || '0'}
                    disabled={busy !== null}
                    onChange={(e) => setEdit((s) => ({ ...s, [c.id]: { mem: e.target.value, cpus } }))}
                    style={{ maxWidth: 90 }}
                  />
                  <span className="hint">min {human(c.floorBytes)}</span>
                </td>
                <td>
                  <input
                    type="text"
                    value={cpus}
                    aria-label={`${c.label} CPU limit`}
                    placeholder="0"
                    disabled={busy !== null}
                    onChange={(e) => setEdit((s) => ({ ...s, [c.id]: { mem, cpus: e.target.value } }))}
                    style={{ maxWidth: 70 }}
                  />
                  <span className="hint">0 = all</span>
                </td>
                <td className="right mono" style={{ fontSize: 12 }}>
                  {!c.running ? '—' : (
                    <>
                      {c.effectiveMemBytes ? human(c.effectiveMemBytes) : 'no limit'}
                      {' · '}
                      {c.effectiveCpus ? `${c.effectiveCpus} cores` : 'all cores'}
                      {drifted && <div><Tag tone="warn">not applied yet</Tag></div>}
                    </>
                  )}
                </td>
                <td className="right">
                  <div className="row end" style={{ gap: 6 }}>
                    <button className="sm" disabled={!hostUp || busy !== null || !changed}
                      onClick={() => void save(c, false)}>
                      {busy === c.id ? <Spinner /> : 'Save'}
                    </button>
                    <button className="sm" disabled={!hostUp || busy !== null || (!changed && !drifted)}
                      onClick={() => void save(c, true)}>
                      {changed ? 'Save and recreate' : 'Recreate'}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="sub" style={{ marginTop: 14, marginBottom: 0 }}>
        A memory limit is a ceiling, not a reservation: the containers switched on here may claim up
        to <strong>{human(claimed)}</strong> between them of this machine&rsquo;s {human(totalMemBytes)},
        and that is fine — nothing is taken until it is used. What matters is that each ceiling clears
        what that container actually needs, because past its limit a container is killed rather than
        slowed. None of this touches video memory: what shares the card is a matter of which models
        you load, which the Models page and the Services panel are about.
      </p>
    </Card>
  );
}
