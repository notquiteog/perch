// Two quite different kinds of caller, so two kinds of credential.
//
//   * Tern, over the tunnel, presents a bearer token. Tokens are shown once
//     and stored only as a hash, they carry scopes, and they can be revoked
//     one at a time without disturbing anything else.
//   * A person, on this machine, opens the console. On loopback that needs no
//     password — it is the machine's own control panel and you are already
//     sitting at it. Bound anywhere else it does, and perch refuses to serve
//     the console to a non-loopback address until one is set.
import crypto from 'node:crypto';
import { config } from './config.js';
import { loadState, updateState, type TokenRecord } from './state.js';

export type Scope = 'use' | 'manage';

const TOKEN_PREFIX = 'perch_';

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Constant-time compare of two hex digests of equal length. */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function mintToken(name: string, scopes: Scope[]): { token: string; record: TokenRecord } {
  // 32 bytes of randomness, base64url so it survives a shell, an env file and
  // a copy-paste out of the console without quoting surprises.
  const secret = crypto.randomBytes(32).toString('base64url');
  const token = `${TOKEN_PREFIX}${secret}`;
  const record: TokenRecord = {
    id: crypto.randomUUID(),
    name: name.trim().slice(0, 60) || 'unnamed',
    hash: sha256(token),
    prefix: token.slice(0, TOKEN_PREFIX.length + 6),
    scopes: scopes.length ? scopes : ['use'],
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    lastUsedIp: null,
    revokedAt: null,
  };
  updateState((s) => { s.tokens.push(record); });
  return { token, record };
}

export function revokeToken(id: string): boolean {
  let found = false;
  updateState((s) => {
    const t = s.tokens.find((x) => x.id === id);
    if (t && !t.revokedAt) { t.revokedAt = new Date().toISOString(); found = true; }
  });
  return found;
}

/** Drop a revoked token from the file for good. */
export function deleteToken(id: string): boolean {
  let found = false;
  updateState((s) => {
    const before = s.tokens.length;
    s.tokens = s.tokens.filter((x) => x.id !== id);
    found = s.tokens.length !== before;
  });
  return found;
}

export interface AuthResult {
  ok: boolean;
  token?: TokenRecord;
  reason?: 'missing' | 'unknown' | 'revoked' | 'scope';
}

export function authenticate(header: string | undefined, need: Scope): AuthResult {
  const raw = (header || '').trim();
  const presented = raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : raw;
  if (!presented) return { ok: false, reason: 'missing' };

  const digest = sha256(presented);
  const match = loadState().tokens.find((t) => sameDigest(t.hash, digest));
  if (!match) return { ok: false, reason: 'unknown' };
  if (match.revokedAt) return { ok: false, token: match, reason: 'revoked' };
  if (!match.scopes.includes(need)) return { ok: false, token: match, reason: 'scope' };
  return { ok: true, token: match };
}

/**
 * Record that a token was used. Written back to the state file, so it is
 * called once a request is accepted rather than on every chunk.
 */
export function noteTokenUse(id: string, ip: string): void {
  updateState((s) => {
    const t = s.tokens.find((x) => x.id === id);
    if (t) { t.lastUsedAt = new Date().toISOString(); t.lastUsedIp = ip; }
  });
}

// ---------- The console password ----------

export function setConsolePassword(password: string | null): void {
  updateState((s) => {
    s.console.passwordHash = password ? hashPassword(password) : null;
  });
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function checkConsolePassword(password: string): boolean {
  const stored = loadState().console.passwordHash;
  if (!stored) return false;
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function consolePasswordSet(): boolean {
  return Boolean(loadState().console.passwordHash);
}

// ---------- Console sessions ----------
//
// In memory, so every session ends when perch restarts. That is the right
// trade for a control panel you visit occasionally from one machine.

const SESSION_MS = 12 * 60 * 60 * 1000;
const sessions = new Map<string, number>();

export function createSession(): string {
  const id = crypto.randomBytes(32).toString('base64url');
  sessions.set(id, Date.now() + SESSION_MS);
  return id;
}

export function validSession(id: string | undefined): boolean {
  if (!id) return false;
  const expires = sessions.get(id);
  if (!expires) return false;
  if (expires < Date.now()) { sessions.delete(id); return false; }
  return true;
}

export function endSession(id: string | undefined): void {
  if (id) sessions.delete(id);
}

// ---------- Refusing an address that keeps guessing ----------

interface Failures { count: number; first: number; blockedUntil: number }
const failures = new Map<string, Failures>();

export function isBlocked(ip: string): boolean {
  const f = failures.get(ip);
  if (!f) return false;
  if (f.blockedUntil > Date.now()) return true;
  // The block expired; give the address a clean slate rather than leaving it
  // one mistake away from another block.
  if (f.blockedUntil) failures.delete(ip);
  return false;
}

export function noteAuthFailure(ip: string): void {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || now - f.first > config.authFailWindowMs) {
    failures.set(ip, { count: 1, first: now, blockedUntil: 0 });
    return;
  }
  f.count += 1;
  if (f.count >= config.authFailLimit) f.blockedUntil = now + config.authBlockMs;
}

export function noteAuthSuccess(ip: string): void {
  failures.delete(ip);
}

/** Test seam. */
export function resetAuthFailures(): void {
  failures.clear();
}
