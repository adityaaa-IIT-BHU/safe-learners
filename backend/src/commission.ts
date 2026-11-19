// Instructor commission: settings (with effective dates), custom rates per instructor, introductory
// places for the first instructors, and a commission record for every confirmed lesson.
//
// Records (all written only here):
//   integrations/commissionSettings  { versions: CommissionVersion[] }           admins read
//   commissionProfiles/{uid}         { custom: CustomRateEntry[], intro }         admins read
//   commissionChanges/{id}           append-only change log                       admins read
//   commissionLedger/{bookingId}     rate + amounts fixed at confirmation         admin + that instructor
//   users/{uid}/private/commission   current rate and next change (display)      instructor + admins
import { createHash, randomUUID } from 'node:crypto';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  activeVersion,
  inForce,
  resolveCommission,
  splitCommission,
  upcomingChange,
  validRate,
  type CommissionVersion,
  type CustomRateEntry,
  type IntroState,
  type LedgerStatus,
  type ResolvedCommission,
} from '../../shared/commission';
import { fullName, type Booking } from '../../shared/domain';
import { DEFAULT_TIMEZONE, dayKey } from '../../shared/time';
import { FieldValue, auth, bookingFrom, db, fail, logger, userFrom, requirePermission } from './core';

const REGION = 'australia-southeast1';
const opts = { region: REGION, cors: true };
export const SETTINGS = 'integrations/commissionSettings';
const profileRef = (uid: string) => db.doc(`commissionProfiles/${uid}`);
const ledgerRef = (bookingId: string) => db.doc(`commissionLedger/${bookingId}`);
const summaryRef = (uid: string) => db.doc(`users/${uid}/private/commission`);

export const today = (d = new Date()) => dayKey(d, DEFAULT_TIMEZONE);

interface Actor { uid: string; name: string }
function actorOf(req: CallableRequest): Actor {
  const t = req.auth?.token as { name?: string; email?: string } | undefined;
  return { uid: req.auth!.uid, name: t?.name || t?.email || req.auth!.uid };
}

export async function getVersions(): Promise<CommissionVersion[]> {
  return ((await db.doc(SETTINGS).get()).data()?.versions ?? []) as CommissionVersion[];
}

async function profileOf(uid: string): Promise<{ custom: CustomRateEntry[]; intro: IntroState | null }> {
  const p = (await profileRef(uid).get()).data();
  return { custom: (p?.custom ?? []) as CustomRateEntry[], intro: (p?.intro ?? null) as IntroState | null };
}

export async function resolveFor(uid: string, day = today()): Promise<ResolvedCommission> {
  const [versions, p] = await Promise.all([getVersions(), profileOf(uid)]);
  return resolveCommission({ versions, ...p }, day);
}

async function logChange(e: Record<string, unknown>) {
  await db.collection('commissionChanges').add({ ...e, at: FieldValue.serverTimestamp(), atMs: Date.now() });
}

/** What the instructor sees: current rate, category and the next scheduled change. */
export async function refreshSummary(uid: string, versions?: CommissionVersion[]) {
  const vs = versions ?? await getVersions();
  const p = await profileOf(uid);
  const day = today();
  const now = resolveCommission({ versions: vs, ...p }, day);
  const next = upcomingChange({ versions: vs, ...p }, day);
  await summaryRef(uid).set({
    rate: now.rate, category: now.category,
    upcoming: next ? { rate: next.rate, category: next.category, effectiveFrom: next.effectiveFrom } : null,
    introPlace: p.intro?.status === 'allocated' ? p.intro.place ?? null : null,
    asOf: day, updatedAt: FieldValue.serverTimestamp(),
  });
}

async function refreshAll(versions?: CommissionVersion[]) {
  const vs = versions ?? await getVersions();
  const ins = await db.collection('users').where('role', '==', 'instructor').get();
  for (const u of ins.docs) await refreshSummary(u.id, vs);
}

// ---------- Introductory places ----------

