// Client Admin dashboard: live operational figures for a chosen period. Every section is calculated
// only when the signed-in administrator has the matching permission (Cybria Super Admins see all), so
// nothing an admin can't open is ever sent to their browser.
import { onCall, type CallableRequest } from 'firebase-functions/v2/https';
import type { Action, ModuleKey } from '../../shared/access';
import { Timestamp, db, fail, hasPermission, requireAnyAdmin } from './core';

const opts = { region: 'australia-southeast1', cors: true, timeoutSeconds: 120, memory: '512MiB' as const };
const TZ = 'Australia/Sydney';
const DAY_MS = 86_400_000;
const money = (n: number) => Math.round(n * 100) / 100;
const count = async (q: FirebaseFirestore.Query) => (await q.count().get()).data().count;
const ts = (v: unknown): Date | null => (v instanceof Timestamp ? v.toDate() : v instanceof Date ? v : null);
const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const weekday = (d: Date) => new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'long' }).format(d).toLowerCase();
const nameOf = (u: FirebaseFirestore.DocumentData) => [u.firstName, u.surname].filter(Boolean).join(' ') || 'Unnamed';
const HOLDS_TIME = ['confirmed', 'proposed', 'late_cancel_requested'];
const CREDIT_TYPES = ['credit_purchase', 'promo_credit', 'goodwill_credit', 'correction_credit', 'opening_credit'];

