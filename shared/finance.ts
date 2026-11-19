// Accounting rules shared by Cloud Functions and the web app: invoice numbers, GST maths, credit
// allocation, statuses and the accounting settings. Nothing here talks to Xero or the database.
import { LESSON_TYPES, type Booking } from './domain';
import { DEFAULT_TIMEZONE, dayKey } from './time';

export const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const CENT = 0.005;

// ---------- Settings ----------

export type SellerModel = 'principal' | 'agent';
export type LineAmountTypes = 'Inclusive' | 'Exclusive' | 'NoTax';

export interface AccountingSettings {
  /** Finance records and Xero sync run only once an admin switches this on with complete settings. */
  enabled: boolean;
  /** Activity before this date (YYYY-MM-DD) is never recorded or sent. */
  startDate: string | null;
  sellerModel: SellerModel | null;
  lineAmountTypes: LineAmountTypes | null;
  /** Principal: the lesson line. */
  lessonAccount: string | null;
  lessonTaxType: string | null;
  /** Agent: the platform's fee line, and the instructor's share held as a liability. */
  platformFeeRate: number;
  feeAccount: string | null;
  feeTaxType: string | null;
  instructorPayableAccount: string | null;
  instructorTaxTypeRegistered: string | null;
  instructorTaxTypeUnregistered: string | null;
  cancellationFeeAccount: string | null;
  cancellationFeeTaxType: string | null;
  /** Credit bought with real money is held here until it pays for a lesson. */
  prepaymentAccount: string | null;
  /** Bank account (Xero code) manual top-ups are received into, and refunds paid from. */
  topupBankAccount: string | null;
  refundBankAccount: string | null;
  promotionsAccount: string | null;
  goodwillAccount: string | null;
  adjustmentsAccount: string | null;
  openingCreditAccount: string | null;
  /** Tax type for credit lines that are not a sale (prepayments, promotional credit). */
  creditTaxType: string | null;
  /** Effective rate per Xero tax type (e.g. { OUTPUT: 10 }), from the organisation's tax rates. */
  taxRates: Record<string, number>;
  business: { name: string; abn: string; address: string; email: string };
  /** Admin ticks once the client's accountant has confirmed the treatment above. */
  accountantConfirmed: boolean;
}

export const DEFAULT_ACCOUNTING_SETTINGS: AccountingSettings = {
  enabled: false,
  startDate: null,
  sellerModel: null,
  lineAmountTypes: null,
  lessonAccount: null,
  lessonTaxType: null,
  platformFeeRate: 0.15,
  feeAccount: null,
  feeTaxType: null,
  instructorPayableAccount: null,
  instructorTaxTypeRegistered: null,
  instructorTaxTypeUnregistered: null,
  cancellationFeeAccount: null,
  cancellationFeeTaxType: null,
  prepaymentAccount: null,
  topupBankAccount: null,
  refundBankAccount: null,
  promotionsAccount: null,
  goodwillAccount: null,
  adjustmentsAccount: null,
  openingCreditAccount: null,
  creditTaxType: null,
  taxRates: {},
  business: { name: '', abn: '', address: '', email: '' },
  accountantConfirmed: false,
};

export function settingsFrom(raw: Record<string, any> | undefined | null): AccountingSettings {
  const s = { ...DEFAULT_ACCOUNTING_SETTINGS, ...(raw ?? {}) } as AccountingSettings;
  s.business = { ...DEFAULT_ACCOUNTING_SETTINGS.business, ...(raw?.business ?? {}) };
  s.taxRates = { ...(raw?.taxRates ?? {}) };
  return s;
}

