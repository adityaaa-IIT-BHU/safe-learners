import { rateForBooking } from './commission';
// Finance records for Xero: one ledger entry (financeTransactions) per financial event, invoices for
// lessons, credit sources for wallet credit, refund requests with approval, and an append-only audit.
// Triggers only READ bookings and wallet entries; they never change a booking or a wallet balance.
import { onDocumentCreated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onCall } from 'firebase-functions/v2/https';
import type { DocumentReference, Transaction } from 'firebase-admin/firestore';
import { CLOSED_STATUSES, LESSON_TYPES, fullName, normaliseBooking, type Booking } from '../../shared/domain';
import {
  CENT,
  CREDIT_CATEGORIES,
  creditNoteNumber,
  customerNumber,
  feeInvoiceNumber,
  invoiceNumberFor,
  invoiceStatusOf,
  lessonLines,
  line,
  missingSettings,
  money,
  planAllocation,
  refundableAmount,
  settingsFrom,
  refId,
  shortRef,
  totals,
  type AccountingSettings,
  type CreditCategory,
  type FinanceTxType,
  type InvoiceLine,
  type LineAmountTypes,
} from '../../shared/finance';
import { dayKey } from '../../shared/time';
import { FieldValue, Timestamp, db, fail, logger, notify, notifyAdmins, requireAdmin, requireAuth, toDate, userFrom, walletEntry } from './core';
import { refundGateway } from './gateway';
import { queueJob } from './xero';

const REGION = 'australia-southeast1';
const opts = { region: REGION, cors: true };
const ZONE = 'Australia/Sydney';

export const TX = db.collection('financeTransactions');
export const INVOICES = db.collection('invoices');
export const CUSTOMERS = db.collection('financeCustomers');
export const REFUNDS = db.collection('refundRequests');
export const AUDIT = db.collection('financeAudit');
export const SETTINGS = db.doc('integrations/xeroSettings');

const today = () => dayKey(new Date(), ZONE);

// ---------- Settings, audit ----------

export async function accountingSettings(): Promise<{ s: AccountingSettings; active: boolean; missing: string[] }> {
  const s = settingsFrom((await SETTINGS.get()).data());
  const missing = missingSettings(s);
  return { s, missing, active: s.enabled && missing.length === 0 && !!s.startDate && today() >= s.startDate };
}

export interface AuditInput {
  action: string;
  record: string;
  previousStatus?: string | null;
  newStatus?: string | null;
  manual?: boolean;
  by?: string;
  detail?: string;
  gatewayReference?: string | null;
  xeroResult?: string | null;
  error?: string | null;
}

/** Append-only: nothing (admins included) can edit or delete these from the browser. */
export async function audit(a: AuditInput, tx?: Transaction) {
  const doc = {
    action: a.action,
    record: a.record,
    previousStatus: a.previousStatus ?? null,
    newStatus: a.newStatus ?? null,
    mode: a.manual ? 'manual' : 'automatic',
    by: a.by ?? 'system',
    detail: a.detail ?? null,
    gatewayReference: a.gatewayReference ?? null,
    xeroResult: a.xeroResult ?? null,
    error: a.error ?? null,
    at: FieldValue.serverTimestamp(),
  };
  if (tx) tx.create(AUDIT.doc(), doc);
  else await AUDIT.add(doc);
}

// ---------- Ledger ----------

export interface LedgerInput {
  type: FinanceTxType;
  customerId: string;
  amount: number;
  description: string;
  source: 'booking' | 'cancellation' | 'reschedule' | 'late_cancel_fee' | 'admin' | 'referral' | 'refund' | 'system' | 'balance_payment';
  bookingId?: string;
  invoiceId?: string;
  invoiceNumber?: string;
  relatedId?: string;
  createdBy?: string;
  walletTxId?: string;
  /** Credit sources: how much credit this adds, and how much is still unused. */
  creditTotal?: number;
  /** Xero reference (prepayment reference, credit note number). */
  reference?: string;
  extra?: Record<string, unknown>;
}

function ledgerDoc(i: LedgerInput, date = today()) {
  return {
    type: i.type,
    customerId: i.customerId,
    amount: money(i.amount),
    description: i.description,
    source: i.source,
    bookingId: i.bookingId ?? null,
    invoiceId: i.invoiceId ?? null,
    invoiceNumber: i.invoiceNumber ?? null,
    relatedId: i.relatedId ?? null,
    walletTxId: i.walletTxId ?? null,
    reference: i.reference ?? null,
    createdBy: i.createdBy ?? 'system',
    date,
    createdMs: Date.now(),
    createdAt: FieldValue.serverTimestamp(),
    ...(i.creditTotal !== undefined ? { creditTotal: money(i.creditTotal), creditRemaining: money(i.creditTotal), isCredit: true } : {}),
    syncStatus: 'pending',
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    xeroId: null,
    ...(i.extra ?? {}),
  };
}

/** Sends ledger entries to the Xero queue (after the transaction that created them has committed). */
export async function queueLedger(ids: string[]) {
  for (const id of ids) await queueJob('fin', id, {});
}

// ---------- Customers ----------

const relevantCustomerFields = (d: Record<string, any> | undefined) =>
  d ? JSON.stringify([d.firstName ?? '', d.surname ?? '', (d.email ?? '').toLowerCase(), d.mobile ?? '']) : '';

/** Creates or refreshes the finance customer for a learner and queues the Xero contact sync. */
export async function syncCustomer(uid: string, force = false): Promise<void> {
  const userSnap = await db.doc(`users/${uid}`).get();
  const u = userSnap.data();
  if (!u || u.role !== 'learner' || u.status === 'claimed') return;
  const ref = CUSTOMERS.doc(uid);
  const fingerprint = relevantCustomerFields(u);
  const created = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const txRef = TX.doc(`customer__${uid}`);
    const txSnap = await tx.get(txRef);
    if (snap.exists && snap.data()!.fingerprint === fingerprint && !force) return false;
    tx.set(ref, {
      customerNumber: customerNumber(uid),
      name: fullName({ firstName: u.firstName, surname: u.surname }) || u.email || 'Learner',
      firstName: u.firstName ?? '',
      surname: u.surname ?? '',
      email: (u.email ?? '').toLowerCase() || null,
      mobile: u.mobile ?? null,
      fingerprint,
      ...(snap.exists ? {} : { createdAt: FieldValue.serverTimestamp(), matchStatus: 'new' }),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    if (!txSnap.exists) {
      tx.create(txRef, ledgerDoc({ type: 'customer', customerId: uid, amount: 0, description: `Customer ${customerNumber(uid)}`, source: 'system', reference: customerNumber(uid) }));
    } else {
      tx.update(txRef, { syncStatus: 'pending', lastError: null, updatedAt: FieldValue.serverTimestamp() });
    }
    return true;
  });
  if (created) await queueJob('fin', `customer__${uid}`, {}, { rerun: true });
}

