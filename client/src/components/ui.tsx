import { Component, useEffect, useId, useState, type ErrorInfo, type ReactNode } from 'react';

/**
 * A render error should cost you one panel, not the console.
 *
 * React unmounts the whole tree on an uncaught error, so a single bad field
 * turns every page black — no message, no navigation, nothing to act on. On
 * the machine's own control panel that is the worst possible failure: it looks
 * exactly like the console being down, and the first thing anybody does about
 * a console that is down is restart the container it was going to tell them
 * about.
 *
 * It happened for real: /api/overview stopped sending a field the Status page
 * still read, and only when no model was resident — so the console went black
 * on the exact machines with nothing loaded, which is the state you open it to
 * investigate.
 */
export class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console has no error reporting and should not grow any, but the
    // browser's own console is where somebody debugging this will look.
    console.error('perch console: a panel failed to render', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="card">
        <h2>This page did not render</h2>
        <p className="sub">
          Something on it asked for data that was not there. The rest of the console still works, and
          perch itself is unaffected — this is the page, not the machine.
        </p>
        <pre className="code" style={{ whiteSpace: 'pre-wrap' }}>{error.message}</pre>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="sm" onClick={() => this.setState({ error: null })}>Try again</button>
          <button className="sm ghost" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}

export function Card({ title, sub, right, children }: {
  title?: string; sub?: string; right?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="card">
      {(title || right) && (
        <div className="row between" style={{ marginBottom: sub ? 2 : 12 }}>
          {title && <h2>{title}</h2>}
          {right}
        </div>
      )}
      {sub && <p className="sub">{sub}</p>}
      {children}
    </section>
  );
}

export function Stat({ label, value, unit, note }: {
  label: string; value: ReactNode; unit?: string; note?: ReactNode;
}) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className="value">{value}{unit && <span className="unit">{unit}</span>}</span>
      {note && <span className="note">{note}</span>}
    </div>
  );
}

/** A bar that moves rather than jumps; see .meter in styles.css. */
export function Meter({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const tone = clamped > 92 ? 'is-bad' : clamped > 78 ? 'is-warn' : '';
  return (
    <div className={`meter ${tone}`}>
      <i style={{ width: `${clamped}%` }} />
    </div>
  );
}

/**
 * The moving graphs. Deliberately plain SVG: a charting library would be more
 * code than the whole console and would still need this much styling.
 */
export function Sparkline({ data, max, height = 46 }: { data: number[]; max?: number; height?: number }) {
  const width = 300;
  // Each chart needs its own gradient id, or several on a page share one.
  const gradient = `spark-${useId().replace(/:/g, '')}`;
  if (data.length < 2) {
    return <svg className="spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true" />;
  }
  const ceiling = Math.max(max ?? 0, ...data, 1);
  const step = width / (data.length - 1);
  const y = (v: number): number => height - (Math.max(0, v) / ceiling) * (height - 3) - 1.5;
  const points = data.map((v, i) => `${(i * step).toFixed(2)},${y(v).toFixed(2)}`);
  const line = `M${points.join(' L')}`;
  const area = `${line} L${width},${height} L0,${height} Z`;
  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="recent history">
      <defs>
        {/* A fade rather than a flat wash: a steady value would otherwise
            read as a solid block of colour rather than as a line. */}
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.30" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line className="grid-line" x1="0" y1={height / 2} x2={width} y2={height / 2} />
      <path d={area} fill={`url(#${gradient})`} />
      <path className="line" d={line} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Tag({ tone = '', children }: { tone?: 'good' | 'warn' | 'bad' | 'accent' | ''; children: ReactNode }) {
  return <span className={`tag ${tone}`}>{children}</span>;
}

export function Toggle({ checked, onChange, label, hint, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean;
}) {
  return (
    <div className="switch">
      <div className="text">
        <strong>{label}</strong>
        {hint && <span>{hint}</span>}
      </div>
      <button
        type="button"
        className="toggle"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

export function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className="sm"
      onClick={() => {
        // navigator.clipboard needs a secure context, and the console is
        // plain http on loopback — which browsers do treat as secure, but a
        // fallback costs four lines and covers the ones that do not.
        void (async () => {
          try {
            await navigator.clipboard.writeText(text);
          } catch {
            const area = document.createElement('textarea');
            area.value = text;
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            document.execCommand('copy');
            area.remove();
          }
          setDone(true);
        })();
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

export function CodeBlock({ text, wrap }: { text: string; wrap?: boolean }) {
  return (
    <div className="copyable">
      <pre className={`code ${wrap ? 'wrap' : ''}`}>{text}</pre>
      <Copy text={text} />
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'good' | 'bad' | 'warn'; children: ReactNode }) {
  return <div className={`notice ${tone}`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Spinner() {
  return <span className="spinner" aria-label="working" />;
}