/** Labels of settings still needed before finance records can be switched on. */
export function missingSettings(s: AccountingSettings): string[] {
  const need: [unknown, string][] = [
    [s.startDate, 'Start date'],
    [s.sellerModel, 'Seller model (principal or agent)'],
    [s.lineAmountTypes, 'Prices include GST / exclude GST / no tax'],
    [s.cancellationFeeAccount, 'Cancellation fee account'],
    [s.prepaymentAccount, 'Customer prepayment account'],
    [s.topupBankAccount, 'Manual top-up bank account'],
    [s.refundBankAccount, 'Refund bank account'],
    [s.promotionsAccount, 'Promotional / referral credit account'],
    [s.goodwillAccount, 'Goodwill credit account'],
    [s.adjustmentsAccount, 'Administrative correction account'],
    [s.openingCreditAccount, 'Opening credit account'],
    [s.business.name, 'Business name (shown on invoices)'],
  ];
  if (s.lineAmountTypes !== 'NoTax') {
    need.push([s.creditTaxType, 'Tax type for credit lines'], [s.cancellationFeeTaxType, 'Cancellation fee tax type']);
  }
  if (s.sellerModel === 'principal') {
    need.push([s.lessonAccount, 'Lesson revenue account']);
    if (s.lineAmountTypes !== 'NoTax') need.push([s.lessonTaxType, 'Lesson tax type']);
  }
  if (s.sellerModel === 'agent') {
    need.push([s.feeAccount, 'Platform fee revenue account'], [s.instructorPayableAccount, 'Amount owed to instructors account']);
    if (s.lineAmountTypes !== 'NoTax') {
      need.push([s.feeTaxType, 'Platform fee tax type'], [s.instructorTaxTypeRegistered, 'Tax type: GST-registered instructors'], [s.instructorTaxTypeUnregistered, 'Tax type: instructors not registered']);
    }
    if (!(s.platformFeeRate > 0 && s.platformFeeRate < 1)) need.push([null, 'Platform fee rate']);
  }
  return need.filter(([v]) => v === null || v === undefined || v === '').map(([, l]) => l);
}

// ---------- Lines and tax ----------

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitAmount: number;
  discount: number;
  accountCode: string;
  taxType: string | null;
  /** Calculated with the invoice's tax mode. */
  lineAmount: number;
  tax: number;
}

/** Tax on one line, rounded per line as Xero does. Amounts are the line's price after discount. */
export function lineTax(amount: number, mode: LineAmountTypes, ratePercent: number): number {
  if (mode === 'NoTax' || !ratePercent) return 0;
  const r = ratePercent / 100;
  return money(mode === 'Inclusive' ? (amount * r) / (1 + r) : amount * r);
}

export function line(description: string, amount: number, accountCode: string, taxType: string | null, s: AccountingSettings, discount = 0): InvoiceLine {
  const lineAmount = money(amount - discount);
  const rate = taxType ? s.taxRates[taxType] ?? 0 : 0;
  return { description, quantity: 1, unitAmount: money(amount), discount: money(discount), accountCode, taxType, lineAmount, tax: lineTax(lineAmount, s.lineAmountTypes ?? 'NoTax', rate) };
}

export function totals(lines: InvoiceLine[], mode: LineAmountTypes) {
  const amount = money(lines.reduce((t, l) => t + l.lineAmount, 0));
  const tax = money(lines.reduce((t, l) => t + l.tax, 0));
  const discount = money(lines.reduce((t, l) => t + l.discount, 0));
  const total = mode === 'Exclusive' ? money(amount + tax) : amount;
  return { subtotal: money(total - tax), tax, discount, total };
}

/** Invoice lines for a lesson, from the accounting settings. The lesson price is never recalculated. */
export function lessonLines(
  booking: Pick<Booking, 'price' | 'lessonType' | 'instructorName' | 'startAt' | 'timezone'>,
  s: AccountingSettings,
  instructorGstRegistered: boolean,
  /** The lesson's commission as a fraction (from commission management); falls back to the settings rate. */
  feeRate?: number,
): InvoiceLine[] {
  const price = money(booking.price ?? 0);
  const label = booking.lessonType ? LESSON_TYPES[booking.lessonType]?.label ?? 'Driving lesson' : 'Driving lesson';
  const when = dayKey(booking.startAt, booking.timezone ?? DEFAULT_TIMEZONE).split('-').reverse().join('/');
  const desc = `${label} with ${booking.instructorName ?? 'your instructor'} on ${when}`;
  if (s.sellerModel === 'agent') {
    const fee = money(price * (feeRate ?? s.platformFeeRate));
    return [
      line(`${desc}: lesson (collected for the instructor)`, money(price - fee), s.instructorPayableAccount!, instructorGstRegistered ? s.instructorTaxTypeRegistered : s.instructorTaxTypeUnregistered, s),
      line(`${desc}: Safe Learners booking fee`, fee, s.feeAccount!, s.feeTaxType, s),
    ];
  }
  return [line(desc, price, s.lessonAccount!, s.lessonTaxType, s)];
}

