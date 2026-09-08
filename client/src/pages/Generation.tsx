import { useCallback, useEffect, useState } from 'react';
import { api, human, type MediaFamily, type MediaModel, type MediaOverview, type MediaServiceStatus } from '../api';
import { Card, CodeBlock, Notice, Spinner, Tag } from '../components/ui';

/**
 * Image, video and audio models.
 *
 * These cards deliberately do not look like the Ollama ones above them, for
 * the same reason the dictation card does not: a diffusion server has no model
 * API. It reads a directory when it starts and there is no HTTP call that will
 * put a file in it, so a Download button here would be a lie. What there is
 * instead is the catalogue — every file, its real size, and what the model
 * wants on the card — whether the backend can currently see it, and the one
 * command that installs it.
 *
 * "Installed" is asked of the backend rather than remembered here, which is
 * why a model somebody copied in by hand shows up too, and why nothing shows
 * up at all while the container is still starting.
 */

const FAMILIES: Array<{ id: MediaFamily; title: string; sub: string }> = [
  {
    id: 'image',
    title: 'Image generation',
    sub: 'Checkpoints for the image service. Sizes are the download; the note beside each is about the memory it wants while it works.',
  },
  {
    id: 'video',
    title: 'Video generation',
    sub: 'The most expensive thing perch runs. A few seconds of video is minutes of work on a card that also has to hold a text encoder, so the smallest of these is the one to start with.',
  },
  {
    id: 'audio',
    title: 'Audio generation',
    sub: 'Speech out, as dictation is speech in — and music, which is a diffusion model and so runs in the video service’s container rather than one of its own.',
  },
];

/** Which service has to be running for a model to be usable, in words. */
const SERVICE_LABEL: Record<string, string> = {
  image: 'image service',
  video: 'video service',
  audio: 'audio service',
};

const OVERLAY: Record<string, string> = {
  image: 'compose.image.yml',
  video: 'compose.video.yml',
  audio: 'compose.audio.yml',
};

