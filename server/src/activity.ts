// A short, in-memory record of what came through the proxy, so the console
// can show that Tern is actually reaching this machine and what it asked for.
//
// What it stores: the time, the endpoint, the status, the token's name, how
// long it took. What it never stores: the prompt, the reply, the thread, the
// model's output, or any part of a request or response body. Those are the
// things you self-hosted the model to keep, and perch does not want a copy.
// It is also memory only — a restart forgets it, and it never touches disk.
import { config } from './config.js';

export interface ActivityEntry {
  at: string;
  /** Which endpoint it came through: chat, voice or image. */
  service: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  /** Bytes sent back, so a stalled stream is visible. Contents never read. */
  bytes: number;
  token: string | null;
  ip: string;
  note?: string;
}

const entries: ActivityEntry[] = [];

export function record(entry: ActivityEntry): void {
  entries.push(entry);
  if (entries.length > config.activityLimit) entries.splice(0, entries.length - config.activityLimit);
}

export function recent(limit = 100): ActivityEntry[] {
  return entries.slice(-limit).reverse();
}

export function summary(): { total: number; errors: number; lastAt: string | null } {
  const errors = entries.reduce((n, e) => n + (e.status >= 400 ? 1 : 0), 0);
  return { total: entries.length, errors, lastAt: entries.at(-1)?.at ?? null };
}

export function clear(): void {
  entries.length = 0;
}
