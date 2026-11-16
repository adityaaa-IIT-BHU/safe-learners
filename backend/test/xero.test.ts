import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  XERO_SCOPES,
  authorizeUrl,
  backoffMs,
  classifyResponse,
  decrypt,
  encrypt,
  idempotencyKey,
  jobId,
  jwtClaims,
  missingConfig,
  xeroConfig,
} from '../src/xeroCore.ts';

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

test('tokens round-trip through AES-256-GCM and tampering is detected', () => {
  const key = randomBytes(32);
  const sealed = encrypt(key, 'refresh-token-value');
  assert.notEqual(sealed.includes('refresh-token-value'), true);
  assert.equal(decrypt(key, sealed), 'refresh-token-value');
  assert.notEqual(encrypt(key, 'same'), encrypt(key, 'same'), 'random IV each time');
  const parts = sealed.split('.');
  parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => decrypt(key, parts.join('.')));
  assert.throws(() => decrypt(randomBytes(32), sealed), 'wrong key fails');
});

test('config reports missing settings by name and rejects a short key', () => {
  assert.deepEqual(missingConfig(xeroConfig({})), ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'XERO_REDIRECT_URI', 'XERO_TOKEN_KEY (32 bytes, base64)']);
  const ok = xeroConfig({ XERO_CLIENT_ID: 'id', XERO_CLIENT_SECRET: 's', XERO_REDIRECT_URI: 'https://x/cb', XERO_TOKEN_KEY: randomBytes(32).toString('base64') });
  assert.deepEqual(missingConfig(ok), []);
  assert.equal(xeroConfig({ XERO_TOKEN_KEY: randomBytes(16).toString('base64') }).tokenKey, null);
});

test('consent URL uses the authorisation code flow with granular scopes and the state value', () => {
  const c = xeroConfig({ XERO_CLIENT_ID: 'abc', XERO_CLIENT_SECRET: 's', XERO_REDIRECT_URI: 'https://example.com/xeroCallback' });
  const u = new URL(authorizeUrl(c, 'STATE123'));
  assert.equal(u.origin + u.pathname, 'https://login.xero.com/identity/connect/authorize');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('state'), 'STATE123');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://example.com/xeroCallback');
  const scopes = u.searchParams.get('scope')!.split(' ');
  assert.deepEqual(scopes, XERO_SCOPES);
  assert.ok(scopes.includes('offline_access'));
  assert.ok(!scopes.includes('accounting.transactions'), 'broad scope not requested');
  // Least privilege: write access only to the records the finance sync creates; settings read-only.
  const writes = scopes.filter(s => s.startsWith('accounting.') && !s.endsWith('.read')).sort();
  assert.deepEqual(writes, ['accounting.banktransactions', 'accounting.contacts', 'accounting.invoices', 'accounting.payments']);
  assert.ok(scopes.includes('accounting.settings.read') && !scopes.includes('accounting.settings'));
  assert.ok(!scopes.some(s => /payroll|reports|attachments|journals|files|assets|projects/.test(s)));
});

test('job IDs are stable per record (duplicate guard) and safe as document IDs', () => {
  assert.equal(jobId('invoice', 'abc123'), jobId('invoice', 'abc123'));
  assert.notEqual(jobId('invoice', 'abc123'), jobId('payment', 'abc123'));
  assert.equal(jobId('invoice', 'a/b c'), 'invoice__a-b-c');
});

test('idempotency keys are stable, distinct per step and within Xero’s 128-character limit', () => {
  const k = idempotencyKey('invoice__abc', 'create');
  assert.equal(k, idempotencyKey('invoice__abc', 'create'));
  assert.notEqual(k, idempotencyKey('invoice__abc', 'payment'));
  assert.ok(k.length <= 128);
});

test('backoff grows and is capped at an hour', () => {
  const mid = () => 0.5;
  assert.equal(backoffMs(1, mid), 60_000);
  assert.equal(backoffMs(3, mid), 240_000);
  assert.equal(backoffMs(20, mid), 3_600_000);
});

test('responses are classified for retry', () => {
  const rl = classifyResponse(429, headers({ 'retry-after': '37', 'x-rate-limit-problem': 'minute' }), '');
  assert.equal(rl.retryable, true);
  assert.equal(rl.rateLimited, true);
  assert.equal(rl.retryAfterMs, 37_000);
  assert.match(rl.message, /minute/);
  assert.equal(classifyResponse(503, headers({}), '').retryable, true);
  const v = classifyResponse(400, headers({ 'x-minlimit-remaining': '12' }), JSON.stringify({ Message: 'A validation exception occurred', Elements: [{ ValidationErrors: [{ Message: 'Account code is not valid' }] }] }));
  assert.equal(v.retryable, false);
  assert.equal(v.minuteRemaining, 12);
  assert.match(v.message, /Account code is not valid/);
  assert.match(classifyResponse(400, headers({}), JSON.stringify({ error: 'invalid_grant' })).message, /invalid_grant/);
});

test('ID token claims are read without throwing on bad input', () => {
  const payload = Buffer.from(JSON.stringify({ email: 'a@b.com' })).toString('base64url');
  assert.equal(jwtClaims(`x.${payload}.y`).email, 'a@b.com');
  assert.deepEqual(jwtClaims('garbage'), {});
  assert.deepEqual(jwtClaims(undefined), {});
});