// ---------- Invoices ----------

export interface InvoiceDoc {
  number: string;
  kind: 'lesson' | 'cancellation_fee' | 'adjustment';
  learnerId: string;
  learnerName: string;
  learnerEmail: string | null;
  customerNumber: string;
  bookingId: string | null;
  bookingRef: string | null;
  instructorId: string | null;
  instructorName: string | null;
  lessonDate: string | null;
  lessonType: string | null;
  durationMinutes: number | null;
  description: string;
  lines: InvoiceLine[];
  lineAmountTypes: LineAmountTypes;
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
  amountPaid: number;
  amountCredited: number;
  amountDue: number;
  status: string;
  issueDate: string;
  dueDate: string;
  voided: boolean;
  closed: string | null;
  allocations: { txId: string; amount: number; date: string; from: string }[];
  creditNotes: { txId: string; number: string; amount: number }[];
  relatedInvoiceId: string | null;
  history: { at: string; action: string }[];
  /** Seller details as printed on the invoice when it was issued. */
  seller: AccountingSettings['business'];
}

function withMoney<T extends Pick<InvoiceDoc, 'total' | 'amountPaid' | 'amountCredited' | 'dueDate' | 'voided'>>(inv: T): T & { amountDue: number; status: string } {
  const amountDue = inv.voided ? 0 : Math.max(0, money(inv.total - inv.amountPaid - inv.amountCredited));
  return { ...inv, amountDue, status: invoiceStatusOf(inv, today()) };
}

const historyNote = (action: string) => ({ at: new Date().toISOString(), action });

async function instructorGstRegistered(instructorId: string | undefined): Promise<boolean> {
  if (!instructorId) return false;
  const b = (await db.doc(`users/${instructorId}/private/banking`).get()).data();
  return b?.billing?.gstRegistered === true;
}

