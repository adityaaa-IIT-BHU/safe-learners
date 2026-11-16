// Sends finance ledger entries to Xero (queue job type "fin"). Every write is idempotent: a stored Xero ID
// turns a repeat into a no-op or an update, a search by our own reference finds a record created by an
// earlier attempt, and each create carries an Idempotency-Key. Dependencies (contact before invoice,
// invoice and credit before an allocation) are synced first, in the same run.
import { CENT, money, settingsFrom, type AccountingSettings } from '../../shared/finance';
import { FieldValue, Timestamp, db } from './core';
import { AUDIT, CUSTOMERS, INVOICES, SETTINGS, TX, accountingSettings } from './finance';
import { XeroError, keyFor, onJobFailure, registerHandler, xeroFetch } from './xero';

const API = '/api.xro/2.0';
const where = (expr: string) => `where=${encodeURIComponent(expr)}`;
const quoteSafe = (v: string) => v.replace(/["\\]/g, '');
const norm = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const accountRef = (v: string) => (isUuid(v) ? { AccountID: v } : { Code: v });
const creditMode = (s: AccountingSettings) => (s.lineAmountTypes === 'Exclusive' ? 'Inclusive' : s.lineAmountTypes);

/** A problem a retry can't fix (needs an admin): the entry is marked "Requires attention". */
export class AttentionError extends XeroError {
  constructor(message: string) {
    super(message, { retryable: false, rateLimited: false, message });
  }
}

type Tx = Record<string, any> & { id: string };

/**
 * Idempotency-Key from the entry AND the request content. Xero replays the stored response (even an error)
 * for a repeated key for 6 minutes, so a corrected request must carry a new key; an identical retry keeps
 * the same key and can never create a second record.
 */
const bodyKey = (id: string, step: string, body: unknown) => keyFor(id, `${step}:${JSON.stringify(body)}`);

async function load(id: string): Promise<Tx> {
  const snap = await TX.doc(id).get();
  if (!snap.exists) throw new AttentionError(`Ledger entry ${id} is missing.`);
  return { id, ...snap.data()! };
}

function xeroLine(l: { description: string; quantity: number; unitAmount: number; discount: number; accountCode: string; taxType: string | null }) {
  return {
    Description: l.description.slice(0, 4000),
    Quantity: l.quantity,
    UnitAmount: l.unitAmount,
    AccountCode: l.accountCode,
    ...(l.taxType ? { TaxType: l.taxType } : {}),
    ...(l.discount > CENT ? { DiscountAmount: l.discount } : {}),
  };
}

// ---------- Contacts ----------

async function syncContact(t: Tx): Promise<string> {
  const uid = t.customerId as string;
  const cRef = CUSTOMERS.doc(uid);
  const c = (await cRef.get()).data();
  if (!c) throw new AttentionError('Customer record is missing.');
  const body: Record<string, unknown> = {
    Name: c.name,
    FirstName: c.firstName || undefined,
    LastName: c.surname || undefined,
    EmailAddress: c.email || undefined,
    ContactNumber: c.customerNumber,
    ...(c.mobile ? { Phones: [{ PhoneType: 'MOBILE', PhoneNumber: String(c.mobile) }] } : {}),
  };
  let id: string | undefined = c.xeroContactId;
  // 2. The SafeLearners customer reference saved on the contact.
  if (!id) {
    const r = await xeroFetch(`${API}/Contacts?${where(`ContactNumber=="${quoteSafe(c.customerNumber)}"`)}`);
    const found = (r.json?.Contacts ?? []) as any[];
    if (found.length > 1) throw new AttentionError(`${found.length} Xero contacts carry the reference ${c.customerNumber}. Merge them in Xero, then retry.`);
    id = found[0]?.ContactID;
  }
  // 3. Exact email AND name. An email match with a different name is never linked automatically.
  if (!id && c.email && c.matchStatus !== 'create_confirmed') {
    const r = await xeroFetch(`${API}/Contacts?${where(`EmailAddress=="${quoteSafe(c.email)}"`)}`);
    const list = (r.json?.Contacts ?? []) as any[];
    const exact = list.find(x => norm(x.Name) === norm(c.name) || (norm(x.FirstName) === norm(c.firstName) && norm(x.LastName) === norm(c.surname) && c.firstName));
    if (exact) id = exact.ContactID;
    else if (list.length) {
      await cRef.update({ matchStatus: 'review', candidateContactId: list[0].ContactID, candidateName: list[0].Name ?? '' });
      throw new AttentionError(`Xero contact “${list[0].Name}” has the same email but a different name. Review it under Finance → Customers.`);
    }
  }
  let matchStatus = c.matchStatus === 'linked_by_admin' ? 'linked_by_admin' : id ? 'matched' : 'created';
  // Xero contact names must be unique across active contacts: when another contact already has this
  // name (e.g. two learners called the same), the SafeLearners reference is added to the name.
  const uniqueName = async (send: (b: Record<string, unknown>, unique: boolean) => Promise<string | undefined>) => {
    try {
      return await send(body, false);
    } catch (err) {
      if (!(err instanceof XeroError) || !/already assigned to another contact|must be unique/i.test(err.message)) throw err;
      return send({ ...body, Name: `${c.name} (${c.customerNumber.slice(-6)})` }, true);
    }
  };
  if (id) {
    const existing = id;
    await uniqueName(async b => { await xeroFetch(`${API}/Contacts/${existing}`, { method: 'POST', body: { Contacts: [{ ContactID: existing, ...b }] } }); return existing; });
  } else {
    id = await uniqueName(async (b, unique) => (await xeroFetch(`${API}/Contacts`, { method: 'PUT', body: { Contacts: [b] }, idempotency: bodyKey(t.id, unique ? 'create-unique' : 'create', b) })).json?.Contacts?.[0]?.ContactID);
    matchStatus = 'created';
  }
  if (!id) throw new XeroError('Xero did not return a contact ID.');
  await cRef.update({ xeroContactId: id, matchStatus, syncedAt: FieldValue.serverTimestamp() });
  return id;
}

async function contactFor(uid: string): Promise<string> {
  const c = (await CUSTOMERS.doc(uid).get()).data();
  if (c?.xeroContactId && c.matchStatus !== 'review') {
    const t = (await TX.doc(`customer__${uid}`).get()).data();
    if (t?.syncStatus === 'synced') return c.xeroContactId;
  }
  return sync(`customer__${uid}`);
}

// ---------- Invoices ----------

async function syncInvoice(t: Tx): Promise<string> {
  const invRef = INVOICES.doc(t.invoiceId);
  const inv = (await invRef.get()).data();
  if (!inv) throw new AttentionError(`Invoice ${t.invoiceId} is missing.`);
  const contactId = await contactFor(inv.learnerId);
  let id: string | undefined = inv.xero?.invoiceId;
  if (!id) {
    const r = await xeroFetch(`${API}/Invoices?InvoiceNumbers=${encodeURIComponent(inv.number)}`);
    const found = ((r.json?.Invoices ?? []) as any[]).filter(i => i.Status !== 'DELETED');
    if (found.length > 1) throw new AttentionError(`Xero already has ${found.length} invoices numbered ${inv.number}.`);
    // Only ever adopt our own earlier attempt: same number AND same customer.
    if (found[0] && found[0].Contact?.ContactID !== contactId) throw new AttentionError(`Invoice number ${inv.number} is already used in Xero by another contact (${found[0].Contact?.Name ?? 'unknown'}). Check it with the accountant before syncing.`);
    id = found[0]?.InvoiceID;
  }
  const body = {
    Type: 'ACCREC',
    Contact: { ContactID: contactId },
    InvoiceNumber: inv.number,
    Reference: inv.bookingRef ? `Booking ${inv.bookingRef}` : inv.description.slice(0, 255),
    Date: inv.issueDate,
    DueDate: inv.dueDate,
    LineAmountTypes: inv.lineAmountTypes,
    Status: 'AUTHORISED',
    LineItems: inv.lines.map(xeroLine),
  };
  let out: any;
  if (id) {
    // Already in Xero: adopt it as it is when the amount matches; update it only while nothing has been
    // paid or credited on it (Xero won't let a paid invoice's lines change).
    out = (await xeroFetch(`${API}/Invoices/${id}`)).json?.Invoices?.[0];
    const same = out && Math.abs(Number(out.Total) - inv.total) <= CENT && out.DueDateString?.slice(0, 10) === inv.dueDate;
    if (!same && out) {
      if (Number(out.AmountPaid ?? 0) + Number(out.AmountCredited ?? 0) > CENT) {
        throw new AttentionError(`${inv.number} changed in SafeLearners (now ${Number(inv.total).toFixed(2)}, due ${inv.dueDate}) but already has payments or credit in Xero (${Number(out.Total).toFixed(2)}). Adjust it in Xero with the accountant, then retry.`);
      }
      out = (await xeroFetch(`${API}/Invoices/${id}`, { method: 'POST', body: { Invoices: [{ InvoiceID: id, ...body }] } })).json?.Invoices?.[0];
    }
  } else {
    out = (await xeroFetch(`${API}/Invoices`, { method: 'PUT', body: { Invoices: [body] }, idempotency: bodyKey(t.id, 'create', body) })).json?.Invoices?.[0];
  }
  id = out?.InvoiceID ?? id;
  if (!id) throw new XeroError('Xero did not return an invoice ID.');
  if (out && Math.abs(Number(out.Total) - inv.total) > CENT) {
    await invRef.update({ xero: { invoiceId: id, status: out.Status ?? null, total: Number(out.Total) } });
    throw new AttentionError(`Xero calculated ${Number(out.Total).toFixed(2)} for ${inv.number}, SafeLearners ${Number(inv.total).toFixed(2)}. Check the tax settings.`);
  }
  await invRef.update({ xero: { invoiceId: id, status: out?.Status ?? 'AUTHORISED', total: Number(out?.Total ?? inv.total), syncedAt: Timestamp.now() } });
  return id;
}

async function voidInvoice(t: Tx): Promise<string> {
  const id = await sync(`invoice__${t.invoiceId}`);
  const r = await xeroFetch(`${API}/Invoices/${id}`);
  const status = r.json?.Invoices?.[0]?.Status;
  if (status !== 'VOIDED') await xeroFetch(`${API}/Invoices/${id}`, { method: 'POST', body: { Invoices: [{ InvoiceID: id, Status: 'VOIDED' }] } });
  await INVOICES.doc(t.invoiceId).update({ 'xero.status': 'VOIDED' });
  return id;
}

// ---------- Credit (prepayments and credit notes) ----------

async function syncPrepayment(t: Tx, s: AccountingSettings): Promise<string> {
  if (t.xeroId) return t.xeroId;
  const contactId = await contactFor(t.customerId);
  const found = await xeroFetch(`${API}/BankTransactions?${where(`Type=="RECEIVE-PREPAYMENT" AND Reference=="${quoteSafe(t.reference)}"`)}`);
  const existing = ((found.json?.BankTransactions ?? []) as any[]).find(b => b.Status !== 'DELETED');
  if (existing?.PrepaymentID) {
    if (existing.Contact?.ContactID !== contactId || Math.abs(Number(existing.Total) - Number(t.amount)) > CENT) throw new AttentionError(`Prepayment reference ${t.reference} already exists in Xero for another contact or amount.`);
    return existing.PrepaymentID;
  }
  const desc = [t.description, t.paymentReference ? `payment ref ${t.paymentReference}` : ''].filter(Boolean).join(' · ');
  const prepayBody = {
      BankTransactions: [{
        Type: 'RECEIVE-PREPAYMENT',
        Contact: { ContactID: contactId },
        BankAccount: accountRef(s.topupBankAccount!),
        Date: t.date,
        Reference: t.reference,
        LineAmountTypes: creditMode(s),
        LineItems: [{ Description: desc.slice(0, 4000), Quantity: 1, UnitAmount: t.amount, AccountCode: s.prepaymentAccount, ...(s.creditTaxType ? { TaxType: s.creditTaxType } : {}) }],
      }],
  };
  const r = await xeroFetch(`${API}/BankTransactions`, { method: 'PUT', idempotency: bodyKey(t.id, 'create', prepayBody), body: prepayBody });
  const id = r.json?.BankTransactions?.[0]?.PrepaymentID;
  if (!id) throw new XeroError('Xero did not return a prepayment ID.');
  return id;
}

const CREDIT_ACCOUNT: Record<string, keyof AccountingSettings> = {
  promo_credit: 'promotionsAccount',
  goodwill_credit: 'goodwillAccount',
  correction_credit: 'adjustmentsAccount',
  opening_credit: 'openingCreditAccount',
};

async function syncCreditNote(t: Tx, s: AccountingSettings): Promise<string> {
  const ref = TX.doc(t.id);
  let id: string | undefined = t.xeroId ?? undefined;
  if (!id) {
    const contactId = await contactFor(t.customerId);
    const found = await xeroFetch(`${API}/CreditNotes?${where(`CreditNoteNumber=="${quoteSafe(t.reference)}"`)}`);
    const prior = ((found.json?.CreditNotes ?? []) as any[]).find(c => c.Status !== 'DELETED' && c.Status !== 'VOIDED');
    if (prior && prior.Contact?.ContactID !== contactId) throw new AttentionError(`Credit note number ${t.reference} is already used in Xero by another contact (${prior.Contact?.Name ?? 'unknown'}).`);
    id = prior?.CreditNoteID;
    if (!id) {
      const lines = t.type === 'credit_note'
        ? (t.lines as any[]).map(xeroLine)
        : [{ Description: t.description.slice(0, 4000), Quantity: 1, UnitAmount: t.amount, AccountCode: s[CREDIT_ACCOUNT[t.type]] as string, ...(s.creditTaxType ? { TaxType: s.creditTaxType } : {}) }];
      const cnBody = {
          CreditNotes: [{
            Type: 'ACCRECCREDIT',
            Contact: { ContactID: contactId },
            CreditNoteNumber: t.reference,
            Reference: (t.invoiceNumber ? `For ${t.invoiceNumber}` : t.description).slice(0, 255),
            Date: t.date,
            LineAmountTypes: t.type === 'credit_note' ? t.lineAmountTypes : creditMode(s),
            Status: 'AUTHORISED',
            LineItems: lines,
          }],
      };
      const r = await xeroFetch(`${API}/CreditNotes`, { method: 'PUT', idempotency: bodyKey(t.id, 'create', cnBody), body: cnBody });
      id = r.json?.CreditNotes?.[0]?.CreditNoteID;
      if (!id) throw new XeroError('Xero did not return a credit note ID.');
    }
    await ref.update({ xeroId: id });
  }
  // A cancellation credit note first settles what was still owing on its invoice.
  if (t.type === 'credit_note' && Number(t.allocateToInvoice) > CENT && !t.invoiceAllocationDone) {
    const invoiceId = await sync(`invoice__${t.invoiceId}`);
    await xeroFetch(`${API}/CreditNotes/${id}/Allocations`, {
      method: 'PUT',
      idempotency: bodyKey(t.id, 'allocate-invoice', { invoiceId, a: t.allocateToInvoice, d: t.date }),
      body: { Allocations: [{ Invoice: { InvoiceID: invoiceId }, Amount: money(Number(t.allocateToInvoice)), Date: t.date }] },
    });
    await ref.update({ invoiceAllocationDone: true });
  }
  return id;
}

// ---------- Allocations and refunds ----------

async function syncPieces(t: Tx, perPiece: (piece: { sourceId: string; amount: number }, sourceXeroId: string, sourceType: string, i: number) => Promise<void>) {
  const pieces = [...(t.pieces as { sourceId: string; amount: number; done: boolean }[])];
  for (let i = 0; i < pieces.length; i++) {
    if (pieces[i].done) continue;
    const src = await load(pieces[i].sourceId);
    const srcId = await sync(src.id);
    await perPiece(pieces[i], srcId, src.type, i);
    pieces[i] = { ...pieces[i], done: true };
    await TX.doc(t.id).update({ pieces });
  }
}

async function syncAllocation(t: Tx): Promise<string> {
  const invoiceId = await sync(`invoice__${t.invoiceId}`);
  await syncPieces(t, async (p, srcId, srcType, i) => {
    const path = srcType === 'credit_purchase' ? `Prepayments/${srcId}` : `CreditNotes/${srcId}`;
    await xeroFetch(`${API}/${path}/Allocations`, {
      method: 'PUT',
      idempotency: bodyKey(t.id, `piece-${i}`, { invoiceId, srcId, a: p.amount, d: t.date }),
      body: { Allocations: [{ Invoice: { InvoiceID: invoiceId }, Amount: p.amount, Date: t.date }] },
    });
  });
  return invoiceId;
}

async function syncRefund(t: Tx, s: AccountingSettings): Promise<string> {
  const ids: string[] = [];
  await syncPieces(t, async (p, srcId, srcType, i) => {
    const r = await xeroFetch(`${API}/Payments`, {
      method: 'PUT',
      idempotency: bodyKey(t.id, `refund-${i}`, { srcId, a: p.amount, d: t.transferDate ?? t.date, acc: s.refundBankAccount }),
      body: {
        Payments: [{
          ...(srcType === 'credit_purchase' ? { Prepayment: { PrepaymentID: srcId } } : { CreditNote: { CreditNoteID: srcId } }),
          Account: accountRef(s.refundBankAccount!),
          Amount: p.amount,
          Date: t.transferDate ?? t.date,
          Reference: `Refund ${t.reference ?? ''}`.trim().slice(0, 255),
        }],
      },
    });
    const pid = r.json?.Payments?.[0]?.PaymentID;
    if (pid) ids.push(pid);
  });
  return ids.join(',') || (t.xeroId ?? 'refunded');
}

// ---------- Dispatcher ----------

/** Syncs one ledger entry (and anything it depends on). Returns its Xero ID. */
export async function sync(id: string): Promise<string> {
  const t = await load(id);
  if (t.syncStatus === 'synced' && t.xeroId) return t.xeroId;
  if (t.syncStatus === 'attention' && t.lastError) throw new AttentionError(t.lastError);
  const { s, active, missing } = await accountingSettings();
  if (!active) throw new AttentionError(missing.length ? `Accounting settings incomplete: ${missing.join(', ')}` : 'Finance sync is switched off.');
  const ref = TX.doc(id);
  await ref.update({ syncStatus: 'processing', lastAttemptAt: Timestamp.now() });
  try {
    let xeroId: string;
    let xeroType: string;
    switch (t.type) {
      case 'customer': xeroId = await syncContact(t); xeroType = 'Contact'; break;
      case 'invoice':
      case 'debit_adjustment': xeroId = await syncInvoice(t); xeroType = 'Invoice'; break;
      case 'invoice_void': xeroId = await voidInvoice(t); xeroType = 'Invoice (voided)'; break;
      case 'credit_purchase': xeroId = await syncPrepayment(t, s); xeroType = 'Prepayment'; break;
      case 'promo_credit':
      case 'goodwill_credit':
      case 'correction_credit':
      case 'opening_credit':
      case 'credit_note': xeroId = await syncCreditNote(t, s); xeroType = 'Credit note'; break;
      case 'allocation': xeroId = await syncAllocation(t); xeroType = 'Allocation'; break;
      case 'refund': xeroId = await syncRefund(t, s); xeroType = 'Refund payment'; break;
      default: throw new AttentionError(`Unknown ledger entry type ${t.type}.`);
    }
    await ref.update({ syncStatus: 'synced', xeroId, xeroType, lastError: null, syncedAt: Timestamp.now(), attempts: FieldValue.increment(1) });
    await AUDIT.add({ action: 'xero_synced', record: `financeTransactions/${id}`, previousStatus: t.syncStatus, newStatus: 'synced', mode: 'automatic', by: 'system', xeroResult: `${xeroType} ${xeroId}`, detail: t.description ?? null, gatewayReference: null, error: null, at: FieldValue.serverTimestamp() });
    return xeroId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ref.update({ syncStatus: err instanceof AttentionError ? 'attention' : 'pending', lastError: message, lastAttemptAt: Timestamp.now(), attempts: FieldValue.increment(1) });
    throw err;
  }
}

registerHandler('fin', async job => ({ xeroId: await sync(job.recordId), summary: `Synced ${job.recordId}` }));

onJobFailure(async (job, message, willRetry, err) => {
  if (job.type !== 'fin') return;
  const ref = TX.doc(job.recordId);
  const status = err instanceof AttentionError ? 'attention' : willRetry ? 'pending' : 'failed';
  await ref.update({ syncStatus: status, lastError: message }).catch(() => undefined);
  if (!willRetry) {
    await AUDIT.add({ action: 'xero_sync_failed', record: `financeTransactions/${job.recordId}`, previousStatus: 'processing', newStatus: status, mode: 'automatic', by: 'system', xeroResult: null, detail: null, gatewayReference: null, error: message, at: FieldValue.serverTimestamp() });
  }
});

/** Settings document helper for the reconciliation module. */
export async function settings(): Promise<AccountingSettings> {
  return settingsFrom((await SETTINGS.get()).data());
}
export { db };
