// One event stream for the whole console. The server sends a tick a second;
// this keeps the latest of everything plus a short history for the graphs, and
// every panel reads from here rather than polling on its own.
import { useEffect, useRef, useState } from 'react';
import type { Tick } from '../api';

const HISTORY = 90; // a minute and a half, which is what the sparklines show

export interface LiveState {
  tick: Tick | null;
  connected: boolean;
  history: {
    ram: number[];
    vram: number[];
    gpuUtil: number[];
    tokens: number[];
    cpu: number[];
  };
}

const EMPTY: LiveState = {
  tick: null,
  connected: false,
  history: { ram: [], vram: [], gpuUtil: [], tokens: [], cpu: [] },
};

function push(list: number[], value: number): number[] {
  const next = list.length >= HISTORY ? list.slice(list.length - HISTORY + 1) : list.slice();
  next.push(value);
  return next;
}

export function useLive(enabled: boolean): LiveState {
  const [state, setState] = useState<LiveState>(EMPTY);
  const historyRef = useRef(EMPTY.history);

  useEffect(() => {
    if (!enabled) return;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = (): void => {
      if (closed) return;
      source = new EventSource('/api/stream');

      source.addEventListener('tick', (e) => {
        const tick = JSON.parse((e as MessageEvent).data) as Tick;
        const mem = tick.host?.mem;
        const gpu = tick.host?.gpus?.[0];
        const cpu = tick.host?.cpu;

        const ramPct = mem?.totalKb && mem.availableKb !== null
          ? ((mem.totalKb - (mem.availableKb ?? 0)) / mem.totalKb) * 100
          : 0;
        const vramPct = gpu?.memTotalMb ? ((gpu.memUsedMb ?? 0) / gpu.memTotalMb) * 100 : 0;
        const cpuPct = cpu?.load1 && cpu.cores ? Math.min(100, (cpu.load1 / cpu.cores) * 100) : 0;

        historyRef.current = {
          ram: push(historyRef.current.ram, ramPct),
          vram: push(historyRef.current.vram, vramPct),
          gpuUtil: push(historyRef.current.gpuUtil, gpu?.utilPct ?? 0),
          tokens: push(historyRef.current.tokens, tick.throughput.current),
          cpu: push(historyRef.current.cpu, cpuPct),
        };
        setState({ tick, connected: true, history: historyRef.current });
      });

      source.onerror = () => {
        source?.close();
        setState((s) => ({ ...s, connected: false }));
        // perch restarting, or the tab was asleep. Come back in a moment
        // rather than leaving a dead panel on screen.
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };

    connect();
    return () => {
      closed = true;
      source?.close();
      if (retry) clearTimeout(retry);
    };
  }, [enabled]);

  return state;
}
