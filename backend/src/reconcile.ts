// Nightly reconciliation between SafeLearners finance records and Xero. READ-ONLY: it compares and lists
// differences for an admin; it never changes a financial record to make the two sides match.
import { onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { CENT, money } from '../../shared/finance';
import { FieldValue, Timestamp, db, fail, logger, notifyAdmins, requireAdmin } from './core';
import { AUDIT, CUSTOMERS, INVOICES, REFUNDS, TX, accountingSettings } from './finance';
import { xeroFetch } from './xero';

const API = '/api.xro/2.0';
const ISSUES = db.collection('reconciliationIssues');
const RUNS = db.collection('reconciliationRuns');
const STATUS = db.doc('integrations/financeStatus');
const DAY = 86_400_000;

export interface Issue {
  kind: string;
  ref: string;
  label: string;
  slValue: string | number | null;
  xeroValue: string | number | null;
  difference: number | null;
  suggestion: string;
  link: string | null;
  txId?: string | null;
}

async function pages(path: string, key: string, max = 50): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= max; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await xeroFetch(`${path}${sep}page=${page}`);
    const rows = (r.json?.[key] ?? []) as any[];
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

const diff = (a: number, b: number) => money(a - b);

export async function reconcile(by = 'system'): Promise<{ issues: number; checked: Record<string, number>; skippedCustomers: number }> {
  const { active } = await accountingSettings();
  if (!active) fail('Finance is switched off, so there is nothing to reconcile.');
  const found = new Map<string, Issue>();
  const add = (i: Issue) => found.set(`${i.kind}__${i.ref}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 300), i);
  const now = Date.now();

  // 1. Sync failures and entries pending for more than 24 hours.
  const txs = (await TX.get()).docs.map(d => ({ id: d.id, ...d.data() } as Record<string, any>));
  const unsettledCustomers = new Set<string>();
  for (const t of txs) {
    if (['failed', 'attention'].includes(t.syncStatus)) {
      add({ kind: t.syncStatus === 'failed' ? 'sync_failed' : 'requires_attention', ref: t.id, label: t.description, slValue: t.amount, xeroValue: null, difference: null, suggestion: t.lastError ? `${t.lastError} Fix this, then press Retry.` : 'Press Retry.', link: null, txId: t.id });
      unsettledCustomers.add(t.customerId);
    } else if (['pending', 'processing', 'waiting'].includes(t.syncStatus)) {
      unsettledCustomers.add(t.customerId);
      if (now - Number(t.createdMs ?? now) > DAY) add({ kind: 'stuck', ref: t.id, label: t.description, slValue: t.amount, xeroValue: null, difference: null, suggestion: 'Pending for more than 24 hours. Check the Xero connection, then Retry.', link: null, txId: t.id });
    }
  }

  // 2. Invoices: amounts, balances and status against Xero.
  const invoices = (await INVOICES.get()).docs.map(d => ({ id: d.id, ...d.data() } as Record<string, any>));
  const synced = invoices.filter(i => i.xero?.invoiceId);
  const xeroById = new Map<string, any>();
  for (let i = 0; i < synced.length; i += 40) {
    const ids = synced.slice(i, i + 40).map(x => x.xero.invoiceId).join(',');
    const r = await xeroFetch(`${API}/Invoices?IDs=${ids}`);
    for (const x of r.json?.Invoices ?? []) xeroById.set(x.InvoiceID, x);
  }
  for (const inv of synced) {
    const x = xeroById.get(inv.xero.invoiceId);
    const link = `/admin/finance?tab=invoices&invoice=${inv.id}`;
    if (!x || x.Status === 'DELETED') { add({ kind: 'missing_in_xero', ref: `invoice-${inv.id}`, label: `Invoice ${inv.number}`, slValue: inv.total, xeroValue: null, difference: inv.total, suggestion: 'The invoice is not in Xero. Check whether it was deleted there; retry its sync if so.', link }); continue; }
    if (Math.abs(diff(Number(x.Total), inv.total)) > CENT) add({ kind: 'amount_mismatch', ref: `invoice-${inv.id}`, label: `Invoice ${inv.number} total`, slValue: inv.total, xeroValue: Number(x.Total), difference: diff(inv.total, Number(x.Total)), suggestion: 'Totals differ: usually a tax setting or an edit made in Xero. Confirm the correct amount with the accountant.', link });
    if (unsettledCustomers.has(inv.learnerId)) continue; // allocations still on their way
    const slVoid = !!inv.voided;
    if (slVoid !== (x.Status === 'VOIDED')) add({ kind: 'status_mismatch', ref: `invoice-${inv.id}`, label: `Invoice ${inv.number} status`, slValue: inv.status, xeroValue: x.Status, difference: null, suggestion: slVoid ? 'Voided in SafeLearners but not in Xero.' : 'Voided in Xero but still active in SafeLearners.', link });
    if (!slVoid && Math.abs(diff(Number(x.AmountDue ?? 0), Number(inv.amountDue))) > CENT) add({ kind: 'allocation_mismatch', ref: `invoice-${inv.id}`, label: `Invoice ${inv.number} balance due`, slValue: inv.amountDue, xeroValue: Number(x.AmountDue ?? 0), difference: diff(inv.amountDue, Number(x.AmountDue ?? 0)), suggestion: 'Credit applied differs between the systems. Compare the allocations on both sides.', link });
  }

  // 3. SafeLearners invoices in Xero that SafeLearners doesn't know, and duplicate numbers.
  const xeroInvoices = await pages(`${API}/Invoices?where=${encodeURIComponent('InvoiceNumber != null AND InvoiceNumber.StartsWith("SL-") AND Status != "DELETED"')}`, 'Invoices');
  const known = new Set(invoices.map(i => i.number));
  const counts = new Map<string, number>();
  for (const x of xeroInvoices) counts.set(x.InvoiceNumber, (counts.get(x.InvoiceNumber) ?? 0) + 1);
  for (const [number, n] of counts) {
    if (!known.has(number)) add({ kind: 'unknown_in_xero', ref: `xero-invoice-${number}`, label: `Xero invoice ${number}`, slValue: null, xeroValue: number, difference: null, suggestion: 'Has a SafeLearners number but no matching SafeLearners record. Check who created it.', link: null });
    if (n > 1) add({ kind: 'duplicate_in_xero', ref: `xero-invoice-${number}`, label: `Invoice ${number} appears ${n} times in Xero`, slValue: 1, xeroValue: n, difference: n - 1, suggestion: 'Void the extra copy in Xero after the accountant confirms which one is correct.', link: null });
  }

  // 4. Credit (prepayments and credit notes): remaining credit on each source.
  const sources = txs.filter(t => t.isCredit && t.xeroId && t.syncStatus === 'synced');
  const [prepayments, creditNotes] = await Promise.all([
    sources.some(s => s.type === 'credit_purchase') ? pages(`${API}/Prepayments`, 'Prepayments') : Promise.resolve([]),
    sources.some(s => s.type !== 'credit_purchase') ? pages(`${API}/CreditNotes?where=${encodeURIComponent('CreditNoteNumber != null AND CreditNoteNumber.StartsWith("SLCN-")')}`, 'CreditNotes') : Promise.resolve([]),
  ]);
  const credit = new Map<string, any>([...prepayments.map(p => [p.PrepaymentID, p] as const), ...creditNotes.map(c => [c.CreditNoteID, c] as const)]);
  const cnCounts = new Map<string, number>();
  for (const c of creditNotes) if (c.Status !== 'VOIDED' && c.Status !== 'DELETED') cnCounts.set(c.CreditNoteNumber, (cnCounts.get(c.CreditNoteNumber) ?? 0) + 1);
  for (const [number, n] of cnCounts) if (n > 1) add({ kind: 'duplicate_in_xero', ref: `xero-cn-${number}`, label: `Credit note ${number} appears ${n} times in Xero`, slValue: 1, xeroValue: n, difference: n - 1, suggestion: 'Void the extra credit note in Xero after checking it with the accountant.', link: null });
  for (const s of sources) {
    const x = credit.get(s.xeroId);
    if (!x) { add({ kind: 'missing_in_xero', ref: `credit-${s.id}`, label: s.description, slValue: s.creditTotal, xeroValue: null, difference: s.creditTotal, suggestion: 'This credit is not in Xero any more. Check whether it was deleted or voided there.', link: null, txId: s.id }); continue; }
    if (unsettledCustomers.has(s.customerId)) continue;
    const xr = Number(x.RemainingCredit ?? 0);
    if (Math.abs(diff(xr, Number(s.creditRemaining))) > CENT) add({ kind: 'allocation_mismatch', ref: `credit-${s.id}`, label: `${s.reference}: unused credit`, slValue: Number(s.creditRemaining), xeroValue: xr, difference: diff(Number(s.creditRemaining), xr), suggestion: 'Unused credit differs. Compare the allocations and refunds of this credit in both systems.', link: null, txId: s.id });
  }

  // 5. Each learner's wallet against the credit SafeLearners has recorded (approved refunds are held).
  const customers = (await CUSTOMERS.get()).docs;
  const held = new Map<string, number>();
  for (const d of (await REFUNDS.where('status', 'in', ['awaiting_transfer', 'attention']).get()).docs) held.set(d.data().customerId, money((held.get(d.data().customerId) ?? 0) + Number(d.data().amount)));
  let skippedCustomers = 0;
  for (const c of customers) {
    if (unsettledCustomers.has(c.id)) { skippedCustomers++; continue; }
    const wallet = Number((await db.doc(`users/${c.id}`).get()).data()?.walletBalance ?? 0);
    const recorded = money(txs.filter(t => t.customerId === c.id && t.isCredit).reduce((a, t) => a + Number(t.creditRemaining ?? 0), 0) - (held.get(c.id) ?? 0));
    if (Math.abs(diff(wallet, recorded)) > CENT) add({ kind: 'wallet_mismatch', ref: `customer-${c.id}`, label: `${c.data().name}: wallet vs recorded credit`, slValue: wallet, xeroValue: recorded, difference: diff(wallet, recorded), suggestion: 'The wallet balance differs from the credit in the finance records (and so in Xero). Check the wallet history for an entry without a finance record.', link: `/admin/users?user=${c.id}` });
    const xeroCredit = money(txs.filter(t => t.customerId === c.id && t.isCredit && t.xeroId).reduce((a, t) => a + Number(credit.get(t.xeroId)?.RemainingCredit ?? 0), 0));
    const slCredit = money(txs.filter(t => t.customerId === c.id && t.isCredit && t.xeroId).reduce((a, t) => a + Number(t.creditRemaining ?? 0), 0));
    if (Math.abs(diff(slCredit, xeroCredit)) > CENT) add({ kind: 'balance_mismatch', ref: `customer-${c.id}`, label: `${c.data().name}: unused credit in Xero`, slValue: slCredit, xeroValue: xeroCredit, difference: diff(slCredit, xeroCredit), suggestion: 'The learner’s unused credit in Xero differs from SafeLearners.', link: null });
  }

  // 6. Duplicate or missing contacts.
  const contacts = await pages(`${API}/Contacts?where=${encodeURIComponent('ContactNumber != null AND ContactNumber.StartsWith("SLC-")')}`, 'Contacts');
  const byNumber = new Map<string, number>();
  for (const x of contacts) if (x.ContactStatus !== 'ARCHIVED') byNumber.set(x.ContactNumber, (byNumber.get(x.ContactNumber) ?? 0) + 1);
  for (const [n, count] of byNumber) if (count > 1) add({ kind: 'duplicate_contact', ref: `contact-${n}`, label: `${count} Xero contacts for customer ${n}`, slValue: 1, xeroValue: count, difference: count - 1, suggestion: 'Merge the duplicate contacts in Xero.', link: null });
  const contactIds = new Set(contacts.map(x => x.ContactID));
  for (const c of customers) {
    const d = c.data();
    if (d.xeroContactId && !contactIds.has(d.xeroContactId) && d.matchStatus !== 'linked_by_admin') add({ kind: 'missing_in_xero', ref: `contact-${c.id}`, label: `Contact for ${d.name}`, slValue: d.customerNumber, xeroValue: null, difference: null, suggestion: 'The linked Xero contact no longer carries the SafeLearners reference (or was archived).', link: null });
  }

  // Save: new issues open, repeat issues keep their first-seen date, issues no longer found are cleared.
  const existing = await ISSUES.where('status', '==', 'open').get();
  const batch = db.batch();
  for (const [id, i] of found) {
    const ref = ISSUES.doc(id);
    const prev = (await ref.get()).data();
    batch.set(ref, { ...i, lastSeen: Timestamp.now(), ...(prev ? {} : { firstDetected: Timestamp.now(), status: 'open' }), ...(prev?.status === 'cleared' ? { status: 'open', firstDetected: Timestamp.now() } : {}) }, { merge: true });
  }
  for (const d of existing.docs) if (!found.has(d.id)) batch.update(d.ref, { status: 'cleared', clearedAt: Timestamp.now() });
  await batch.commit();
  const checked = { ledgerEntries: txs.length, invoices: synced.length, xeroInvoices: xeroInvoices.length, credits: sources.length, customers: customers.length, xeroContacts: contacts.length };
  await RUNS.add({ at: FieldValue.serverTimestamp(), by, issues: found.size, checked, skippedCustomers });
  await STATUS.set({ lastReconciliationAt: FieldValue.serverTimestamp(), openIssues: found.size }, { merge: true });
  await AUDIT.add({ action: 'reconciliation_run', record: 'reconciliationRuns', previousStatus: null, newStatus: `${found.size} issues`, mode: by === 'system' ? 'automatic' : 'manual', by, detail: JSON.stringify(checked), gatewayReference: null, xeroResult: null, error: null, at: FieldValue.serverTimestamp() });
  return { issues: found.size, checked, skippedCustomers };
}

export const financeReconcileNightly = onSchedule({ region: 'australia-southeast1', timeZone: 'Australia/Sydney', schedule: 'every day 02:30', timeoutSeconds: 540 }, async () => {
  const { active } = await accountingSettings();
  if (!active) return;
  try {
    const out = await reconcile();
    if (out.issues) await notifyAdmins({ type: 'reconciliation', title: `Reconciliation: ${out.issues} item${out.issues === 1 ? '' : 's'} to review`, body: 'SafeLearners and Xero differ. See Finance → Reconciliation.', link: '/admin/finance?tab=reconciliation', email: false });
  } catch (err) {
    logger.error('Reconciliation failed', err);
    await notifyAdmins({ type: 'reconciliation', title: 'Reconciliation could not run', body: err instanceof Error ? err.message : String(err), link: '/admin/finance?tab=reconciliation', email: false });
  }
});

export const financeReconcileNow = onCall({ region: 'australia-southeast1', cors: true, timeoutSeconds: 300 }, async req => {
  const uid = requireAdmin(req);
  try {
    return await reconcile(uid);
  } catch (err) {
    logger.error('Reconciliation failed', err);
    fail(`Reconciliation could not finish: ${err instanceof Error ? err.message : String(err)}`);
  }
});

/** Admin marks a discrepancy as resolved, with a note (kept in the audit trail). */
export const resolveReconciliationIssue = onCall({ region: 'australia-southeast1', cors: true }, async req => {
  const uid = requireAdmin(req);
  const id = String(req.data?.id || '');
  const note = String(req.data?.note || '').trim().slice(0, 1000);
  if (note.length < 3) fail('Add a note saying how this was resolved.', 'invalid-argument');
  const ref = ISSUES.doc(id);
  const issue = (await ref.get()).data();
  if (!issue) fail('Issue not found.', 'not-found');
  await ref.update({ status: 'resolved', resolution: note, resolvedBy: uid, resolvedAt: Timestamp.now() });
  await AUDIT.add({ action: 'reconciliation_resolved', record: `reconciliationIssues/${id}`, previousStatus: issue.status, newStatus: 'resolved', mode: 'manual', by: uid, detail: note, gatewayReference: null, xeroResult: null, error: null, at: FieldValue.serverTimestamp() });
  return { ok: true };
});
