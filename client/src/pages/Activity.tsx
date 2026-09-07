import { useCallback, useEffect, useState } from 'react';
import { api, human, relative } from '../api';
import { Card, Empty, Notice, Spinner, Tag } from '../components/ui';

type Entry = Awaited<ReturnType<typeof api.activity>>['entries'][number];

export default function Activity() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [summary, setSummary] = useState<{ total: number; errors: number; lastAt: string | null } | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const r = await api.activity(200);
    setEntries(r.entries);
    setSummary(r.summary);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => { void refresh(); }, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  if (loading) return <div className="row"><Spinner /> <span className="mono">loading…</span></div>;

  return (
    <>
      <div className="page-head">
        <h1>Activity</h1>
        <p>
          What has come through the model endpoint since perch started. Useful for one question
          above all: when Tern says the model is unreachable, did the request arrive here at all?
        </p>
      </div>

      <Notice tone="info">
        This records that a request happened — the endpoint, the status, how long it took.
        It does not record prompts, replies, or any part of a message. It is held in memory
        and is gone when perch restarts.
      </Notice>

      <Card
        title="Requests"
        sub={summary ? `${summary.total} since starting, ${summary.errors} refused or failed. Last ${relative(summary.lastAt)}.` : undefined}
      >
        {entries.length === 0 ? (
          <Empty>Nothing yet. When Tern first asks for something, it will appear here.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th><th>Endpoint</th><th>Token</th>
                <th className="right">Status</th><th className="right">Took</th><th className="right">Sent</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.at}-${i}`}>
                  <td className="mono" style={{ color: 'var(--ink-faint)' }}>{relative(e.at)}</td>
                  <td className="mono">
                    <span style={{ color: 'var(--ink-faint)' }}>{e.method}</span> {e.path}
                  </td>
                  <td>{e.token ?? <span style={{ color: 'var(--ink-faint)' }}>—</span>}</td>
                  <td className="right">
                    {e.status < 300
                      ? <Tag tone="good">{e.status}</Tag>
                      : e.status < 500
                        ? <Tag tone="warn">{e.status}{e.note ? ` ${e.note}` : ''}</Tag>
                        : <Tag tone="bad">{e.status}</Tag>}
                  </td>
                  <td className="right mono">{e.ms < 1000 ? `${e.ms}ms` : `${(e.ms / 1000).toFixed(1)}s`}</td>
                  <td className="right mono">{e.bytes ? human(e.bytes) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
