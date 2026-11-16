// Xero helpers with no Firebase dependencies (unit-tested in test/xero.test.ts).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const XERO_IDENTITY_URL = (process.env.XERO_IDENTITY_URL || 'https://identity.xero.com').replace(/\/$/, '');
export const XERO_LOGIN_URL = (process.env.XERO_LOGIN_URL || 'https://login.xero.com').replace(/\/$/, '');
export const XERO_API_URL = (process.env.XERO_API_URL || 'https://api.xero.com').replace(/\/$/, '');

/**
 * Granular scopes (required for Xero apps created after 2 March 2026). Foundation only: identity, refresh
 * and read-only settings for mapping. Contacts / invoices / payments scopes are added once the client
 * confirms which records sync; adding a scope later just means reconnecting.
 */
export const XERO_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'accounting.settings.read'];

/** Xero refresh tokens last 60 days from their last use; Xero doesn't return the expiry, so we track it. */
export const REFRESH_TOKEN_DAYS = 60;
export const MAX_ATTEMPTS = 6;

export interface XeroConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenKey: Buffer | null;
}

export function xeroConfig(env: Record<string, string | undefined> = process.env): XeroConfig {
  const raw = env.XERO_TOKEN_KEY ? Buffer.from(env.XERO_TOKEN_KEY, 'base64') : null;
  return {
    clientId: env.XERO_CLIENT_ID || '',
    clientSecret: env.XERO_CLIENT_SECRET || '',
    redirectUri: env.XERO_REDIRECT_URI || '',
    tokenKey: raw && raw.length === 32 ? raw : null,
  };
}

/** Which settings are missing (names only, never values). */
export function missingConfig(c: XeroConfig): string[] {
  return [
    !c.clientId && 'XERO_CLIENT_ID',
    !c.clientSecret && 'XERO_CLIENT_SECRET',
    !c.redirectUri && 'XERO_REDIRECT_URI',
    !c.tokenKey && 'XERO_TOKEN_KEY (32 bytes, base64)',
  ].filter((x): x is string => !!x);
}

export function authorizeUrl(c: XeroConfig, state: string, scopes = XERO_SCOPES): string {
  const q = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: c.redirectUri, scope: scopes.join(' '), state });
  return `${XERO_LOGIN_URL}/identity/connect/authorize?${q}`;
}

export function basicAuth(c: XeroConfig): string {
  return `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`;
}

export function newState(): string {
  return randomBytes(24).toString('base64url');
}

// ---------- Token encryption (AES-256-GCM) ----------

export function encrypt(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

export function decrypt(key: Buffer, sealed: string): string {
  const [v, iv, tag, data] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unrecognised token format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/** Reads the claims of an ID token received directly from Xero's token endpoint (over TLS). */
export function jwtClaims(token: string | undefined): Record<string, any> {
  if (!token) return {};
  try {
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

// ---------- Sync jobs ----------

export type JobStatus = 'pending' | 'processing' | 'done' | 'failed' | 'skipped';

/** One job per record and purpose: the job ID is the duplicate guard (e.g. "invoice__booking-abc"). */
export function jobId(type: string, recordId: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 200);
  return `${clean(type)}__${clean(recordId)}`;
}

/**
 * Idempotency-Key for a create call. Stable for the same job and request, so a repeated call inside Xero's
 * 6-minute window returns the original result instead of creating a second record. Max 128 characters.
 */
export function idempotencyKey(job: string, step: string): string {
  return createHash('sha256').update(`${job}|${step}`).digest('hex');
}

/** Exponential backoff with jitter: about 1, 2, 4, 8, 16 minutes, capped at an hour. */
export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(60, 2 ** Math.max(0, attempt - 1)) * 60_000;
  return Math.round(base * (0.8 + random() * 0.4));
}

export interface XeroResponseInfo {
  retryable: boolean;
  retryAfterMs?: number;
  rateLimited: boolean;
  /** Calls left in the current minute for this organisation, when Xero reports it. */
  minuteRemaining?: number;
  message: string;
}

/** Classifies a Xero API response: what failed and whether trying again later can help. */
export function classifyResponse(status: number, headers: { get(name: string): string | null }, body: string): XeroResponseInfo {
  const num = (h: string) => { const v = headers.get(h); return v !== null && v !== '' && !isNaN(Number(v)) ? Number(v) : undefined; };
  const retryAfter = num('retry-after');
  const minuteRemaining = num('x-minlimit-remaining');
  const rateLimited = status === 429;
  let message = `Xero responded ${status}`;
  try {
    const j = JSON.parse(body);
    const detail = j.Detail || j.Message || j.message || j.error_description || j.error || j.Title;
    const validation = j.Elements?.[0]?.ValidationErrors?.map((e: any) => e.Message).join('; ');
    message = [detail, validation].filter(Boolean).join(': ') || message;
  } catch {
    if (body) message = `${message}: ${body.slice(0, 200)}`;
  }
  if (rateLimited) message = `Xero rate limit reached (${headers.get('x-rate-limit-problem') || 'limit'})`;
  return {
    retryable: rateLimited || status >= 500 || status === 408,
    retryAfterMs: retryAfter !== undefined ? retryAfter * 1000 : undefined,
    rateLimited,
    minuteRemaining,
    message,
  };
}