// ---------- Numbers and references ----------

/** Booking references restart each year (DDMM-nn), so invoice numbers carry the lesson's year. */
export function invoiceNumberFor(booking: Pick<Booking, 'id' | 'ref' | 'startAt' | 'timezone'>): string {
  const year = dayKey(booking.startAt, booking.timezone ?? DEFAULT_TIMEZONE).slice(0, 4);
  return booking.ref ? `SL-${year}-${booking.ref}` : `SL-${booking.id.slice(0, 10).toUpperCase()}`;
}

export const feeInvoiceNumber = (lessonInvoiceNumber: string) => `${lessonInvoiceNumber}-F`;
export const creditNoteNumber = (lessonInvoiceNumber: string, n = 1) => `CN-${lessonInvoiceNumber.replace(/^SL-/, '')}${n > 1 ? `-${n}` : ''}`;
export const shortRef = (id: string) => id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase();
/** A Xero reference from a whole record ID (prefixes like alloc__ removed), so references never collide. */
export const refId = (id: string) => id.replace(/^(alloc|credit|invoice|fee|adj)__/g, '').replace(/[^A-Za-z0-9]/g, '');
/** Customer reference saved on the Xero contact (ContactNumber), used to match it again. */
export const customerNumber = (uid: string) => `SLC-${uid}`;

// ---------- Credit allocation ----------

export interface CreditSourceLite { id: string; remaining: number; date: number }
export interface AllocationPiece { sourceId: string; amount: number }

/** Uses credit oldest first. Any amount the sources can't cover is returned as the shortfall. */
export function planAllocation(sources: CreditSourceLite[], amount: number): { pieces: AllocationPiece[]; shortfall: number } {
  let left = money(amount);
  const pieces: AllocationPiece[] = [];
  for (const s of [...sources].sort((a, b) => a.date - b.date || a.id.localeCompare(b.id))) {
    if (left <= CENT) break;
    const take = money(Math.min(s.remaining, left));
    if (take <= CENT) continue;
    pieces.push({ sourceId: s.id, amount: take });
    left = money(left - take);
  }
  return { pieces, shortfall: left > CENT ? left : 0 };
}

// ---------- Statuses ----------

export type InvoiceStatus = 'draft' | 'authorised' | 'awaiting_payment' | 'partially_paid' | 'paid' | 'voided' | 'credited';

export const INVOICE_STATUS: Record<InvoiceStatus, { label: string; tone: 'slate' | 'green' | 'amber' | 'red' | 'blue' }> = {
  draft: { label: 'Draft', tone: 'slate' },
  authorised: { label: 'Authorised', tone: 'blue' },
  awaiting_payment: { label: 'Awaiting payment', tone: 'amber' },
  partially_paid: { label: 'Partially paid', tone: 'amber' },
  paid: { label: 'Paid', tone: 'green' },
  voided: { label: 'Voided', tone: 'slate' },
  credited: { label: 'Credited', tone: 'slate' },
};

/**
 * Authorised = issued and not due yet; Awaiting payment = due (or overdue) with nothing paid;
 * Credited = cancelled after payment (a credit note covers the rest).
 */
export function invoiceStatusOf(
  inv: { voided?: boolean; closed?: string | null; total: number; amountPaid: number; amountCredited: number; dueDate: string },
  today: string,
): InvoiceStatus {
  if (inv.voided) return 'voided';
  // Cancelled after payment: a credit note closed it, even when nothing was left to settle (fully paid).
  if (inv.closed === 'credited' || inv.closed === 'fee_kept') return 'credited';
  const due = money(inv.total - inv.amountPaid - inv.amountCredited);
  if (inv.amountCredited > CENT && due <= CENT) return 'credited';
  if (due <= CENT) return 'paid';
  if (inv.amountPaid > CENT) return 'partially_paid';
  return inv.dueDate <= today ? 'awaiting_payment' : 'authorised';
}