/** The lesson invoice for a booking, created once (invoice ID = booking ID). Returns null if not invoiceable. */
export async function ensureLessonInvoice(bookingId: string): Promise<string | null> {
  const { s, active } = await accountingSettings();
  if (!active) return null;
  const ref = INVOICES.doc(bookingId);
  if ((await ref.get()).exists) return bookingId;
  const snap = await db.doc(`bookings/${bookingId}`).get();
  const b = snap.exists ? normaliseBooking(snap.id, snap.data()!, toDate) : null;
  if (!b || b.kind !== 'lesson' || !b.learnerId || !(b.price && b.price > 0)) return null;
  if (!['confirmed', 'late_cancel_requested', 'completed'].includes(b.status) && !(b.walletPaid ?? 0)) return null;
  const learner = (await db.doc(`users/${b.learnerId}`).get()).data() ?? {};
  const gst = s.sellerModel === 'agent' ? await instructorGstRegistered(b.instructorId) : false;
  const mode = s.lineAmountTypes!;
  // Agent model: the booking fee is the lesson's own commission (fixed when it was confirmed).
  const feeRate = s.sellerModel === 'agent' && b.instructorId ? (await rateForBooking(b)).rate / 100 : undefined;
  const lines = lessonLines(b, s, gst, feeRate);
  const t = totals(lines, mode);
  const lessonDate = dayKey(b.startAt, b.timezone);
  const previous = b.rescheduledFrom ? ((await INVOICES.doc(b.rescheduledFrom).get()).exists ? b.rescheduledFrom : null) : null;
  const number = invoiceNumberFor(b);
  const created = await db.runTransaction(async tx => {
    if ((await tx.get(ref)).exists) return false;
    const inv: InvoiceDoc = withMoney({
      number,
      kind: 'lesson',
      learnerId: b.learnerId!,
      learnerName: fullName({ firstName: learner.firstName, surname: learner.surname }) || b.learnerName || 'Learner',
      learnerEmail: (learner.email ?? '').toLowerCase() || null,
      customerNumber: customerNumber(b.learnerId!),
      bookingId: b.id,
      bookingRef: b.ref ?? null,
      instructorId: b.instructorId,
      instructorName: b.instructorName ?? null,
      lessonDate,
      lessonType: b.lessonType ?? null,
      durationMinutes: b.lessonType ? LESSON_TYPES[b.lessonType]?.minutes ?? null : Math.round((b.endAt.getTime() - b.startAt.getTime()) / 60000),
      description: lines[0].description.split(':')[0],
      lines,
      lineAmountTypes: mode,
      ...t,
      amountPaid: 0,
      amountCredited: 0,
      amountDue: t.total,
      status: 'draft',
      issueDate: today(),
      dueDate: lessonDate < today() ? today() : lessonDate,
      voided: false,
      closed: null,
      allocations: [],
      creditNotes: [],
      relatedInvoiceId: previous,
      history: [historyNote(previous ? `Issued for a rescheduled lesson (replaces ${previous})` : 'Issued when the lesson was confirmed')],
      seller: s.business,
    });
    tx.create(ref, { ...inv, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    tx.create(TX.doc(`invoice__${bookingId}`), ledgerDoc({
      type: 'invoice', customerId: b.learnerId!, amount: t.total, description: `Invoice ${number}: ${inv.description}`,
      source: b.rescheduledFrom ? 'reschedule' : 'booking', bookingId, invoiceId: bookingId, invoiceNumber: number, relatedId: previous ?? undefined, reference: number,
    }));
    audit({ action: 'invoice_created', record: `invoices/${bookingId}`, newStatus: inv.status, detail: `${number} for ${money(t.total).toFixed(2)}` }, tx);
    return true;
  });
  if (created) {
    await syncCustomer(b.learnerId);
    await queueLedger([`invoice__${bookingId}`]);
  }
  return bookingId;
}

// ---------- Credit sources and allocation ----------

interface SourceRow { id: string; ref: DocumentReference; remaining: number; date: number }

async function readSources(tx: Transaction, customerId: string): Promise<SourceRow[]> {
  const snap = await tx.get(TX.where('customerId', '==', customerId).where('creditRemaining', '>', 0));
  return snap.docs.map(d => ({ id: d.id, ref: d.ref, remaining: Number(d.data().creditRemaining), date: Number(d.data().createdMs ?? 0) }));
}

/**
 * Applies wallet credit to an invoice inside a transaction, oldest credit first. If the recorded credit
 * doesn't cover it (credit from before the start date), the gap becomes an "opening credit" source.
 * With `isNew`, the invoice is being created in the same transaction: its patched copy is returned for
 * the caller to create (a transaction may write each document only once).
 */
function allocate(
  tx: Transaction,
  args: {
    txId: string; customerId: string; invoiceRef: DocumentReference; invoice: InvoiceDoc; amount: number; sources: SourceRow[];
    source: LedgerInput['source']; description: string; walletTxId?: string; fixedPieces?: { sourceId: string; amount: number }[]; isNew?: boolean;
  },
): { ids: string[]; invoice: InvoiceDoc } {
  const ids: string[] = [];
  const amount = money(Math.min(args.amount, Math.max(0, args.invoice.total - args.invoice.amountPaid - args.invoice.amountCredited)));
  if (amount <= CENT) return { ids, invoice: args.invoice };
  let pieces = args.fixedPieces;
  if (!pieces) {
    const plan = planAllocation(args.sources, amount);
    pieces = plan.pieces;
    if (plan.shortfall > 0) {
      const openId = `opening__${args.txId}`;
      tx.create(TX.doc(openId), ledgerDoc({
        type: 'opening_credit', customerId: args.customerId, amount: plan.shortfall, source: 'system',
        description: 'Wallet credit from before accounting started', reference: `SLCN-OPEN-${refId(args.txId)}`,
        extra: { creditTotal: plan.shortfall, creditRemaining: 0, isCredit: true },
      }));
      pieces.push({ sourceId: openId, amount: plan.shortfall });
      ids.push(openId);
    }
  }
  for (const p of pieces) {
    const s = args.sources.find(x => x.id === p.sourceId);
    if (s) tx.update(s.ref, { creditRemaining: money(s.remaining - p.amount) });
  }
  tx.create(TX.doc(args.txId), ledgerDoc({
    type: 'allocation', customerId: args.customerId, amount, source: args.source, description: args.description,
    bookingId: args.invoice.bookingId ?? undefined, invoiceId: args.invoiceRef.id, invoiceNumber: args.invoice.number, walletTxId: args.walletTxId,
    extra: { pieces: pieces.map(p => ({ ...p, done: false })) },
  }));
  ids.push(args.txId);
  const entry = { txId: args.txId, amount, date: today(), from: pieces.map(p => p.sourceId).join(',') };
  const note = historyNote(`${amount.toFixed(2)} applied from wallet credit`);
  const next = withMoney({ ...args.invoice, amountPaid: money(args.invoice.amountPaid + amount) });
  if (args.isNew) {
    return { ids, invoice: { ...next, allocations: [...args.invoice.allocations, entry], history: [...args.invoice.history, note] } };
  }
  tx.update(args.invoiceRef, {
    amountPaid: next.amountPaid, amountDue: next.amountDue, status: next.status,
    allocations: FieldValue.arrayUnion(entry), history: FieldValue.arrayUnion(note), updatedAt: FieldValue.serverTimestamp(),
  });
  return { ids, invoice: next };
}

async function sourceTotal(uid: string): Promise<number> {
  const snap = await TX.where('customerId', '==', uid).where('creditRemaining', '>', 0).get();
  return money(snap.docs.reduce((t, d) => t + Number(d.data().creditRemaining), 0));
}

/**
 * Records any credit whose own trigger hasn't run yet (a top-up, a referral, credit returned by a
 * cancellation), so a payment made straight after it doesn't look like credit from before the start date.
 */
async function catchUpCredits(uid: string) {
  const { s } = await accountingSettings();
  const start = s.startDate ? Date.parse(`${s.startDate}T00:00:00+10:00`) : 0;
  const snap = await db.collection(`users/${uid}/transactions`).where('amount', '>', 0).get();
  for (const d of snap.docs) {
    const w = d.data();
    if ((toDate(w.createdAt)?.getTime() ?? Date.now()) < start) continue;
    if (w.type === 'topup' || w.type === 'referral') await recordCredit(uid, d.id, w);
    else if (w.type === 'refund' && w.bookingId) await closeInvoice(w.bookingId);
  }
}

/** A lesson (or its balance) paid from the wallet: apply that credit to the lesson's invoice. */
async function recordLessonPayment(uid: string, walletTxId: string, bookingId: string, amount: number, source: LedgerInput['source']) {
  const invoiceId = await ensureLessonInvoice(bookingId);
  if (!invoiceId) return;
  const txId = `alloc__${walletTxId}`;
  if ((await TX.doc(txId).get()).exists) return;
  if ((await sourceTotal(uid)) + CENT < amount) await catchUpCredits(uid);
  const ids = await db.runTransaction(async tx => {
    if ((await tx.get(TX.doc(txId))).exists) return [];
    const invRef = INVOICES.doc(invoiceId);
    const inv = (await tx.get(invRef)).data() as InvoiceDoc | undefined;
    if (!inv || inv.voided || inv.closed) return [];
    const sources = await readSources(tx, uid);
    return allocate(tx, { txId, customerId: uid, invoiceRef: invRef, invoice: inv, amount, sources, source, walletTxId, description: `Wallet credit applied to ${inv.number}` }).ids;
  });
  await queueLedger(ids);
}

/** Credit added to the wallet (top-up, referral, goodwill, correction): a new credit source. */
async function recordCredit(uid: string, walletTxId: string, w: Record<string, any>) {
  const category: CreditCategory | 'referral' = w.type === 'referral' ? 'referral' : (w.category as CreditCategory) ?? 'correction';
  const type: FinanceTxType = category === 'referral' ? 'promo_credit' : CREDIT_CATEGORIES[category as CreditCategory]?.tx ?? 'correction_credit';
  const id = `credit__${walletTxId}`;
  const prefix = type === 'credit_purchase' ? 'TOPUP' : type === 'promo_credit' ? 'SLCN-PROMO' : type === 'goodwill_credit' ? 'SLCN-GOOD' : 'SLCN-ADJ';
  const created = await db.runTransaction(async tx => {
    if ((await tx.get(TX.doc(id))).exists) return false;
    tx.create(TX.doc(id), ledgerDoc({
      type, customerId: uid, amount: w.amount, creditTotal: w.amount, walletTxId,
      source: type === 'promo_credit' ? 'referral' : 'admin', createdBy: w.addedBy ?? 'system',
      description: `${w.note ?? 'Wallet credit'}`.slice(0, 200), reference: `${prefix}-${refId(walletTxId)}`,
      relatedId: w.referralOf ?? undefined,
      extra: { paymentMethod: w.paymentMethod ?? null, paymentReference: w.paymentReference ?? null, category },
    }));
    audit({ action: 'credit_recorded', record: `financeTransactions/${id}`, newStatus: 'pending', manual: !!w.addedBy, by: w.addedBy, detail: `${type} ${money(w.amount).toFixed(2)}${w.paymentReference ? ` ref ${w.paymentReference}` : ''}` }, tx);
    return true;
  });
  if (created) {
    await syncCustomer(uid);
    await queueLedger([id]);
  }
}

/** An admin deduction: an adjustment invoice paid from the learner's credit. */
async function recordDebit(uid: string, walletTxId: string, w: Record<string, any>) {
  const { s, active } = await accountingSettings();
  if (!active) return;
  const amount = money(-w.amount);
  const invId = `adj__${walletTxId}`;
  const number = `SL-ADJ-${refId(walletTxId)}`;
  const mode: LineAmountTypes = s.lineAmountTypes === 'Exclusive' ? 'Inclusive' : s.lineAmountTypes!;
  const lines = [line(`Wallet correction: ${w.note ?? ''}`.slice(0, 200), amount, s.adjustmentsAccount!, s.creditTaxType, { ...s, lineAmountTypes: mode })];
  const learner = (await db.doc(`users/${uid}`).get()).data() ?? {};
  if ((await sourceTotal(uid)) + CENT < amount) await catchUpCredits(uid);
  const ids = await db.runTransaction(async tx => {
    const invRef = INVOICES.doc(invId);
    if ((await tx.get(invRef)).exists) return [];
    const sources = await readSources(tx, uid);
    const draft: InvoiceDoc = withMoney({
      number, kind: 'adjustment', learnerId: uid, learnerName: fullName({ firstName: learner.firstName, surname: learner.surname }) || 'Learner',
      learnerEmail: (learner.email ?? '').toLowerCase() || null, customerNumber: customerNumber(uid), bookingId: null, bookingRef: null,
      instructorId: null, instructorName: null, lessonDate: null, lessonType: null, durationMinutes: null,
      description: 'Administrative wallet correction', lines, lineAmountTypes: mode, ...totals(lines, mode),
      amountPaid: 0, amountCredited: 0, amountDue: amount, status: 'draft', issueDate: today(), dueDate: today(), voided: false, closed: null,
      allocations: [], creditNotes: [], relatedInvoiceId: null, history: [historyNote('Created for an admin wallet correction')], seller: s.business,
    });
    const paid = allocate(tx, { txId: `alloc__${walletTxId}`, customerId: uid, invoiceRef: invRef, invoice: draft, amount, sources, source: 'admin', walletTxId, description: `Credit applied to ${number}`, isNew: true });
    tx.create(invRef, { ...paid.invoice, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    tx.create(TX.doc(`invoice__${invId}`), ledgerDoc({ type: 'debit_adjustment', customerId: uid, amount, source: 'admin', createdBy: w.addedBy, description: `Correction invoice ${number}`, invoiceId: invId, invoiceNumber: number, walletTxId, reference: number }));
    audit({ action: 'debit_recorded', record: `invoices/${invId}`, manual: true, by: w.addedBy, detail: `${amount.toFixed(2)}: ${w.note ?? ''}` }, tx);
    // Ledger order matters for Xero: the invoice before its allocation.
    return [`invoice__${invId}`, ...paid.ids];
  });
  if (ids.length) await syncCustomer(uid);
  await queueLedger(ids);
}

// ---------- Cancellations and reschedules ----------

/**
 * Once a booking is closed, settles its invoice: void if nothing was paid; otherwise a credit note for
 * the whole invoice (the paid part becomes wallet credit again, matching the wallet refund), or for a
 * kept late-cancellation fee, a credit note plus a separate cancellation-fee invoice paid by that credit.
 */
export async function closeInvoice(bookingId: string): Promise<void> {
  const { s, active } = await accountingSettings();
  if (!active) return;
  const bSnap = await db.doc(`bookings/${bookingId}`).get();
  const b = bSnap.exists ? normaliseBooking(bSnap.id, bSnap.data()!, toDate) : null;
  if (!b || !CLOSED_STATUSES.includes(b.status) || !b.learnerId) return;
  const invRef = INVOICES.doc(bookingId);
  const first = (await invRef.get()).data() as InvoiceDoc | undefined;
  if (!first || first.closed || first.voided) return;
  // Make sure every wallet payment for this lesson is on the invoice before settling it.
  const paid = await db.collection(`users/${b.learnerId}/transactions`).where('bookingId', '==', bookingId).get();
  for (const d of paid.docs) if (d.data().type === 'booking' && d.data().amount < 0) await recordLessonPayment(b.learnerId, d.id, bookingId, -d.data().amount, 'booking');

  const learnerId = b.learnerId;
  const rescheduled = !!b.rescheduledTo;
  const ids = await db.runTransaction(async tx => {
    const inv = (await tx.get(invRef)).data() as InvoiceDoc | undefined;
    if (!inv || inv.closed || inv.voided) return [] as string[];
    const out: string[] = [];
    const due = money(inv.total - inv.amountPaid - inv.amountCredited);
    const why = rescheduled ? `Rescheduled to booking ${b.rescheduledTo}` : `Booking ${b.ref ?? b.id} cancelled`;

    if (inv.amountPaid <= CENT) {
      const next = withMoney({ ...inv, voided: true });
      tx.update(invRef, { voided: true, closed: 'voided', amountDue: 0, status: next.status, history: FieldValue.arrayUnion(historyNote(`Voided: ${why}, nothing was paid`)), updatedAt: FieldValue.serverTimestamp() });
      tx.create(TX.doc(`void__${bookingId}`), ledgerDoc({ type: 'invoice_void', customerId: learnerId, amount: inv.total, source: rescheduled ? 'reschedule' : 'cancellation', description: `Void ${inv.number}: ${why}`, bookingId, invoiceId: bookingId, invoiceNumber: inv.number }));
      audit({ action: 'invoice_voided', record: `invoices/${bookingId}`, previousStatus: inv.status, newStatus: 'voided', detail: why }, tx);
      return [`void__${bookingId}`];
    }

    // Credit note for the whole invoice: the unpaid part settles the invoice; the paid part is credit again.
    const cnId = `cn__${bookingId}`;
    const cnNumber = `SL${creditNoteNumber(inv.number)}`;
    const keepFee = b.paymentStatus === 'charged';
    tx.create(TX.doc(cnId), ledgerDoc({
      type: 'credit_note', customerId: learnerId, amount: inv.total, creditTotal: inv.amountPaid, source: keepFee ? 'late_cancel_fee' : rescheduled ? 'reschedule' : 'cancellation',
      description: `Credit note ${cnNumber} for ${inv.number}: ${why}`, bookingId, invoiceId: bookingId, invoiceNumber: inv.number, reference: cnNumber,
      // A kept fee uses all of the returned credit straight away (below), so none is left for the wallet.
      extra: { lines: inv.lines, lineAmountTypes: inv.lineAmountTypes, allocateToInvoice: due, ...(keepFee ? { creditRemaining: 0 } : {}) },
    }));
    tx.update(invRef, {
      amountCredited: money(inv.amountCredited + due), amountDue: 0, status: 'credited', closed: keepFee ? 'fee_kept' : 'credited',
      creditNotes: FieldValue.arrayUnion({ txId: cnId, number: cnNumber, amount: inv.total }),
      history: FieldValue.arrayUnion(historyNote(`Credit note ${cnNumber}: ${why}${keepFee ? ' (late-cancellation fee kept)' : `; ${inv.amountPaid.toFixed(2)} returned to wallet credit`}`)),
      updatedAt: FieldValue.serverTimestamp(),
    });
    out.push(cnId);
    audit({ action: 'credit_note_created', record: `invoices/${bookingId}`, previousStatus: inv.status, newStatus: 'credited', detail: `${cnNumber} ${inv.total.toFixed(2)}: ${why}` }, tx);

    if (keepFee) {
      // The kept credit pays a separate cancellation-fee invoice, so the fee has its own account.
      const feeRef = INVOICES.doc(`fee__${bookingId}`);
      const number = feeInvoiceNumber(inv.number);
      const mode = inv.lineAmountTypes;
      const lines = [line(`Late cancellation fee: ${inv.description}`, inv.total, s.cancellationFeeAccount!, s.cancellationFeeTaxType, { ...s, lineAmountTypes: mode })];
      const draft: InvoiceDoc = withMoney({
        ...inv, number, kind: 'cancellation_fee', description: `Late cancellation fee for ${inv.number}`, lines, ...totals(lines, mode),
        amountPaid: 0, amountCredited: 0, amountDue: 0, status: 'draft', issueDate: today(), dueDate: today(), voided: false, closed: null,
        allocations: [], creditNotes: [], relatedInvoiceId: bookingId, history: [historyNote(`Late-cancellation fee kept by the instructor for ${inv.number}`)],
      });
      // The credit note's credit (what was paid) is applied to the fee invoice; any rest of the fee stays owing.
      const paidFee = allocate(tx, {
        txId: `alloc__fee__${bookingId}`, customerId: learnerId, invoiceRef: feeRef, invoice: draft, amount: inv.amountPaid, sources: [],
        source: 'late_cancel_fee', description: `Kept credit applied to ${number}`, fixedPieces: [{ sourceId: cnId, amount: money(Math.min(inv.amountPaid, draft.total)) }], isNew: true,
      });
      tx.create(feeRef, { ...paidFee.invoice, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      tx.create(TX.doc(`invoice__fee__${bookingId}`), ledgerDoc({ type: 'invoice', customerId: learnerId, amount: draft.total, source: 'late_cancel_fee', description: `Cancellation fee invoice ${number}`, bookingId, invoiceId: feeRef.id, invoiceNumber: number, relatedId: bookingId, reference: number }));
      out.push(`invoice__fee__${bookingId}`, ...paidFee.ids);
      audit({ action: 'cancellation_fee_invoiced', record: `invoices/${feeRef.id}`, newStatus: paidFee.invoice.status, detail: `${number} ${draft.total.toFixed(2)}, ${inv.amountPaid.toFixed(2)} paid from kept credit` }, tx);
    }
    return out;
  });
  await queueLedger(ids);
}

/** Lesson details changed while the invoice is still open: refresh the invoice lines. */
async function refreshInvoice(b: Booking) {
  const { s, active } = await accountingSettings();
  if (!active || !b.learnerId) return;
  const invRef = INVOICES.doc(b.id);
  const gst = s.sellerModel === 'agent' ? await instructorGstRegistered(b.instructorId) : false;
  const feeRate = s.sellerModel === 'agent' && b.instructorId ? (await rateForBooking(b)).rate / 100 : undefined;
  const changed = await db.runTransaction(async tx => {
    const inv = (await tx.get(invRef)).data() as InvoiceDoc | undefined;
    if (!inv || inv.closed || inv.voided) return false;
    const lines = lessonLines(b, s, gst, feeRate);
    const t = totals(lines, inv.lineAmountTypes);
    const lessonDate = dayKey(b.startAt, b.timezone);
    if (t.total === inv.total && lessonDate === inv.lessonDate && JSON.stringify(lines) === JSON.stringify(inv.lines)) return false;
    if (t.total < inv.amountPaid - CENT) {
      tx.update(TX.doc(`invoice__${b.id}`), { syncStatus: 'attention', lastError: `New price ${t.total.toFixed(2)} is below what was already paid (${inv.amountPaid.toFixed(2)}). Review the booking.` });
      return false;
    }
    const next = withMoney({ ...inv, ...t, dueDate: lessonDate < inv.issueDate ? inv.issueDate : lessonDate });
    tx.update(invRef, { lines, ...t, lessonDate, description: lines[0].description.split(':')[0], dueDate: next.dueDate, amountDue: next.amountDue, status: next.status, history: FieldValue.arrayUnion(historyNote(`Updated: lesson now ${lessonDate}, ${t.total.toFixed(2)}`)), updatedAt: FieldValue.serverTimestamp() });
    tx.update(TX.doc(`invoice__${b.id}`), { amount: t.total, syncStatus: 'pending', lastError: null });
    audit({ action: 'invoice_updated', record: `invoices/${b.id}`, previousStatus: inv.status, newStatus: next.status, detail: `Total ${inv.total.toFixed(2)} → ${t.total.toFixed(2)}, date ${inv.lessonDate} → ${lessonDate}` }, tx);
    return true;
  });
  if (changed) await queueJob('fin', `invoice__${b.id}`, {}, { rerun: true });
}

// ---------- Triggers ----------

/** Every wallet movement becomes a finance record (or is linked to one). */
export const financeOnWalletEntry = onDocumentCreated({ document: 'users/{uid}/transactions/{txId}', region: REGION, retry: true }, async event => {
  const w = event.data?.data();
  if (!w || !(await accountingSettings()).active) return;
  const { uid, txId } = event.params;
  const amount = Number(w.amount);
  try {
    if (w.type === 'booking' && amount < 0 && w.bookingId) await recordLessonPayment(uid, txId, w.bookingId, -amount, w.balancePayment ? 'balance_payment' : 'booking');
    else if ((w.type === 'topup' || w.type === 'referral') && amount > 0) await recordCredit(uid, txId, w);
    else if (w.type === 'adjustment' && amount < 0) await recordDebit(uid, txId, w);
    else if (w.type === 'refund' && w.bookingId) await closeInvoice(w.bookingId); // the booking trigger does the same; both are safe
    // refund_payout (refund held/paid) and refund credit-backs are recorded by the refund workflow.
  } catch (err) {
    logger.error('Finance record for wallet entry failed', { uid, txId, err: String(err) });
    throw err; // retried by the trigger
  }
});

export const financeOnBookingWrite = onDocumentWritten({ document: 'bookings/{id}', region: REGION, retry: true }, async event => {
  const after = event.data?.after;
  if (!after?.exists || !(await accountingSettings()).active) return;
  const b = normaliseBooking(after.id, after.data()!, toDate);
  if (!b || b.kind !== 'lesson' || !b.learnerId) return;
  const beforeStatus = event.data?.before?.data()?.status;
  if (['confirmed', 'late_cancel_requested', 'completed'].includes(b.status)) {
    if (beforeStatus !== b.status || !(await INVOICES.doc(b.id).get()).exists) await ensureLessonInvoice(b.id);
    else await refreshInvoice(b);
  } else if (CLOSED_STATUSES.includes(b.status)) {
    await closeInvoice(b.id);
  }
});

export const financeOnLearnerWrite = onDocumentWritten({ document: 'users/{uid}', region: REGION, retry: true }, async event => {
  const after = event.data?.after?.data();
  if (!after || after.role !== 'learner' || !(await accountingSettings()).active) return;
  if (relevantCustomerFields(event.data?.before?.data()) === relevantCustomerFields(after)) return;
  await syncCustomer(event.params.uid);
});

// ---------- Paying an outstanding balance ----------

/** Learner (or admin) pays what's still due on a lesson from wallet credit. */
export const payInvoiceFromWallet = onCall(opts, async req => {
  const uid = requireAuth(req);
  const isAdmin = req.auth!.token.admin === true;
  const invoiceId = String(req.data?.invoiceId || '');
  const inv = (await INVOICES.doc(invoiceId).get()).data() as InvoiceDoc | undefined;
  if (!inv || (!isAdmin && inv.learnerId !== uid)) fail('Invoice not found.', 'not-found');
  if (inv.kind !== 'lesson' || !inv.bookingId) fail('Only lesson invoices can be paid from the wallet.');
  if (inv.voided || inv.closed || inv.amountDue <= CENT) fail('Nothing is owing on this invoice.');
  const paid = await db.runTransaction(async tx => {
    const bRef = db.doc(`bookings/${inv.bookingId}`);
    const bSnap = await tx.get(bRef);
    const b = bSnap.exists ? normaliseBooking(bSnap.id, bSnap.data()!, toDate) : null;
    const learner = userFrom(await tx.get(db.doc(`users/${inv.learnerId}`)));
    if (!b || !learner) fail('Booking not found.', 'not-found');
    if (!['confirmed', 'late_cancel_requested', 'completed'].includes(b.status)) fail('This lesson is no longer active.');
    const owing = money((b.price ?? 0) - (b.walletPaid ?? 0));
    const take = money(Math.min(learner.walletBalance ?? 0, owing));
    if (take <= CENT) fail('There’s no wallet credit to pay with.');
    walletEntry(tx, learner.id, learner.walletBalance ?? 0, -take, { type: 'booking', note: `Balance for booking ${b.ref ?? ''}`.trim(), bookingId: b.id, balancePayment: true });
    const walletPaid = money((b.walletPaid ?? 0) + take);
    tx.update(bRef, { walletPaid, paymentStatus: walletPaid >= (b.price ?? 0) - CENT ? 'paid' : 'part_paid' });
    return take;
  });
  await audit({ action: 'balance_paid_from_wallet', record: `invoices/${invoiceId}`, manual: true, by: uid, detail: `${paid.toFixed(2)} from wallet` });
  return { paid };
});

// ---------- Refunds ----------

export interface RefundDoc {
  number: string;
  customerId: string;
  customerName: string;
  customerEmail: string | null;
  amount: number;
  reason: string;
  sourceTxId: string | null;
  paymentReference: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  status: string;
  requestedBy: string;
  requestedAt: Timestamp;
  decidedBy?: string;
  decidedAt?: Timestamp;
  rejectionReason?: string;
  transferReference?: string;
  transferDate?: string;
  completedBy?: string;
  completedAt?: Timestamp;
  financeTxId?: string;
  history: { at: string; status: string; by: string; note?: string }[];
}

async function awaitingAmounts(customerId: string, tx?: Transaction): Promise<number[]> {
  const q = REFUNDS.where('customerId', '==', customerId).where('status', '==', 'awaiting_approval');
  const snap = tx ? await tx.get(q) : await q.get();
  return snap.docs.map(d => Number(d.data().amount));
}

export const requestRefund = onCall(opts, async req => {
  const uid = requireAuth(req);
  const isAdmin = req.auth!.token.admin === true;
  const customerId = isAdmin && req.data?.customerId ? String(req.data.customerId) : uid;
  const amount = money(Number(req.data?.amount));
  const reason = String(req.data?.reason || '').trim().slice(0, 1000);
  const sourceTxId = req.data?.sourceTxId ? String(req.data.sourceTxId) : null;
  const invoiceId = req.data?.invoiceId ? String(req.data.invoiceId) : null;
  if (!(amount > 0)) fail('Enter the amount you’d like refunded.', 'invalid-argument');
  if (reason.length < 3) fail('Please tell us why you’re asking for a refund.', 'invalid-argument');
  const id = REFUNDS.doc().id;
  const number = `RF-${shortRef(id)}`;
  await db.runTransaction(async tx => {
    const learner = userFrom(await tx.get(db.doc(`users/${customerId}`)));
    if (!learner || learner.role !== 'learner') fail('Learner not found.', 'not-found');
    const max = refundableAmount(learner.walletBalance ?? 0, await awaitingAmounts(customerId, tx));
    if (amount > max + CENT) fail(`You can ask for up to $${max.toFixed(2)} (your wallet credit not already in a refund request).`);
    let paymentReference: string | null = null;
    if (sourceTxId) {
      const src = (await tx.get(TX.doc(sourceTxId))).data();
      if (!src || src.customerId !== customerId || !src.isCredit) fail('That payment can’t be found.', 'not-found');
      paymentReference = src.paymentReference ?? src.reference ?? null;
    }
    let invoiceNumber: string | null = null;
    if (invoiceId) {
      const inv = (await tx.get(INVOICES.doc(invoiceId))).data();
      if (!inv || inv.learnerId !== customerId) fail('That invoice can’t be found.', 'not-found');
      invoiceNumber = inv.number;
    }
    const doc: RefundDoc = {
      number, customerId, customerName: fullName(learner), customerEmail: (learner.email ?? '').toLowerCase() || null,
      amount, reason, sourceTxId, paymentReference, invoiceId, invoiceNumber, status: 'awaiting_approval',
      requestedBy: uid, requestedAt: Timestamp.now(),
      history: [{ at: new Date().toISOString(), status: 'awaiting_approval', by: uid, note: isAdmin && uid !== customerId ? 'Raised by an admin' : 'Requested by the learner' }],
    };
    tx.create(REFUNDS.doc(id), doc);
    audit({ action: 'refund_requested', record: `refundRequests/${id}`, newStatus: 'awaiting_approval', manual: true, by: uid, detail: `${number} ${amount.toFixed(2)}: ${reason.slice(0, 120)}` }, tx);
  });
  await notifyAdmins({ type: 'refund_request', title: `Refund request ${number}`, body: `$${amount.toFixed(2)} requested. Approval needed.`, link: '/admin/finance?tab=refunds' });
  return { id, number };
});

export const decideRefund = onCall(opts, async req => {
  const adminUid = requireAdmin(req);
  const id = String(req.data?.id || '');
  if (!id) fail('Refund request not found.', 'not-found');
  const approve = req.data?.approve === true;
  const note = String(req.data?.reason || '').trim().slice(0, 500);
  if (!approve && note.length < 3) fail('Enter the reason for rejecting this refund.', 'invalid-argument');
  const ref = REFUNDS.doc(id);
  const r = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const r = snap.data() as RefundDoc | undefined;
    if (!r) fail('Refund request not found.', 'not-found');
    if (r.status !== 'awaiting_approval') fail(`This request is already ${r.status.replace(/_/g, ' ')}.`);
    const at = new Date().toISOString();
    if (!approve) {
      tx.update(ref, { status: 'rejected', decidedBy: adminUid, decidedAt: Timestamp.now(), rejectionReason: note, history: FieldValue.arrayUnion({ at, status: 'rejected', by: adminUid, note }) });
      audit({ action: 'refund_rejected', record: `refundRequests/${id}`, previousStatus: r.status, newStatus: 'rejected', manual: true, by: adminUid, detail: note }, tx);
      return r;
    }
    const learner = userFrom(await tx.get(db.doc(`users/${r.customerId}`)));
    if (!learner) fail('Learner not found.', 'not-found');
    if ((learner.walletBalance ?? 0) + CENT < r.amount) fail(`The learner now has only $${(learner.walletBalance ?? 0).toFixed(2)} of credit, less than this request.`);
    // Approved credit is taken out of the wallet now so it can't also be spent on lessons.
    walletEntry(tx, r.customerId, learner.walletBalance ?? 0, -r.amount, { type: 'refund_payout', note: `Refund ${r.number} approved: awaiting transfer`, refundRequestId: id });
    const next = refundGateway().afterApproval();
    tx.update(ref, {
      status: next, decidedBy: adminUid, decidedAt: Timestamp.now(),
      history: FieldValue.arrayUnion({ at, status: 'approved', by: adminUid, ...(note ? { note } : {}) }, { at, status: next, by: 'system', note: refundGateway().label }),
    });
    audit({ action: 'refund_approved', record: `refundRequests/${id}`, previousStatus: r.status, newStatus: next, manual: true, by: adminUid, detail: `${r.amount.toFixed(2)} held from wallet; ${refundGateway().label}` }, tx);
    return r;
  });
  await notify(r.customerId, {
    type: 'refund',
    title: approve ? `Refund ${r.number} approved` : `Refund ${r.number} not approved`,
    body: approve ? `$${r.amount.toFixed(2)} will be sent to you by bank transfer. We’ll let you know once it’s paid.` : `Reason: ${note}`,
    link: '/learner/wallet',
  });
  return { ok: true };
});

/** Admin confirms the bank transfer was made: completes the refund and queues the Xero entry. */
export const confirmRefundTransfer = onCall(opts, async req => {
  const adminUid = requireAdmin(req);
  const id = String(req.data?.id || '');
  if (!id) fail('Refund request not found.', 'not-found');
  const transferReference = String(req.data?.transferReference || '').trim().slice(0, 100);
  const transferDate = String(req.data?.transferDate || '');
  if (!transferReference) fail('Enter the bank transfer reference.', 'invalid-argument');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(transferDate) || transferDate > today()) fail('Enter the date the transfer was made (not in the future).', 'invalid-argument');
  const { active } = await accountingSettings();
  const ref = REFUNDS.doc(id);
  const finId = `refund__${id}`;
  const pre = (await ref.get()).data() as RefundDoc | undefined;
  if (active && pre && (await sourceTotal(pre.customerId)) + CENT < pre.amount) await catchUpCredits(pre.customerId);
  const r = await db.runTransaction(async tx => {
    const r = (await tx.get(ref)).data() as RefundDoc | undefined;
    if (!r) fail('Refund request not found.', 'not-found');
    if (r.status !== 'awaiting_transfer') fail(r.status === 'completed' ? 'This refund is already completed.' : 'Only approved refunds awaiting transfer can be confirmed.');
    const sources = active ? await readSources(tx, r.customerId) : [];
    const at = new Date().toISOString();
    if (active) {
      const plan = planAllocation(sources, r.amount);
      for (const p of plan.pieces) {
        const s = sources.find(x => x.id === p.sourceId)!;
        tx.update(s.ref, { creditRemaining: money(s.remaining - p.amount) });
      }
      tx.create(TX.doc(finId), ledgerDoc({
        type: 'refund', customerId: r.customerId, amount: r.amount, source: 'refund', createdBy: adminUid,
        description: `Refund ${r.number} paid by bank transfer (${transferReference})`, relatedId: id, reference: transferReference,
        extra: { pieces: plan.pieces.map(p => ({ ...p, done: false })), transferDate, ...(plan.shortfall > 0 ? { syncStatus: 'attention', lastError: `Recorded credit is $${plan.shortfall.toFixed(2)} short of this refund; check the customer's credit before syncing.` } : {}) },
      }));
    }
    tx.update(ref, {
      status: 'completed', transferReference, transferDate, completedBy: adminUid, completedAt: Timestamp.now(), financeTxId: active ? finId : null,
      history: FieldValue.arrayUnion({ at, status: 'processing', by: adminUid, note: `Transfer ${transferReference} on ${transferDate}` }, { at, status: 'completed', by: adminUid }),
    });
    audit({ action: 'refund_completed', record: `refundRequests/${id}`, previousStatus: r.status, newStatus: 'completed', manual: true, by: adminUid, gatewayReference: transferReference, detail: `${r.amount.toFixed(2)} paid ${transferDate}` }, tx);
    return r;
  });
  if (active) await queueLedger([finId]);
  await notify(r.customerId, { type: 'refund', title: `Refund ${r.number} paid`, body: `$${r.amount.toFixed(2)} was sent to you by bank transfer (reference ${transferReference}).`, link: '/learner/wallet' });
  return { ok: true };
});

/** An approved refund that can't be paid: the held credit goes back to the wallet. */
export const cancelApprovedRefund = onCall(opts, async req => {
  const adminUid = requireAdmin(req);
  const id = String(req.data?.id || '');
  if (!id) fail('Refund request not found.', 'not-found');
  const note = String(req.data?.reason || '').trim().slice(0, 500);
  if (note.length < 3) fail('Enter why this refund is being cancelled.', 'invalid-argument');
  const ref = REFUNDS.doc(id);
  const r = await db.runTransaction(async tx => {
    const r = (await tx.get(ref)).data() as RefundDoc | undefined;
    if (!r) fail('Refund request not found.', 'not-found');
    if (!['awaiting_transfer', 'attention'].includes(r.status)) fail('Only an approved refund that hasn’t been paid can be cancelled.');
    const learner = userFrom(await tx.get(db.doc(`users/${r.customerId}`)));
    walletEntry(tx, r.customerId, learner?.walletBalance ?? 0, r.amount, { type: 'refund', note: `Refund ${r.number} cancelled: credit returned`, refundRequestId: id });
    tx.update(ref, { status: 'cancelled', history: FieldValue.arrayUnion({ at: new Date().toISOString(), status: 'cancelled', by: adminUid, note }) });
    audit({ action: 'refund_cancelled', record: `refundRequests/${id}`, previousStatus: r.status, newStatus: 'cancelled', manual: true, by: adminUid, detail: note }, tx);
    return r;
  });
  await notify(r.customerId, { type: 'refund', title: `Refund ${r.number} cancelled`, body: `$${r.amount.toFixed(2)} is back in your wallet. ${note}`, link: '/learner/wallet' });
  return { ok: true };
});

// ---------- Admin: settings, customers, retries ----------

const ACCOUNT_FIELDS = [
  'sellerModel', 'lineAmountTypes', 'lessonAccount', 'lessonTaxType', 'feeAccount', 'feeTaxType', 'instructorPayableAccount',
  'instructorTaxTypeRegistered', 'instructorTaxTypeUnregistered', 'cancellationFeeAccount', 'cancellationFeeTaxType', 'prepaymentAccount',
  'topupBankAccount', 'refundBankAccount', 'promotionsAccount', 'goodwillAccount', 'adjustmentsAccount', 'openingCreditAccount', 'creditTaxType',
] as const;

/** Saves the accounting settings. Switching finance on needs every setting the chosen treatment requires. */
export const financeSaveSettings = onCall(opts, async req => {
  const uid = requireAdmin(req);
  const d = req.data ?? {};
  const current = settingsFrom((await SETTINGS.get()).data());
  const next: AccountingSettings = { ...current };
  for (const f of ACCOUNT_FIELDS) if (f in d) (next as any)[f] = d[f] === '' || d[f] === null ? null : String(d[f]).slice(0, 60);
  if (next.sellerModel && !['principal', 'agent'].includes(next.sellerModel)) fail('Seller model must be principal or agent.', 'invalid-argument');
  if (next.lineAmountTypes && !['Inclusive', 'Exclusive', 'NoTax'].includes(next.lineAmountTypes)) fail('Choose how prices treat GST.', 'invalid-argument');
  if ('platformFeeRate' in d) next.platformFeeRate = Number(d.platformFeeRate);
  if ('startDate' in d) next.startDate = d.startDate ? String(d.startDate) : null;
  if (next.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(next.startDate)) fail('Start date must be a date.', 'invalid-argument');
  if (d.business) next.business = { name: String(d.business.name ?? '').slice(0, 120), abn: String(d.business.abn ?? '').slice(0, 20), address: String(d.business.address ?? '').slice(0, 200), email: String(d.business.email ?? '').slice(0, 120) };
  if ('accountantConfirmed' in d) next.accountantConfirmed = d.accountantConfirmed === true;
  // Tax rates come from the connected organisation, never typed in.
  const lookups = (await db.doc('integrations/xeroLookups').get()).data();
  next.taxRates = Object.fromEntries(((lookups?.taxRates ?? []) as { taxType: string; rate: number | null }[]).map(t => [t.taxType, Number(t.rate ?? 0)]));
  const codes = new Set(((lookups?.accounts ?? []) as { code: string | null; id?: string }[]).flatMap(a => [a.code, a.id]).filter(Boolean));
  const unknown = ACCOUNT_FIELDS.filter(f => f.endsWith('Account') && (next as any)[f] && codes.size && !codes.has((next as any)[f]));
  if (unknown.length) fail(`These accounts aren’t in the connected Xero organisation: ${unknown.join(', ')}. Refresh the Xero lists and choose again.`, 'invalid-argument');
  const taxTypes = new Set(Object.keys(next.taxRates));
  const badTax = ACCOUNT_FIELDS.filter(f => f.endsWith('TaxType') && (next as any)[f] && taxTypes.size && !taxTypes.has((next as any)[f]));
  if (badTax.length) fail(`These tax types aren’t in the connected Xero organisation: ${badTax.join(', ')}.`, 'invalid-argument');
  const wantEnabled = 'enabled' in d ? d.enabled === true : current.enabled;
  const missing = missingSettings(next);
  if (wantEnabled && missing.length) fail(`Before switching finance on, complete: ${missing.join(', ')}.`);
  next.enabled = wantEnabled;
  await SETTINGS.set({ ...next, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
  await audit({ action: 'settings_saved', record: 'integrations/xeroSettings', previousStatus: current.enabled ? 'on' : 'off', newStatus: next.enabled ? 'on' : 'off', manual: true, by: uid, detail: `${next.sellerModel ?? '—'}, ${next.lineAmountTypes ?? '—'}, start ${next.startDate ?? '—'}` });
  return { ok: true, missing };
});

/** An email-only match flagged for review: link to that Xero contact, or create a new one. */
export const resolveCustomerMatch = onCall(opts, async req => {
  const uid = requireAdmin(req);
  const customerId = String(req.data?.customerId || '');
  const action = req.data?.action === 'link' ? 'link' : 'create';
  const ref = CUSTOMERS.doc(customerId);
  const c = (await ref.get()).data();
  if (!c || c.matchStatus !== 'review') fail('Nothing to review for this customer.');
  await ref.update(action === 'link'
    ? { matchStatus: 'linked_by_admin', xeroContactId: c.candidateContactId, reviewedBy: uid }
    : { matchStatus: 'create_confirmed', reviewedBy: uid });
  await audit({ action: 'customer_match_resolved', record: `financeCustomers/${customerId}`, previousStatus: 'review', newStatus: action, manual: true, by: uid, detail: action === 'link' ? `Linked to Xero contact ${c.candidateContactId}` : 'New Xero contact to be created' });
  await TX.doc(`customer__${customerId}`).update({ syncStatus: 'pending', lastError: null });
  await queueJob('fin', `customer__${customerId}`, {}, { rerun: true });
  return { ok: true };
});

/** Retries one ledger entry (or every failed one) through the queue. Only the Xero step repeats. */
export const financeRetry = onCall(opts, async req => {
  const uid = requireAdmin(req);
  const id = req.data?.txId ? String(req.data.txId) : '';
  const snap = id ? [await TX.doc(id).get()] : (await TX.where('syncStatus', 'in', ['failed', 'attention']).limit(200).get()).docs;
  let n = 0;
  for (const d of snap) {
    if (!d.exists || !['failed', 'attention'].includes(d.data()!.syncStatus)) continue;
    await d.ref.update({ syncStatus: 'pending', lastError: null, attempts: 0 });
    await queueJob('fin', d.id, {}, { rerun: true });
    n++;
  }
  await audit({ action: 'sync_retry', record: id ? `financeTransactions/${id}` : 'financeTransactions/*', manual: true, by: uid, detail: `${n} queued again` });
  return { retried: n };
});