const keyId = (kind: string, value: string) => createHash('sha256').update(`${kind}:${value}`).digest('hex').slice(0, 40);

/** Identity keys that stop the same person gaining a second introductory place with a new account. */
async function identityKeys(uid: string): Promise<{ kind: string; id: string }[]> {
  const keys: { kind: string; id: string }[] = [];
  const priv = (await db.doc(`users/${uid}/private/profile`).get()).data() ?? {};
  let email = String(priv.email ?? '');
  if (!email) email = (await auth.getUser(uid).catch(() => null))?.email ?? '';
  if (email) {
    // Gmail-style "+tag" aliases and dots count as the same address.
    const [local, domain] = email.toLowerCase().trim().split('@');
    const base = local.split('+')[0];
    keys.push({ kind: 'email', id: keyId('email', `${domain === 'gmail.com' || domain === 'googlemail.com' ? base.replace(/\./g, '') : base}@${domain}`) });
  }
  const mobile = String(priv.mobile ?? '').replace(/\D/g, '').slice(-9);
  if (mobile.length === 9) keys.push({ kind: 'mobile', id: keyId('mobile', mobile) });
  const lic = (await db.doc(`instructorDocuments/${uid}__driverLicence`).get()).data()?.verifiedNumber ?? priv.verification?.driverLicence?.number;
  const licNo = String(lic ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (licNo.length >= 4) keys.push({ kind: 'licence', id: keyId('licence', licNo) });
  return keys;
}

const toDay = (v: any): string | null => {
  const d = v?.toDate ? v.toDate() : v instanceof Date ? v : null;
  return d ? today(d) : null;
};

/**
 * Gives introductory places to the earliest approved instructors without one, in order of approval
 * date, while places remain and the offer is on. Test, disabled and deleted accounts are never
 * counted. A place, once given, is kept; an account matching an earlier instructor's email, mobile or
 * licence is excluded (and recorded).
 */
export async function allocateIntroPlaces(actor: Actor): Promise<{ allocated: string[]; excluded: string[]; remaining: number; places: number }> {
  const v = activeVersion(await getVersions(), today());
  const out = { allocated: [] as string[], excluded: [] as string[], remaining: 0, places: v.introPlaces };
  const instructors = (await db.collection('users').where('role', '==', 'instructor').get()).docs.map(d => ({ id: d.id, data: d.data() }));
  const profiles = new Map((await db.collection('commissionProfiles').get()).docs.map(d => [d.id, d.data()]));
  const live = new Map(instructors.map(i => [i.id, i.data]));
  const holds = (id: string) => profiles.get(id)?.intro?.status === 'allocated';
  const counted = [...profiles.entries()].filter(([id, p]) => p.intro?.status === 'allocated' && live.has(id) && live.get(id)!.testAccount !== true).length;
  let remaining = Math.max(0, v.introPlaces - counted);
  // Place numbers are never reused (a freed place gets the next number).
  let lastPlace = Math.max(0, ...[...profiles.values()].map(p => Number(p.intro?.place ?? 0)));
  out.remaining = remaining;
  if (!v.introEnabled || remaining === 0) return out;

  const candidates = instructors
    .filter(i => i.data.verificationStatus === 'verified' && i.data.testAccount !== true && i.data.accountStatus !== 'disabled' && !profiles.get(i.id)?.intro)
    .map(i => ({ ...i, basis: toDay(i.data.verifiedAt) ?? toDay(i.data.verificationSubmittedAt) ?? toDay(i.data.createdAt) ?? '9999-12-31', estimated: !i.data.verifiedAt }))
    .sort((a, b) => a.basis.localeCompare(b.basis) || a.id.localeCompare(b.id));

  for (const c of candidates) {
    if (remaining <= 0) break;
    const keys = await identityKeys(c.id);
    const clash = (await Promise.all(keys.map(k => db.doc(`commissionIntroKeys/${k.id}`).get()))).map((s, i) => ({ s, k: keys[i] })).find(x => x.s.exists && x.s.data()!.uid !== c.id);
    if (clash) {
      const other = clash.s.data()!.uid as string;
      const intro: IntroState = { status: 'excluded', basisDate: c.basis, reason: `Same ${clash.k.kind} as an instructor who already received the introductory offer (${live.has(other) ? fullName(userFrom(await db.doc(`users/${other}`).get())!) : 'a deleted account'})` };
      await profileRef(c.id).set({ intro: { ...intro, decidedAt: FieldValue.serverTimestamp() } }, { merge: true });
      await logChange({ scope: 'instructor', instructorId: c.id, instructorName: fullName(c.data as any), kind: 'intro_excluded', after: intro, by: actor.uid, byName: actor.name, reason: intro.reason });
      out.excluded.push(c.id);
      continue;
    }
    const place = lastPlace + 1;
    const intro: IntroState = { status: 'allocated', place, basisDate: c.basis, ...(c.estimated ? { reason: 'Approval date not recorded; registration date used' } : {}) };
    await db.runTransaction(async tx => {
      const cur = await tx.get(profileRef(c.id));
      if (cur.data()?.intro) return;
      tx.set(profileRef(c.id), { intro: { ...intro, decidedAt: FieldValue.serverTimestamp(), versionId: v.id } }, { merge: true });
      for (const k of keys) tx.set(db.doc(`commissionIntroKeys/${k.id}`), { uid: c.id, kind: k.kind, at: FieldValue.serverTimestamp() });
    });
    await logChange({ scope: 'instructor', instructorId: c.id, instructorName: fullName(c.data as any), kind: 'intro_allocated', after: intro, by: actor.uid, byName: actor.name, reason: `Introductory place ${place} (${v.introPlaces - remaining + 1} of ${v.introPlaces} in use; approved ${c.basis})` });
    await refreshSummary(c.id);
    out.allocated.push(c.id);
    lastPlace = place;
    remaining--;
  }
  out.remaining = remaining;
  return out;
}

// ---------- Commission per lesson ----------

function ledgerStatus(b: Booking): LedgerStatus | null {
  if (b.kind !== 'lesson') return null;
  if (b.rescheduledTo) return 'void';
  switch (b.status) {
    case 'confirmed':
    case 'late_cancel_requested':
      return 'booked';
    case 'completed':
      return 'completed';
    case 'cancelled':
      return (b as any).paymentStatus === 'charged' ? 'late_fee' : 'void';
    default:
      return null;
  }
}

/** The rate a lesson gets when it is confirmed: inherited when rescheduled, otherwise today's rate. */
export async function rateForBooking(b: Pick<Booking, 'id' | 'instructorId' | 'rescheduledFrom'>): Promise<ResolvedCommission & { inheritedFrom?: string; bookedDay: string }> {
  const existing = (await ledgerRef(b.id).get()).data();
  if (existing) return { rate: existing.rate, category: existing.category, versionId: existing.versionId, customId: existing.customId, bookedDay: existing.bookedDay };
  if (b.rescheduledFrom) {
    const prev = (await ledgerRef(b.rescheduledFrom).get()).data();
    if (prev) return { rate: prev.rate, category: prev.category, versionId: prev.versionId, customId: prev.customId, inheritedFrom: b.rescheduledFrom, bookedDay: prev.bookedDay };
  }
  const day = today();
  return { ...(await resolveFor(b.instructorId!, day)), bookedDay: day };
}

/** Creates the commission record once per confirmed lesson; afterwards only its status changes. */
export async function syncLedger(bookingId: string): Promise<'created' | 'updated' | 'unchanged' | 'skipped'> {
  const b = bookingFrom(await db.doc(`bookings/${bookingId}`).get());
  if (!b || !b.instructorId) return 'skipped';
  const status = ledgerStatus(b);
  const snap = await ledgerRef(bookingId).get();
  if (!snap.exists) {
    if (!status || status === 'void') return 'skipped';
    const r = await rateForBooking(b);
    const price = Number(b.price ?? 0);
    const { commission, earnings } = splitCommission(price, r.rate);
    try {
      await ledgerRef(bookingId).create({
        bookingId, instructorId: b.instructorId, instructorName: b.instructorName ?? null, ref: b.ref ?? null,
        lessonDay: dayKey(b.startAt, b.timezone ?? DEFAULT_TIMEZONE), bookedDay: r.bookedDay,
        price, rate: r.rate, category: r.category, versionId: r.versionId, customId: r.customId ?? null, inheritedFrom: r.inheritedFrom ?? null,
        commission, earnings, status, createdAt: FieldValue.serverTimestamp(), createdMs: Date.now(),
      });
    } catch {
      return 'unchanged'; // already created by a concurrent run: never twice
    }
    return 'created';
  }
  const cur = snap.data()!;
  if (status && cur.status !== status) {
    await snap.ref.update({ status, statusAt: FieldValue.serverTimestamp() });
    return 'updated';
  }
  return 'unchanged';
}

export const commissionOnBookingWrite = onDocumentWritten({ region: REGION, document: 'bookings/{id}', retry: true }, async event => {
  if (!event.data?.after.exists) {
    const l = await ledgerRef(event.params.id).get();
    if (l.exists && l.data()!.status !== 'void') await l.ref.update({ status: 'void', statusAt: FieldValue.serverTimestamp() });
    return;
  }
  await syncLedger(event.params.id);
});

// ---------- Admin actions ----------

function dateArg(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) fail('Choose an effective date.', 'invalid-argument');
  if (s < today()) fail('The effective date can’t be in the past (past lessons keep the rate they were booked at).', 'invalid-argument');
  if (s > today(new Date(Date.now() + 2 * 366 * 86_400_000))) fail('The effective date is too far ahead.', 'invalid-argument');
  return s;
}
function rateArg(v: unknown, label: string): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!validRate(n)) fail(`${label} must be a percentage from 0 to 99.99 (up to two decimals).`, 'invalid-argument');
  return n as number;
}
const reasonArg = (v: unknown) => {
  const s = typeof v === 'string' ? v.trim().slice(0, 500) : '';
  if (s.length < 3) fail('Please give a reason for the change.', 'invalid-argument');
  return s;
};