export type SyncStatus = 'waiting' | 'pending' | 'processing' | 'synced' | 'failed' | 'attention' | 'not_required';

export const SYNC_STATUS: Record<SyncStatus, { label: string; tone: 'slate' | 'green' | 'amber' | 'red' | 'blue' }> = {
  waiting: { label: 'Waiting for earlier step', tone: 'slate' },
  pending: { label: 'Pending', tone: 'blue' },
  processing: { label: 'Processing', tone: 'blue' },
  synced: { label: 'Successfully synced', tone: 'green' },
  failed: { label: 'Failed', tone: 'red' },
  attention: { label: 'Requires attention', tone: 'amber' },
  not_required: { label: 'Not sent to Xero', tone: 'slate' },
};

export type FinanceTxType =
  | 'customer'
  | 'credit_purchase'
  | 'promo_credit'
  | 'goodwill_credit'
  | 'correction_credit'
  | 'opening_credit'
  | 'invoice'
  | 'allocation'
  | 'invoice_void'
  | 'credit_note'
  | 'debit_adjustment'
  | 'refund';

export const FINANCE_TX: Record<FinanceTxType, { label: string; xero: string }> = {
  customer: { label: 'Customer', xero: 'Contact' },
  credit_purchase: { label: 'Credit purchase (money received)', xero: 'Receive prepayment' },
  promo_credit: { label: 'Referral / promotional credit', xero: 'Credit note' },
  goodwill_credit: { label: 'Goodwill credit', xero: 'Credit note' },
  correction_credit: { label: 'Administrative correction (credit)', xero: 'Credit note' },
  opening_credit: { label: 'Credit from before the start date', xero: 'Credit note' },
  invoice: { label: 'Invoice', xero: 'Invoice' },
  allocation: { label: 'Credit applied to invoice', xero: 'Allocation' },
  invoice_void: { label: 'Invoice voided', xero: 'Void invoice' },
  credit_note: { label: 'Credit note', xero: 'Credit note' },
  debit_adjustment: { label: 'Administrative correction (debit)', xero: 'Invoice + allocation' },
  refund: { label: 'Refund paid', xero: 'Refund payment' },
};

/** Wallet credit categories an admin chooses when adding credit. Only payment_received is cash. */
export type CreditCategory = 'payment_received' | 'goodwill' | 'correction';
export const CREDIT_CATEGORIES: Record<CreditCategory, { label: string; cash: boolean; tx: FinanceTxType }> = {
  payment_received: { label: 'Payment received (money is in the bank)', cash: true, tx: 'credit_purchase' },
  goodwill: { label: 'Goodwill credit (no payment)', cash: false, tx: 'goodwill_credit' },
  correction: { label: 'Administrative correction', cash: false, tx: 'correction_credit' },
};
export const PAYMENT_METHODS = { bank_transfer: 'Bank transfer', cash: 'Cash', card_terminal: 'Card (in person)', other: 'Other' } as const;
export type PaymentMethod = keyof typeof PAYMENT_METHODS;

// ---------- Refunds ----------

export type RefundStatus = 'awaiting_approval' | 'approved' | 'rejected' | 'awaiting_transfer' | 'processing' | 'completed' | 'attention' | 'cancelled';

export const REFUND_STATUS: Record<RefundStatus, { label: string; tone: 'slate' | 'green' | 'amber' | 'red' | 'blue' }> = {
  awaiting_approval: { label: 'Awaiting approval', tone: 'amber' },
  approved: { label: 'Approved', tone: 'blue' },
  rejected: { label: 'Rejected', tone: 'red' },
  awaiting_transfer: { label: 'Awaiting manual transfer', tone: 'blue' },
  processing: { label: 'Processing', tone: 'blue' },
  completed: { label: 'Completed', tone: 'green' },
  attention: { label: 'Requires attention', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: 'slate' },
};

/** Refundable now: wallet credit not already asked for in a request awaiting approval. */
export function refundableAmount(walletBalance: number, awaitingRequests: number[]): number {
  return Math.max(0, money(walletBalance - awaitingRequests.reduce((t, a) => t + a, 0)));
}