export default function Generation() {
  const [data, setData] = useState<MediaOverview | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setData(await api.media()); } catch { /* the page above already says when the console is unreachable */ }
  }, []);

  useEffect(() => {
    void refresh();
    // Slower than the Ollama poll: nothing here changes without somebody
    // running a command on the host first.
    const t = setInterval(() => { void refresh(); }, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!data) return null;

  const statusOf = (id: string): MediaServiceStatus | undefined => data.services.find((s) => s.id === id);

  const installed = (m: MediaModel): boolean => {
    const s = statusOf(m.service);
    if (!s?.ok) return false;
    if (m.bundled) return true;
    if (m.files.length === 0) return false;
    const have = new Set(s.installed);
    return m.files.every((f) => have.has(f.dest.split('/').pop()!));
  };

  return (
    <>
      {FAMILIES.map((family) => {
        const models = data.models.filter((m) => m.family === family.id);
        // A family can need more than one container — music is a video-service
        // model — so the badge is per service, not per card.
        const services = [...new Set(models.map((m) => m.service))];
        return (
          <Card
            key={family.id}
            title={family.title}
            sub={family.sub}
            right={
              <div className="row" style={{ gap: 6 }}>
                {services.map((id) => {
                  const s = statusOf(id);
                  if (!s) return null;
                  return !s.enabled ? <Tag key={id}>{SERVICE_LABEL[id]} off</Tag>
                    : s.ok ? <Tag key={id} tone="good">{SERVICE_LABEL[id]} answering</Tag>
                    : s.starting ? <Tag key={id} tone="warn">{SERVICE_LABEL[id]} starting</Tag>
                    : <Tag key={id} tone="bad">{SERVICE_LABEL[id]} not answering</Tag>;
                })}
              </div>
            }
          >
            {/* The notices are about this card's own service only. A family
                can include a model that runs elsewhere — FLUX and ACE-Step
                are ComfyUI workflows — and repeating the video service's
                state on three cards is noise. The badge above and the tag on
                the row say where those run. */}
            {services.filter((id) => id === family.id).map((id) => {
              const s = statusOf(id);
              if (!s || s.enabled) return null;
              return (
                <Notice key={id} tone="info">
                  The {SERVICE_LABEL[id]} is not switched on for this machine, so nothing below that needs it
                  will run yet. To switch it on: re-run <span className="mono">sudo ./install.sh</span> and say
                  yes, or add <span className="mono">{OVERLAY[id]}</span> to COMPOSE_FILE and{' '}
                  <span className="mono">{id}</span> to PERCH_SERVICES in .env. The files can be fetched either
                  way — they sit in a volume and wait.
                </Notice>
              );
            })}
            {services.filter((id) => id === family.id).map((id) => {
              const s = statusOf(id);
              if (!s?.enabled || s.ok || !s.starting) return null;
              return (
                <Notice key={id} tone="info">
                  <span className="row" style={{ gap: 8 }}>
                    <Spinner />
                    <span>
                      The {SERVICE_LABEL[id]} is not answering yet. These images unpack several gigabytes on
                      first start and hold their port closed until they are ready, so this is usually that
                      rather than a fault — the container&rsquo;s log is where it is visible. Nothing can be
                      listed as installed until it answers.
                    </span>
                  </span>
                </Notice>
              );
            })}

            <table>
              <tbody>
                {models.map((m) => (
                  <tr key={m.id}>
                    <td style={{ width: '30%' }}>
                      <div className="mono">{m.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
                        {m.params} · {m.bundled ? 'in the image' : `${human(m.sizeBytes)} download`} · wants {human(m.needsBytes)}
                        {/* Where a model runs somewhere other than the obvious
                            container, say so on the row rather than in a
                            footnote nobody reads before a 17 GB download. */}
                        {m.service !== family.id && <> · <span style={{ color: 'var(--accent)' }}>{SERVICE_LABEL[m.service]}</span></>}
                      </div>
                    </td>
                    <td style={{ color: 'var(--ink-dim)', fontSize: 12.5 }}>{m.note}</td>
                    <td className="right" style={{ width: 120 }}>
                      {m.bundled ? <Tag tone="good">in the image</Tag>
                        : installed(m) ? <Tag tone="good">installed</Tag>
                        : (
                          <button className="sm" onClick={() => setChosen(chosen === m.id ? null : m.id)}>
                            {chosen === m.id ? 'Hide' : 'Install'}
                          </button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {models.filter((m) => m.id === chosen).map((m) => (
              <Notice key={m.id} tone="info">
                <div style={{ marginBottom: 8 }}>
                  <strong>{m.name}</strong> is {human(m.sizeBytes)} in{' '}
                  {m.files.length === 1 ? 'one file' : `${m.files.length} files`}, written into the{' '}
                  {SERVICE_LABEL[m.service]}&rsquo;s volume. perch cannot do this itself — the console
                  container has no business writing into another container&rsquo;s storage — so it is one
                  command on the machine:
                </div>
                <CodeBlock text={`sudo ./bin/perch fetch ${m.id}`} />
                {/* The address as well as the destination, because the
                    command above needs the console API and a console with a
                    password set cannot be reached from a script. This is what
                    makes that case recoverable by hand. */}
                <table style={{ marginTop: 10 }}>
                  <tbody>
                    {m.files.map((f) => (
                      <tr key={f.dest}>
                        <td>
                          <div className="mono" style={{ fontSize: 11.5 }}>{f.dest}</div>
                          <div className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)', wordBreak: 'break-all' }}>{f.url}</div>
                        </td>
                        <td className="right mono" style={{ fontSize: 11.5, width: 90, verticalAlign: 'top' }}>{human(f.bytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="sub" style={{ marginTop: 8, marginBottom: 0 }}>
                  It resumes if it is interrupted, and skips a file that is already there, so running it
                  twice is safe. The {SERVICE_LABEL[m.service]} finds a new file when it restarts.
                </div>
              </Notice>
            ))}
          </Card>
        );
      })}
    </>
  );
}