/** Midnight in Sydney on the day of `d`. */
function sydneyMidnight(d: Date): Date {
  const day = dayKey(d);
  const probe = new Date(`${day}T12:00:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' }).formatToParts(probe).find(p => p.type === 'timeZoneName')!.value;
  return new Date(Date.parse(`${day}T00:00:00Z`) - (Number(off.replace('GMT', '')) || 10) * 3_600_000);
}

export interface ActivityItem { at: string; kind: string; title: string; detail: string; to: string }
interface LessonRow { id: string; ref: string | null; startAt: string; endAt: string; status: string; learnerName: string | null; instructorId: string; instructorName: string | null; ongoing: boolean }

export const adminDashboard = onCall(opts, async (req: CallableRequest) => {
  await requireAnyAdmin(req);
  const from = new Date(String(req.data?.from ?? ''));
  const to = new Date(String(req.data?.to ?? ''));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) fail('Choose a valid date range.', 'invalid-argument');
  if (to.getTime() - from.getTime() > 400 * DAY_MS) fail('Choose a period of up to 400 days.', 'invalid-argument');

  const can = (m: ModuleKey, a: Action = 'view') => hasPermission(req, m, a);
  const [seeLearners, seeInstructors, seeBookings, seeFinance, seeInvoices, seeWallet, seeCommission, seeReports] = await Promise.all(
    (['learners', 'instructors', 'bookings', 'finance', 'invoices', 'wallet', 'commission', 'reports'] as ModuleKey[]).map(m => can(m)));
  const now = new Date();
  const todayStart = sydneyMidnight(now), todayEnd = new Date(todayStart.getTime() + DAY_MS + 3_600_000);
  const users = db.collection('users'), bookings = db.collection('bookings');
  const inRange = (d: Date | null) => !!d && d >= from && d < to;
  const activity: ActivityItem[] = [];
  const pending: { key: string; label: string; count: number; to: string; tone: 'warn' | 'bad' }[] = [];

  // ---------- People ----------
  let people: Record<string, unknown> | null = null;
  const instructorNames = new Map<string, string>();
  let verifiedInstructors: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  if (seeLearners || seeInstructors) {
    const [learnerSnap, instructorSnap] = await Promise.all([
      seeLearners ? users.where('role', '==', 'learner').select('accountStatus', 'status', 'createdAt', 'firstName', 'surname').get() : null,
      seeInstructors ? users.where('role', '==', 'instructor').select('accountStatus', 'verificationStatus', 'createdAt', 'firstName', 'surname', 'operatingHours', 'verifiedAt').get() : null,
    ]);
    // Placeholder learner records created by an instructor invite ('claimed') are not real accounts yet.
    const learners = learnerSnap?.docs.filter(d => d.data().status !== 'claimed') ?? [];
    const instructors = instructorSnap?.docs ?? [];
    instructors.forEach(d => instructorNames.set(d.id, nameOf(d.data())));
    const disabled = (d: FirebaseFirestore.QueryDocumentSnapshot) => d.data().accountStatus === 'disabled';
    verifiedInstructors = instructors.filter(d => d.data().verificationStatus === 'verified' && !disabled(d));
    const approval = { verified: 0, pending_review: 0, rejected: 0, not_submitted: 0 } as Record<string, number>;
    instructors.forEach(d => { const s = d.data().verificationStatus ?? 'not_submitted'; approval[s in approval ? s : 'not_submitted']++; });
    people = {
      learners: seeLearners ? { total: learners.length, active: learners.filter(d => !disabled(d)).length, inactive: learners.filter(disabled).length,
        new: learners.filter(d => inRange(ts(d.data().createdAt))).length } : null,
      instructors: seeInstructors ? { total: instructors.length, active: verifiedInstructors.length, suspended: instructors.filter(disabled).length,
        new: instructors.filter(d => inRange(ts(d.data().createdAt))).length, approval } : null,
    };
    if (seeInstructors && approval.pending_review) pending.push({ key: 'approvals', label: 'Instructor applications awaiting approval', count: approval.pending_review, to: '/admin/verifications?tab=pending_review', tone: 'warn' });
    if (seeLearners) learners.filter(d => inRange(ts(d.data().createdAt))).forEach(d => activity.push({ at: ts(d.data().createdAt)!.toISOString(), kind: 'learner', title: 'New learner registered', detail: nameOf(d.data()), to: `/admin/users/${d.id}` }));
    if (seeInstructors) {
      instructors.filter(d => inRange(ts(d.data().createdAt))).forEach(d => activity.push({ at: ts(d.data().createdAt)!.toISOString(), kind: 'instructor', title: 'New instructor registered', detail: nameOf(d.data()), to: `/admin/users/${d.id}` }));
      instructors.filter(d => inRange(ts(d.data().verifiedAt))).forEach(d => activity.push({ at: ts(d.data().verifiedAt)!.toISOString(), kind: 'approval', title: 'Instructor approved', detail: nameOf(d.data()), to: `/admin/users/${d.id}` }));
    }
  }

  // ---------- Bookings, today's operations and conflicts ----------
  let lessons: Record<string, unknown> | null = null;
  if (seeBookings) {
    const lessonQ = bookings.where('kind', '==', 'lesson');
    const [periodSnap, createdSnap, aheadSnap, total, upcomingTotal, proposed, lateCancel] = await Promise.all([
      lessonQ.where('startAt', '>=', Timestamp.fromDate(from)).where('startAt', '<', Timestamp.fromDate(to)).get(),
      lessonQ.where('createdAt', '>=', Timestamp.fromDate(from)).where('createdAt', '<', Timestamp.fromDate(to)).select('createdAt', 'learnerName', 'instructorName', 'ref').get(),
      // Everything holding time from the start of today for 60 days (lessons and personal events), for today's view and conflicts.
      bookings.where('startAt', '>=', Timestamp.fromDate(todayStart)).where('startAt', '<', Timestamp.fromDate(new Date(now.getTime() + 60 * DAY_MS)))
        .select('kind', 'status', 'startAt', 'endAt', 'instructorId', 'instructorName', 'learnerName', 'ref', 'title').get(),
      count(lessonQ), count(lessonQ.where('status', '==', 'confirmed').where('startAt', '>=', Timestamp.fromDate(now))),
      count(bookings.where('status', '==', 'proposed')), count(bookings.where('status', '==', 'late_cancel_requested')),
    ]);
    const period = periodSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Record<string, any>[];
    const st = (s: string) => period.filter(b => b.status === s).length;

    // Daily series across the period (Sydney days).
    const days: string[] = [];
    for (let t = sydneyMidnight(from).getTime(); t < to.getTime(); t += DAY_MS) { const k = dayKey(new Date(t + 3_600_000)); if (days.at(-1) !== k) days.push(k); }
    const series = days.map(day => ({ day, booked: 0, completed: 0, cancelled: 0, upcoming: 0, other: 0 }));
    const at = new Map(series.map(s => [s.day, s]));
    createdSnap.docs.forEach(d => { const c = ts(d.data().createdAt); const s = c && at.get(dayKey(c)); if (s) s.booked++; });
    period.forEach(b => {
      const s = at.get(dayKey(ts(b.startAt)!)); if (!s) return;
      if (b.status === 'completed') s.completed++;
      else if (b.status === 'cancelled') s.cancelled++;
      else if (b.status === 'confirmed' && ts(b.startAt)! >= now) s.upcoming++;
      else s.other++;
    });

    const ahead = aheadSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Record<string, any>[];
    const row = (b: Record<string, any>): LessonRow => ({
      id: b.id, ref: b.ref ?? null, startAt: ts(b.startAt)!.toISOString(), endAt: ts(b.endAt)!.toISOString(), status: b.status, learnerName: b.learnerName ?? null,
      instructorId: b.instructorId, instructorName: b.instructorName ?? instructorNames.get(b.instructorId) ?? null,
      ongoing: b.status === 'confirmed' && ts(b.startAt)! <= now && now < ts(b.endAt)!,
    });
    const todays = ahead.filter(b => b.kind === 'lesson' && ts(b.startAt)! < todayEnd && dayKey(ts(b.startAt)!) === dayKey(now)).map(row).sort((a, b) => a.startAt.localeCompare(b.startAt));

    // Conflicts: two things holding the same instructor's time that overlap (lesson + lesson, or lesson + personal event).
    const holding = ahead.filter(b => (b.kind === 'lesson' && HOLDS_TIME.includes(b.status)) || (b.kind === 'event' && b.status !== 'cancelled'));
    const byInstructor = new Map<string, Record<string, any>[]>();
    holding.forEach(b => byInstructor.set(b.instructorId, [...(byInstructor.get(b.instructorId) ?? []), b]));
    const conflicts: { instructorId: string; instructorName: string | null; first: LessonRow; second: LessonRow & { kind: string; title: string | null } }[] = [];
    for (const list of byInstructor.values()) {
      list.sort((a, b) => ts(a.startAt)!.getTime() - ts(b.startAt)!.getTime());
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length && ts(list[j].startAt)! < ts(list[i].endAt)!; j++) {
        const [a, b] = list[i].kind === 'lesson' ? [list[i], list[j]] : [list[j], list[i]];
        if (a.kind !== 'lesson' || ts(a.endAt)! < now) continue;
        conflicts.push({ instructorId: a.instructorId, instructorName: row(a).instructorName, first: row(a), second: { ...row(b), kind: b.kind, title: b.title ?? null } });
      }
    }

    // Instructor availability today, from each verified instructor's weekly hours and today's lessons.
    const wd = weekday(now);
    const availability = seeInstructors ? verifiedInstructors.map(d => {
      const hours = (d.data().operatingHours?.[wd] ?? []) as { start: string; end: string }[];
      const extra = ahead.filter(b => b.kind === 'open' && b.instructorId === d.id && dayKey(ts(b.startAt)!) === dayKey(now)).length;
      return { id: d.id, name: nameOf(d.data()), hours: hours.map(h => `${h.start}–${h.end}`), extraHours: extra, lessonsToday: todays.filter(l => l.instructorId === d.id && l.status !== 'cancelled').length };
    }).sort((a, b) => b.lessonsToday - a.lessonsToday || a.name.localeCompare(b.name)) : null;

    // Lessons per instructor in the period.
    const perInstructor = new Map<string, { id: string; name: string; lessons: number; completed: number; cancelled: number }>();
    period.forEach(b => {
      const r = perInstructor.get(b.instructorId) ?? { id: b.instructorId, name: b.instructorName ?? instructorNames.get(b.instructorId) ?? 'Instructor', lessons: 0, completed: 0, cancelled: 0 };
      r.lessons++; if (b.status === 'completed') r.completed++; if (b.status === 'cancelled') r.cancelled++;
      perInstructor.set(b.instructorId, r);
    });

    lessons = {
      total, inPeriod: period.length, upcoming: upcomingTotal, completed: st('completed'), cancelled: st('cancelled'), pending: proposed + lateCancel, proposed, lateCancel,
      series, today: {
        lessons: todays.slice(0, 50), scheduled: todays.filter(l => l.status !== 'cancelled').length, ongoing: todays.filter(l => l.ongoing).length,
        upcoming: todays.filter(l => l.status === 'confirmed' && l.startAt > now.toISOString()).length,
        completed: todays.filter(l => l.status === 'completed').length, cancelled: todays.filter(l => l.status === 'cancelled').length,
      },
      conflicts: conflicts.slice(0, 20), conflictCount: conflicts.length, availability,
      instructorActivity: [...perInstructor.values()].sort((a, b) => b.lessons - a.lessons).slice(0, 8),
    };
    if (proposed + lateCancel) pending.push({ key: 'bookings', label: 'Bookings awaiting a response (proposals and late-cancellation requests)', count: proposed + lateCancel, to: '/admin/bookings', tone: 'warn' });
    if (conflicts.length) pending.push({ key: 'conflicts', label: 'Scheduling conflicts (overlapping bookings)', count: conflicts.length, to: '/admin/bookings', tone: 'bad' });

    createdSnap.docs.forEach(d => { const b = d.data(); activity.push({ at: ts(b.createdAt)!.toISOString(), kind: 'booking', title: 'New booking', detail: [b.ref, b.learnerName, b.instructorName && `with ${b.instructorName}`].filter(Boolean).join(' · '), to: '/admin/bookings' }); });
    [...period, ...ahead.filter(b => b.kind === 'lesson')].forEach(b => {
      const detail = [b.ref, b.learnerName, b.instructorName && `with ${b.instructorName}`].filter(Boolean).join(' · ');
      if (b.status === 'cancelled' && inRange(ts(b.cancelledAt))) activity.push({ at: ts(b.cancelledAt)!.toISOString(), kind: 'cancelled', title: 'Booking cancelled', detail, to: '/admin/bookings' });
      if (b.status === 'completed' && inRange(ts(b.endAt))) activity.push({ at: ts(b.endAt)!.toISOString(), kind: 'completed', title: 'Lesson completed', detail, to: '/admin/bookings' });
    });
  }

  // ---------- Money ----------
  let finance: Record<string, unknown> | null = null;
  if (seeFinance || seeInvoices || seeWallet || seeCommission) {
    const fin = (await db.doc('integrations/xeroSettings').get()).data() ?? {};
    const [txSnap, invSnap, refundSnap, reconOpen, syncAttention, ledgerSnap] = await Promise.all([
      seeFinance || seeWallet ? db.collection('financeTransactions').where('createdAt', '>=', Timestamp.fromDate(from)).where('createdAt', '<', Timestamp.fromDate(to)).select('type', 'amount', 'createdAt', 'description', 'reference', 'invoiceNumber').get() : null,
      seeInvoices ? db.collection('invoices').where('amountDue', '>', 0).select('amountDue', 'status', 'number', 'learnerName', 'dueDate').get() : null,
      seeFinance ? db.collection('refundRequests').where('status', 'in', ['awaiting_approval', 'approved', 'awaiting_transfer', 'attention']).select('amount', 'status').get() : null,
      seeFinance ? count(db.collection('reconciliationIssues').where('status', '==', 'open')) : 0,
      seeFinance ? count(db.collection('financeTransactions').where('syncStatus', 'in', ['failed', 'attention'])) : 0,
      seeCommission ? db.collection('commissionLedger').where('bookedDay', '>=', dayKey(from)).where('bookedDay', '<=', dayKey(new Date(to.getTime() - 1))).select('status', 'commission', 'earnings').get() : null,
    ]);
    const tx = txSnap?.docs.map(d => ({ id: d.id, ...d.data() })) as Record<string, any>[] | undefined;
    const sum = (types: string[]) => money((tx ?? []).filter(t => types.includes(t.type)).reduce((s, t) => s + Math.abs(Number(t.amount ?? 0)), 0));
    const outstanding = invSnap?.docs.map(d => ({ id: d.id, ...d.data() }) as Record<string, any>).filter(i => Number(i.amountDue) > 0.004 && !['voided', 'credited'].includes(i.status));
    const refunds = refundSnap?.docs.map(d => d.data());
    const counted = ledgerSnap?.docs.map(d => d.data()).filter(l => ['booked', 'completed', 'late_fee'].includes(l.status));
    finance = {
      financeEnabled: fin.enabled === true,
      payments: seeFinance ? sum(['credit_purchase']) : null,
      wallet: seeWallet || seeFinance ? { credits: sum(CREDIT_TYPES), spent: sum(['allocation']), refunded: sum(['refund']) } : null,
      outstanding: outstanding ? { amount: money(outstanding.reduce((s, i) => s + Number(i.amountDue), 0)), count: outstanding.length } : null,
      refunds: refunds ? { awaitingApproval: refunds.filter(r => r.status === 'awaiting_approval').length, awaitingTransfer: refunds.filter(r => r.status !== 'awaiting_approval').length,
        amount: money(refunds.reduce((s, r) => s + Number(r.amount ?? 0), 0)), completed: sum(['refund']) } : null,
      commission: counted ? { commission: money(counted.reduce((s, l) => s + Number(l.commission ?? 0), 0)), earnings: money(counted.reduce((s, l) => s + Number(l.earnings ?? 0), 0)), lessons: counted.length } : null,
      recent: seeFinance && tx ? tx.sort((a, b) => ts(b.createdAt)!.getTime() - ts(a.createdAt)!.getTime()).slice(0, 8)
        .map(t => ({ id: t.id, at: ts(t.createdAt)!.toISOString(), type: t.type, amount: money(Number(t.amount ?? 0)), description: t.description ?? t.reference ?? t.invoiceNumber ?? null })) : null,
      issues: seeFinance ? { reconciliation: reconOpen, sync: syncAttention } : null,
    };
    if (refunds?.some(r => r.status === 'awaiting_approval')) pending.push({ key: 'refunds', label: 'Refund requests awaiting approval', count: refunds.filter(r => r.status === 'awaiting_approval').length, to: '/admin/finance?tab=refunds', tone: 'warn' });
    if (refunds?.some(r => r.status !== 'awaiting_approval')) pending.push({ key: 'transfers', label: 'Approved refunds to transfer', count: refunds.filter(r => r.status !== 'awaiting_approval').length, to: '/admin/finance?tab=refunds', tone: 'warn' });
    if (outstanding?.length) pending.push({ key: 'invoices', label: 'Outstanding invoices', count: outstanding.length, to: '/admin/finance?tab=invoices', tone: 'warn' });
    if (seeFinance && reconOpen + syncAttention) pending.push({ key: 'payments', label: 'Payment and reconciliation issues', count: reconOpen + syncAttention, to: '/admin/finance?tab=reconciliation', tone: 'bad' });
    if (seeFinance) (tx ?? []).filter(t => t.type === 'credit_purchase' || t.type === 'refund').forEach(t => activity.push({ at: ts(t.createdAt)!.toISOString(), kind: 'payment',
      title: t.type === 'refund' ? 'Refund paid' : 'Payment recorded', detail: `$${Math.abs(Number(t.amount ?? 0)).toFixed(2)}${t.description ? ` · ${t.description}` : ''}`, to: '/admin/finance?tab=transactions' }));
  }

  activity.sort((a, b) => b.at.localeCompare(a.at));
  return {
    access: { learners: seeLearners, instructors: seeInstructors, bookings: seeBookings, finance: seeFinance, invoices: seeInvoices, wallet: seeWallet, commission: seeCommission, reports: seeReports },
    people, lessons, finance, pending, activity: activity.slice(0, 25),
    range: { from: from.toISOString(), to: to.toISOString() }, generatedAt: now.toISOString(),
  };
});
