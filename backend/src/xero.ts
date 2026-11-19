// Xero accounting connection and sync framework (foundation).
// Official OAuth 2.0 authorisation code flow; tokens encrypted and server-only; one-way sync queue.
// No record types sync yet: those are switched on per type once the client confirms the accounting rules.
import { onCall, onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { APP_URL, FieldValue, Timestamp, db, fail, logger, notifyAdmins, requirePermission, requireSuperAdmin } from './core';
import {
  MAX_ATTEMPTS,
  REFRESH_TOKEN_DAYS,
  XERO_API_URL,
  XERO_IDENTITY_URL,
  XERO_SCOPES,
  authorizeUrl,
  backoffMs,
  basicAuth,
  classifyResponse,
  decrypt,
  encrypt,
  idempotencyKey,
  jobId,
  jwtClaims,
  missingConfig,
  newState,
  xeroConfig,
  type XeroResponseInfo,
} from './xeroCore';

const opts = { region: 'australia-southeast1', cors: true };
const scheduleOpts = { region: 'australia-southeast1', timeZone: 'Australia/Sydney' };

const CONN = db.doc('integrations/xero');               // tokens: server only
const STATUS = db.doc('integrations/xeroStatus');       // admins can read
const SETTINGS = db.doc('integrations/xeroSettings');   // admins can read
const LOOKUPS = db.doc('integrations/xeroLookups');     // admins can read
const STATES = db.collection('xeroOAuthStates');        // server only
const JOBS = db.collection('xeroSyncJobs');             // admins can read
const LOG = db.collection('xeroSyncLog');               // admins can read

const DAY = 86_400_000;

export class XeroError extends Error {
  constructor(message: string, readonly info?: XeroResponseInfo) { super(message); }
}

async function audit(action: string, detail: string, by?: string) {
  await LOG.add({ kind: 'audit', action, detail, by: by ?? 'system', at: FieldValue.serverTimestamp() });
}

function adminPage(params: Record<string, string>): string {
  return `${APP_URL}/admin/xero?${new URLSearchParams(params)}`;
}

function config() {
  const c = xeroConfig();
  const missing = missingConfig(c);
  return { c, missing };
}

// ---------- Tokens ----------

interface Conn {
  tenantId: string;
  access: string;
  refresh: string;
  accessExpiresAt: Timestamp;
  refreshLockUntil?: Timestamp;
}

async function tokenRequest(form: Record<string, string>) {
  const { c } = config();
  const res = await fetch(`${XERO_IDENTITY_URL}/connect/token`, {
    method: 'POST',
    headers: { Authorization: basicAuth(c), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new XeroError(classifyResponse(res.status, res.headers, text).message, classifyResponse(res.status, res.headers, text));
  return JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in: number; id_token?: string };
}

async function saveTokens(t: { access_token: string; refresh_token?: string; expires_in: number }, extra: Record<string, unknown> = {}) {
  const { c } = config();
  const now = Date.now();
  await CONN.set({
    access: encrypt(c.tokenKey!, t.access_token),
    ...(t.refresh_token ? { refresh: encrypt(c.tokenKey!, t.refresh_token) } : {}),
    accessExpiresAt: Timestamp.fromMillis(now + (t.expires_in - 60) * 1000),
    refreshLockUntil: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
    ...extra,
  }, { merge: true });
  await STATUS.set({ lastRefreshAt: FieldValue.serverTimestamp(), refreshExpiresAt: Timestamp.fromMillis(now + REFRESH_TOKEN_DAYS * DAY) }, { merge: true });
}

/**
 * A valid access token. Refresh tokens rotate on every use, so only one refresh may run at a time:
 * a short lease in the database makes other callers wait for it instead of refreshing in parallel.
 */
export async function accessToken(): Promise<{ token: string; tenantId: string }> {
  const { c, missing } = config();
  if (missing.length) throw new XeroError(`Xero is not configured (${missing.join(', ')})`);
  for (let i = 0; i < 20; i++) {
    const snap = await CONN.get();
    if (!snap.exists) throw new XeroError('Xero is not connected');
    const conn = snap.data() as Conn;
    if (conn.accessExpiresAt.toMillis() > Date.now()) return { token: decrypt(c.tokenKey!, conn.access), tenantId: conn.tenantId };
    const mine = await db.runTransaction(async tx => {
      const fresh = (await tx.get(CONN)).data() as Conn | undefined;
      if (!fresh) return false;
      if (fresh.accessExpiresAt.toMillis() > Date.now()) return false;
      if (fresh.refreshLockUntil && fresh.refreshLockUntil.toMillis() > Date.now()) return false;
      tx.update(CONN, { refreshLockUntil: Timestamp.fromMillis(Date.now() + 30_000) });
      return true;
    });
    if (!mine) { await new Promise(r => setTimeout(r, 1000)); continue; }
    try {
      const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(c.tokenKey!, conn.refresh) });
      await saveTokens(t);
      return { token: t.access_token, tenantId: conn.tenantId };
    } catch (err) {
      await CONN.update({ refreshLockUntil: FieldValue.delete() }).catch(() => undefined);
      const msg = err instanceof Error ? err.message : String(err);
      // invalid_grant: the refresh token was revoked, expired (60 days unused) or already used.
      if (/invalid_grant|400/.test(msg)) {
        await STATUS.set({ connected: false, problem: 'Xero access has expired or been revoked. Please reconnect.' }, { merge: true });
        await notifyAdmins({ title: 'Xero needs reconnecting', body: 'The Xero connection has expired or was revoked. Sync is paused until an admin reconnects.', link: '/admin/xero' });
      }
      throw err;
    }
  }
  throw new XeroError('Timed out waiting for a Xero token refresh');
}

/** Calls the Xero Accounting API for the connected organisation. Creates carry an Idempotency-Key. */
export async function xeroFetch(path: string, init: { method?: string; body?: unknown; idempotency?: string } = {}) {
  const { token, tenantId } = await accessToken();
  const res = await fetch(`${XERO_API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(init.idempotency ? { 'Idempotency-Key': init.idempotency } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const info = classifyResponse(res.status, res.headers, text);
  if (!res.ok) throw new XeroError(info.message, info);
  return { json: text ? JSON.parse(text) : null, info };
}

// ---------- Connect / disconnect ----------

/** Admin starts the connection: returns Xero's consent page URL with a one-time state value. */
export const xeroConnectUrl = onCall(opts, async req => {
  const uid = requireSuperAdmin(req);
  const { c, missing } = config();
  if (missing.length) fail(`Xero is not configured on the server yet: ${missing.join(', ')}.`);
  const state = newState();
  await STATES.doc(state).set({ uid, expiresAt: Timestamp.fromMillis(Date.now() + 10 * 60_000) });
  return { url: authorizeUrl(c, state) };
});

/** Xero redirects here after consent. Exchanges the code, stores encrypted tokens, returns to the admin page. */
export const xeroCallback = onRequest({ region: 'australia-southeast1' }, async (req, res) => {
  const state = String(req.query.state ?? '');
  const code = String(req.query.code ?? '');
  const stateDoc = state ? await STATES.doc(state).get() : null;
  if (!stateDoc?.exists || stateDoc.data()!.expiresAt.toMillis() < Date.now()) {
    if (stateDoc?.exists) await stateDoc.ref.delete();
    res.redirect(adminPage({ xero: 'error', reason: 'The connection request expired or was not started here. Please try again.' }));
    return;
  }
  const uid = stateDoc.data()!.uid as string;
  await stateDoc.ref.delete(); // one use only
  if (req.query.error || !code) {
    await audit('connect-cancelled', String(req.query.error ?? 'no code'), uid);
    res.redirect(adminPage({ xero: 'cancelled' }));
    return;
  }
  try {
    const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: config().c.redirectUri });
    if (!t.refresh_token) throw new XeroError('Xero did not return a refresh token (offline_access missing).');
    const conns = await fetch(`${XERO_API_URL}/connections`, { headers: { Authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(20_000) });
    const list = (await conns.json()) as { id: string; tenantId: string; tenantType: string; tenantName: string; updatedDateUtc?: string }[];
    const orgs = list.filter(x => x.tenantType === 'ORGANISATION').sort((a, b) => (b.updatedDateUtc ?? '').localeCompare(a.updatedDateUtc ?? ''));
    const org = orgs[0];
    if (!org) throw new XeroError('No Xero organisation was authorised.');
    const who = jwtClaims(t.id_token);
    await saveTokens(t, { tenantId: org.tenantId, connectionId: org.id, scopes: XERO_SCOPES, connectedBy: uid, connectedAt: FieldValue.serverTimestamp() });
    await STATUS.set({
      connected: true,
      tenantId: org.tenantId,
      tenantName: org.tenantName,
      otherOrganisations: orgs.length - 1,
      connectedBy: uid,
      connectedByXeroUser: who.email ?? null,
      connectedAt: FieldValue.serverTimestamp(),
      problem: null,
    }, { merge: true });
    await audit('connected', `${org.tenantName}${orgs.length > 1 ? ` (newest of ${orgs.length} organisations authorised)` : ''}`, uid);
    await queueJob('lookups', org.tenantId, {}, { rerun: true });
    res.redirect(adminPage({ xero: 'connected' }));
  } catch (err) {
    logger.error('Xero callback failed', err);
    await audit('connect-failed', err instanceof Error ? err.message : String(err), uid);
    res.redirect(adminPage({ xero: 'error', reason: err instanceof Error ? err.message : 'Connection failed' }));
  }
});

/** Revokes Xero access, deletes the stored tokens and pauses sync. */
export const xeroDisconnect = onCall(opts, async req => {
  const uid = requireSuperAdmin(req);
  const { c } = config();
  const snap = await CONN.get();
  if (snap.exists && c.tokenKey) {
    try {
      await fetch(`${XERO_IDENTITY_URL}/connect/revocation`, {
        method: 'POST',
        headers: { Authorization: basicAuth(c), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: decrypt(c.tokenKey, (snap.data() as Conn).refresh) }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      logger.warn('Xero revocation failed; deleting local tokens anyway', err);
    }
  }
  await CONN.delete();
  await STATUS.set({ connected: false, problem: null, disconnectedAt: FieldValue.serverTimestamp() }, { merge: true });
  await audit('disconnected', 'Tokens revoked and deleted', uid);
  return { ok: true };
});

/** Reads the organisation to confirm the connection works. */
export const xeroCheckConnection = onCall(opts, async req => {
  const uid = await requirePermission(req, 'xero', 'view');
  try {
    const { json } = await xeroFetch('/api.xro/2.0/Organisation');
    const org = json?.Organisations?.[0] ?? {};
    await STATUS.set({ connected: true, tenantName: org.Name ?? null, organisationClass: org.Class ?? null, countryCode: org.CountryCode ?? null, baseCurrency: org.BaseCurrency ?? null, lastCheckAt: FieldValue.serverTimestamp(), lastCheckOk: true, problem: null }, { merge: true });
    await audit('checked', `Connection OK: ${org.Name ?? 'organisation'}`, uid);
    return { ok: true, name: org.Name ?? '', organisationClass: org.Class ?? '' };
  } catch (err) {
    await STATUS.set({ lastCheckAt: FieldValue.serverTimestamp(), lastCheckOk: false }, { merge: true });
    fail(err instanceof Error ? err.message : 'Xero check failed');
  }
});

/** Server configuration as admins need to see it (names of missing settings only, never values). */
export const xeroConfigStatus = onCall(opts, async req => {
  await requirePermission(req, 'xero', 'view');
  const { c, missing } = config();
  const conn = (await CONN.get()).data();
  const granted = (conn?.scopes ?? []) as string[];
  const needsReconnect = !!conn && XERO_SCOPES.some(s => !granted.includes(s));
  return { missing, scopes: XERO_SCOPES, redirectUri: c.redirectUri, needsReconnect };
});

// ---------- Sync queue ----------

/**
 * Adds a sync job for one record. The job ID is derived from the record, so the same record can never
 * be queued twice; with rerun, a finished job (e.g. refreshing lookups) is queued again.
 */
export async function queueJob(type: string, recordId: string, payload: Record<string, unknown>, opt: { rerun?: boolean } = {}): Promise<boolean> {
  const ref = JOBS.doc(jobId(type, recordId));
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists && !(opt.rerun && ['done', 'failed', 'skipped'].includes(snap.data()!.status))) return false;
    tx.set(ref, { type, recordId, payload, status: 'pending', attempts: 0, nextAttemptAt: Timestamp.now(), createdAt: snap.exists ? snap.data()!.createdAt : FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), lastError: null });
    return true;
  });
}

type Handler = (job: { id: string; recordId: string; payload: Record<string, any> }) => Promise<{ xeroId?: string; summary: string }>;
type FailureHook = (job: { id: string; type: string; recordId: string }, message: string, willRetry: boolean, err: unknown) => Promise<void>;
const failureHooks: FailureHook[] = [];

/** Other modules add their record types here (the finance ledger registers "fin"). */
export function registerHandler(type: string, handler: Handler) {
  HANDLERS[type] = handler;
}
export function onJobFailure(hook: FailureHook) {
  failureHooks.push(hook);
}

/** Job handlers: read-only lookups here; finance records are registered by financeXero.ts. */
const HANDLERS: Record<string, Handler> = {
  /** Reads tax rates, accounts and items for the mapping pickers. Read-only. */
  async lookups() {
    const [org, taxes, accounts, items] = await Promise.all([
      xeroFetch('/api.xro/2.0/Organisation'),
      xeroFetch('/api.xro/2.0/TaxRates'),
      xeroFetch('/api.xro/2.0/Accounts?where=' + encodeURIComponent('Status=="ACTIVE"')),
      xeroFetch('/api.xro/2.0/Items'),
    ]);
    const o = org.json?.Organisations?.[0] ?? {};
    const taxRates = (taxes.json?.TaxRates ?? []).filter((t: any) => t.Status === 'ACTIVE').map((t: any) => ({ name: t.Name, taxType: t.TaxType, rate: t.EffectiveRate ?? null }));
    const accountList = (accounts.json?.Accounts ?? []).map((a: any) => ({ id: a.AccountID, code: a.Code ?? null, name: a.Name, type: a.Type, class: a.Class ?? null, taxType: a.TaxType ?? null, payments: a.EnablePaymentsToAccount === true }));
    const itemList = (items.json?.Items ?? []).map((i: any) => ({ code: i.Code, name: i.Name ?? i.Code }));
    await LOOKUPS.set({
      organisation: { name: o.Name ?? null, class: o.Class ?? null, countryCode: o.CountryCode ?? null, baseCurrency: o.BaseCurrency ?? null, salesTaxBasis: o.SalesTaxBasis ?? null },
      taxRates,
      accounts: accountList,
      items: itemList,
      updatedAt: FieldValue.serverTimestamp(),
    });
    await STATUS.set({ tenantName: o.Name ?? null, organisationClass: o.Class ?? null }, { merge: true });
    const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
    return { summary: `Read ${n(taxRates.length, 'active tax rate')}, ${n(accountList.length, 'account')}, ${n(itemList.length, 'item')}` };
  },
};

/** Exposed for future handlers: a stable Idempotency-Key per job and step. */
export const keyFor = idempotencyKey;

/** Processes due jobs one at a time within Xero's limits. Returns how many were handled. */
export async function runWorker(max = 25): Promise<{ processed: number; stopped?: string }> {
  const status = (await STATUS.get()).data();
  if (!status?.connected) return { processed: 0, stopped: 'not connected' };
  // Jobs left "processing" by a crashed run go back to the queue.
  const stale = await JOBS.where('status', '==', 'processing').where('leaseUntil', '<', Timestamp.now()).limit(50).get();
  for (const d of stale.docs) await d.ref.update({ status: 'pending' });

  const due = await JOBS.where('status', '==', 'pending').where('nextAttemptAt', '<=', Timestamp.now()).orderBy('nextAttemptAt').limit(max).get();
  let processed = 0;
  for (const d of due.docs) {
    const claimed = await db.runTransaction(async tx => {
      const s = await tx.get(d.ref);
      if (s.data()?.status !== 'pending') return false;
      tx.update(d.ref, { status: 'processing', leaseUntil: Timestamp.fromMillis(Date.now() + 5 * 60_000) });
      return true;
    });
    if (!claimed) continue;
    const job = d.data();
    const attempts = (job.attempts ?? 0) + 1;
    const handler = HANDLERS[job.type];
    if (!handler) {
      await d.ref.update({ status: 'skipped', lastError: 'This record type is not switched on yet.', updatedAt: FieldValue.serverTimestamp() });
      continue;
    }
    try {
      const out = await handler({ id: d.id, recordId: job.recordId, payload: job.payload ?? {} });
      await d.ref.update({ status: 'done', attempts, xeroId: out.xeroId ?? null, lastError: null, doneAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      await LOG.add({ kind: 'sync', job: d.id, type: job.type, ok: true, detail: out.summary, xeroId: out.xeroId ?? null, at: FieldValue.serverTimestamp() });
      await STATUS.set({ lastSyncAt: FieldValue.serverTimestamp() }, { merge: true });
      processed++;
    } catch (err) {
      const info = err instanceof XeroError ? err.info : undefined;
      const message = err instanceof Error ? err.message : String(err);
      const retry = (info?.retryable ?? !info) && attempts < MAX_ATTEMPTS;
      await d.ref.update({
        status: retry ? 'pending' : 'failed',
        attempts,
        lastError: message,
        nextAttemptAt: Timestamp.fromMillis(Date.now() + (info?.retryAfterMs ?? backoffMs(attempts))),
        updatedAt: FieldValue.serverTimestamp(),
      });
      await LOG.add({ kind: 'sync', job: d.id, type: job.type, ok: false, detail: message, willRetry: retry, at: FieldValue.serverTimestamp() });
      for (const hook of failureHooks) await hook({ id: d.id, type: job.type, recordId: job.recordId }, message, retry, err).catch(e => logger.error('Job failure hook failed', e));
      if (!retry) await notifyAdmins({ title: 'Xero sync failed', body: `${job.type} ${job.recordId}: ${message}`, link: '/admin/xero' });
      if (info?.rateLimited) return { processed, stopped: 'rate limited' };
      if (/not connected|not configured/i.test(message)) return { processed, stopped: message };
    }
  }
  return { processed };
}

export const xeroSyncWorker = onSchedule({ ...scheduleOpts, schedule: 'every 5 minutes' }, async () => {
  if (missingConfig(xeroConfig()).length) return;
  const out = await runWorker();
  if (out.processed || out.stopped) logger.info('Xero worker', out);
});

/** Keeps the 60-day refresh token alive and alerts admins if the connection breaks. */
export const xeroHealthCheck = onSchedule({ ...scheduleOpts, schedule: 'every day 06:00' }, async () => {
  if (missingConfig(xeroConfig()).length || !(await CONN.get()).exists) return;
  try {
    await xeroFetch('/api.xro/2.0/Organisation');
    await STATUS.set({ lastCheckAt: FieldValue.serverTimestamp(), lastCheckOk: true }, { merge: true });
  } catch (err) {
    await STATUS.set({ lastCheckAt: FieldValue.serverTimestamp(), lastCheckOk: false, problem: err instanceof Error ? err.message : 'Check failed' }, { merge: true });
    await notifyAdmins({ title: 'Xero connection problem', body: err instanceof Error ? err.message : 'The daily Xero check failed.', link: '/admin/xero' });
  }
});

// ---------- Admin actions ----------

export const xeroSyncNow = onCall({ ...opts, timeoutSeconds: 300 }, async req => {
  const uid = await requirePermission(req, 'xero', 'edit');
  const status = (await STATUS.get()).data();
  if (!status?.connected) fail('Connect Xero first.');
  await queueJob('lookups', status.tenantId, {}, { rerun: true });
  // Works through the queue (25 at a time) for up to about 4 minutes, stopping on rate limits.
  const startedAt = Date.now();
  const out: { processed: number; stopped?: string } = { processed: 0 };
  while (Date.now() - startedAt < 240_000) {
    const run = await runWorker();
    out.processed += run.processed;
    if (run.stopped) { out.stopped = run.stopped; break; }
    if (run.processed === 0) break;
  }
  await audit('sync-now', `Processed ${out.processed}${out.stopped ? ` (stopped: ${out.stopped})` : ''}`, uid);
  return out;
});

export const xeroRetry = onCall(opts, async req => {
  const uid = await requirePermission(req, 'xero', 'edit');
  const id = typeof req.data?.jobId === 'string' ? req.data.jobId : '';
  const refs = id ? [JOBS.doc(id)] : (await JOBS.where('status', '==', 'failed').limit(200).get()).docs.map(d => d.ref);
  let count = 0;
  for (const ref of refs) {
    const ok = await db.runTransaction(async tx => {
      const s = await tx.get(ref);
      if (s.data()?.status !== 'failed') return false;
      tx.update(ref, { status: 'pending', attempts: 0, nextAttemptAt: Timestamp.now(), updatedAt: FieldValue.serverTimestamp() });
      return true;
    });
    if (ok) count++;
  }
  await audit('retry', id ? `Retry ${id}` : `Retry all failed (${count})`, uid);
  return { retried: count };
});

/**
 * Superseded by financeSaveSettings (the accounting settings). Kept so existing deployments keep the
 * function name; invoices are always sent AUTHORISED (credit can only be applied to authorised invoices)
 * and only refunds need approval.
 */
export const xeroSaveSettings = onCall(opts, async req => {
  requireSuperAdmin(req);
  fail('These settings moved to Finance → Accounting settings.');
});
void SETTINGS;