/** Adds a new version of the global structure, effective from a date. */
export const saveCommissionSettings = onCall({ ...opts, timeoutSeconds: 300 }, async req => {
  await requirePermission(req, 'commission', 'settings');
  const actor = actorOf(req);
  const d = req.data ?? {};
  const places = Number(d.introPlaces);
  if (!Number.isInteger(places) || places < 0 || places > 1000) fail('Introductory places must be a whole number from 0 to 1000.', 'invalid-argument');
  const version: CommissionVersion = {
    id: randomUUID(), defaultRate: rateArg(d.defaultRate, 'Default commission'), introEnabled: d.introEnabled === true,
    introRate: rateArg(d.introRate, 'Introductory commission'), introPlaces: places, effectiveFrom: dateArg(d.effectiveFrom),
    createdMs: Date.now(), byName: actor.name, reason: reasonArg(d.reason),
  };
  const versions = await getVersions();
  const before = inForce(versions, version.effectiveFrom) ?? activeVersion(versions, today());
  await db.doc(SETTINGS).set({ versions: [...versions, { ...version, by: actor.uid }], updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await logChange({ scope: 'global', kind: 'structure', before: { defaultRate: before.defaultRate, introEnabled: before.introEnabled, introRate: before.introRate, introPlaces: before.introPlaces },
    after: { defaultRate: version.defaultRate, introEnabled: version.introEnabled, introRate: version.introRate, introPlaces: version.introPlaces }, effectiveFrom: version.effectiveFrom, versionId: version.id, by: actor.uid, byName: actor.name, reason: version.reason });
  const allocation = version.effectiveFrom <= today() ? await allocateIntroPlaces(actor) : null;
  await refreshAll();
  return { ok: true, versionId: version.id, allocation };
});

/** Sets (rate) or removes (rate null) an instructor's custom commission from a date. */
export const setInstructorCommission = onCall(opts, async req => {
  await requirePermission(req, 'commission', 'edit');
  const actor = actorOf(req);
  const uid = typeof req.data?.uid === 'string' ? req.data.uid : '';
  const user = userFrom(await db.doc(`users/${uid}`).get());
  if (!user || user.role !== 'instructor') fail('Instructor not found.', 'not-found');
  const remove = req.data?.rate === null;
  const rate = remove ? null : rateArg(req.data?.rate, 'Commission');
  const effectiveFrom = dateArg(req.data?.effectiveFrom);
  const reason = reasonArg(req.data?.reason);
  const p = await profileOf(uid);
  const versions = await getVersions();
  const before = resolveCommission({ versions, ...p }, effectiveFrom);
  if (remove && before.category !== 'custom') fail('This instructor has no custom rate on that date.');
  const entry: CustomRateEntry & { by: string } = { id: randomUUID(), rate, effectiveFrom, createdMs: Date.now(), byName: actor.name, by: actor.uid, reason };
  await profileRef(uid).set({ custom: FieldValue.arrayUnion(entry), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  const after = resolveCommission({ versions, custom: [...p.custom, entry], intro: p.intro }, effectiveFrom);
  await logChange({ scope: 'instructor', kind: remove ? 'custom_removed' : 'custom_set', instructorId: uid, instructorName: fullName(user),
    before: { rate: before.rate, category: before.category }, after: { rate: after.rate, category: after.category }, effectiveFrom, entryId: entry.id, by: actor.uid, byName: actor.name, reason });
  await refreshSummary(uid, versions);
  return { ok: true, effective: { rate: after.rate, category: after.category, effectiveFrom } };
});

/** Cancels a scheduled change that has not taken effect yet (global version or custom entry). */
export const cancelScheduledCommission = onCall(opts, async req => {
  await requirePermission(req, 'commission', 'edit');
  const actor = actorOf(req);
  const id = String(req.data?.id ?? '');
  const uid = typeof req.data?.uid === 'string' ? req.data.uid : null;
  const reason = reasonArg(req.data?.reason);
  if (uid) {
    const p = await profileOf(uid);
    const e = p.custom.find(x => x.id === id);
    if (!e) fail('Scheduled change not found.', 'not-found');
    if (e!.effectiveFrom <= today()) fail('This change has already taken effect; set a new rate instead.');
    await profileRef(uid).set({ custom: p.custom.filter(x => x.id !== id) }, { merge: true });
    await logChange({ scope: 'instructor', kind: 'scheduled_cancelled', instructorId: uid, before: e, by: actor.uid, byName: actor.name, reason });
    await refreshSummary(uid);
  } else {
    const versions = await getVersions();
    const v = versions.find(x => x.id === id);
    if (!v) fail('Scheduled change not found.', 'not-found');
    if (v!.effectiveFrom <= today()) fail('This structure has already taken effect; add a new one instead.');
    await db.doc(SETTINGS).set({ versions: versions.filter(x => x.id !== id) }, { merge: true });
    await logChange({ scope: 'global', kind: 'scheduled_cancelled', before: v, by: actor.uid, byName: actor.name, reason });
    await refreshAll();
  }
  return { ok: true };
});

export const allocateIntroNow = onCall({ ...opts, timeoutSeconds: 300 }, async req => {
  await requirePermission(req, 'commission', 'edit');
  return allocateIntroPlaces(actorOf(req));
});

/** Daily: rolls the instructor summaries over when a scheduled change takes effect, and fills new places. */
export const commissionDaily = onSchedule({ region: REGION, schedule: 'every day 00:10', timeZone: DEFAULT_TIMEZONE, timeoutSeconds: 300 }, async () => {
  await allocateIntroPlaces({ uid: 'system', name: 'System' });
  await refreshAll();
  logger.info('commission summaries refreshed');
});
