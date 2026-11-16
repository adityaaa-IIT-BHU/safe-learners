import { collection, doc, limit, orderBy, query, where, type DocumentData } from 'firebase/firestore';
import { INVOICE_STATUS, invoiceStatusOf, settingsFrom, type AccountingSettings, type InvoiceLine, type InvoiceStatus } from '@shared/finance';
import { dayKey } from '@shared/time';
import { toDate, useDoc, useQuery } from './data';
import { db } from './firebase';

export interface InvoiceView {
  id: string;
  number: string;
  kind: 'lesson' | 'cancellation_fee' | 'adjustment';
  learnerId: string;
  learnerName: string;
  learnerEmail: string | null;
  customerNumber: string;
  bookingId: string | null;
  bookingRef: string | null;
  instructorName: string | null;
  lessonDate: string | null;
  durationMinutes: number | null;
  description: string;
  lines: InvoiceLine[];
  lineAmountTypes: 'Inclusive' | 'Exclusive' | 'NoTax';
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
  amountPaid: number;
  amountCredited: number;
  amountDue: number;
  status: InvoiceStatus;
  issueDate: string;
  dueDate: string;
  voided: boolean;
  closed: string | null;
  allocations: { txId: string; amount: number; date: string; from: string }[];
  creditNotes: { txId: string; number: string; amount: number }[];
  relatedInvoiceId: string | null;
  history: { at: string; action: string }[];
  xero: { invoiceId?: string; status?: string } | null;
  seller?: AccountingSettings['business'];
  createdAt?: Date;
}

export const mapInvoice = (id: string, d: DocumentData): InvoiceView => {
  const inv = { id, ...d, createdAt: toDate(d.createdAt), xero: d.xero ?? null } as InvoiceView;
  // Recompute the time-dependent part (authorised → awaiting payment once due).
  inv.status = invoiceStatusOf(inv, dayKey(new Date(), 'Australia/Sydney'));
  return inv;
};

export interface FinanceTx {
  id: string;
  type: string;
  customerId: string;
  amount: number;
  description: string;
  source: string;
  bookingId: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  relatedId: string | null;
  reference: string | null;
  createdBy: string;
  date: string;
  createdMs: number;
  syncStatus: string;
  attempts: number;
  lastAttemptAt?: Date;
  lastError: string | null;
  xeroId: string | null;
  xeroType?: string;
  isCredit?: boolean;
  creditTotal?: number;
  creditRemaining?: number;
  pieces?: { sourceId: string; amount: number; done: boolean }[];
  paymentMethod?: string | null;
  paymentReference?: string | null;
}

export const mapFinanceTx = (id: string, d: DocumentData): FinanceTx => ({ id, ...d, lastAttemptAt: toDate(d.lastAttemptAt) } as FinanceTx);

export interface RefundView {
  id: string;
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
  requestedAt?: Date;
  decidedBy?: string;
  decidedAt?: Date;
  rejectionReason?: string;
  transferReference?: string;
  transferDate?: string;
  completedAt?: Date;
  financeTxId?: string | null;
  history: { at: string; status: string; by: string; note?: string }[];
}

export const mapRefund = (id: string, d: DocumentData): RefundView => ({ id, ...d, requestedAt: toDate(d.requestedAt), decidedAt: toDate(d.decidedAt), completedAt: toDate(d.completedAt) } as RefundView);

export function useMyInvoices(uid: string | null) {
  return useQuery(uid ? query(collection(db, 'invoices'), where('learnerId', '==', uid), orderBy('createdAt', 'desc'), limit(200)) : null, mapInvoice, `invoices:${uid}`);
}

export function useMyRefunds(uid: string | null) {
  return useQuery(uid ? query(collection(db, 'refundRequests'), where('customerId', '==', uid), orderBy('requestedAt', 'desc'), limit(50)) : null, mapRefund, `refunds:${uid}`);
}

export function useAccountingSettings() {
  return useDoc(doc(db, 'integrations', 'xeroSettings'), (_, d) => settingsFrom(d));
}

export const invoiceStatusMeta = (s: InvoiceStatus) => INVOICE_STATUS[s] ?? INVOICE_STATUS.draft;

const aud = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
const auDate = (iso: string | null | undefined) => (iso ? iso.split('-').reverse().join('/') : '—');

/** Builds the invoice as a PDF and downloads it (jsPDF loads only when needed). */
export async function downloadInvoicePdf(inv: InvoiceView) {
  const business = inv.seller ?? { name: 'Safe Learners', abn: '', address: '', email: '' };
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = pdf.internal.pageSize.getWidth();
  const M = 48;
  let y = 56;
  const gst = inv.lineAmountTypes !== 'NoTax' && inv.tax > 0;
  pdf.setFont('helvetica', 'bold').setFontSize(18).text(business.name || 'Safe Learners', M, y);
  pdf.setFontSize(22).text(gst && business.abn ? 'TAX INVOICE' : 'INVOICE', W - M, y, { align: 'right' });
  pdf.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(90);
  y += 16;
  for (const l of [business.abn ? `ABN ${business.abn}` : '', business.address, business.email].filter(Boolean)) { pdf.text(l, M, y); y += 13; }
  let ry = 72;
  const meta: [string, string][] = [
    ['Invoice number', inv.number],
    ['Issue date', auDate(inv.issueDate)],
    ['Due date', auDate(inv.dueDate)],
    ['Status', invoiceStatusMeta(inv.status).label],
  ];
  if (inv.bookingRef) meta.push(['Booking', inv.bookingRef]);
  for (const [k, v] of meta) {
    pdf.setTextColor(110).text(k, W - M - 150, ry);
    pdf.setTextColor(20).text(v, W - M, ry, { align: 'right' });
    ry += 14;
  }
  y = Math.max(y, ry) + 18;
  pdf.setTextColor(110).setFontSize(9).text('BILL TO', M, y);
  pdf.setTextColor(20).setFontSize(11).setFont('helvetica', 'bold').text(inv.learnerName, M, y + 15);
  pdf.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(90);
  pdf.text([inv.learnerEmail ?? '', `Customer ${inv.customerNumber.slice(0, 12)}`].filter(Boolean), M, y + 29);
  if (inv.kind === 'lesson' && inv.lessonDate) {
    pdf.text([`Lesson: ${auDate(inv.lessonDate)}${inv.durationMinutes ? ` · ${inv.durationMinutes} minutes` : ''}`, inv.instructorName ? `Instructor: ${inv.instructorName}` : ''].filter(Boolean), W / 2, y + 15);
  }
  y += 62;
  // Lines
  const cols = { desc: M, qty: W - M - 210, unit: W - M - 150, tax: W - M - 75, amt: W - M };
  pdf.setDrawColor(200).line(M, y, W - M, y);
  y += 14;
  pdf.setFontSize(9).setTextColor(110).setFont('helvetica', 'bold');
  pdf.text('Description', cols.desc, y);
  pdf.text('Qty', cols.qty, y, { align: 'right' });
  pdf.text('Unit price', cols.unit, y, { align: 'right' });
  pdf.text(gst ? 'GST' : 'Tax', cols.tax, y, { align: 'right' });
  pdf.text('Amount', cols.amt, y, { align: 'right' });
  y += 8;
  pdf.line(M, y, W - M, y);
  pdf.setFont('helvetica', 'normal').setTextColor(20).setFontSize(9.5);
  for (const l of inv.lines) {
    y += 15;
    const wrapped = pdf.splitTextToSize(l.description, cols.qty - M - 30) as string[];
    pdf.text(wrapped, cols.desc, y);
    pdf.text(String(l.quantity), cols.qty, y, { align: 'right' });
    pdf.text(aud(l.unitAmount), cols.unit, y, { align: 'right' });
    pdf.text(aud(l.tax), cols.tax, y, { align: 'right' });
    pdf.text(aud(l.lineAmount), cols.amt, y, { align: 'right' });
    y += (wrapped.length - 1) * 12;
    if (l.discount > 0) { y += 12; pdf.setTextColor(90).text(`Discount ${aud(l.discount)}`, cols.desc, y); pdf.setTextColor(20); }
  }
  y += 12;
  pdf.line(M, y, W - M, y);
  const sums: [string, string, boolean?][] = [
    [inv.lineAmountTypes === 'Inclusive' ? 'Subtotal (excl. GST)' : 'Subtotal', aud(inv.subtotal)],
    [gst ? (inv.lineAmountTypes === 'Inclusive' ? 'GST included' : 'GST') : 'Tax', aud(inv.tax)],
    ['Total (AUD)', aud(inv.total), true],
    ['Paid from wallet credit', `-${aud(inv.amountPaid)}`],
  ];
  if (inv.amountCredited > 0) sums.push(['Credited', `-${aud(inv.amountCredited)}`]);
  sums.push(['Amount due', aud(inv.amountDue), true]);
  for (const [k, v, bold] of sums) {
    y += 16;
    pdf.setFont('helvetica', bold ? 'bold' : 'normal').text(k, cols.tax - 60, y, { align: 'right' }).text(v, cols.amt, y, { align: 'right' });
  }
  y += 30;
  pdf.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(110);
  const notes = [
    inv.voided ? 'This invoice has been voided.' : '',
    inv.creditNotes.length ? `Credit note${inv.creditNotes.length > 1 ? 's' : ''}: ${inv.creditNotes.map(c => c.number).join(', ')}.` : '',
    'Lesson credit is applied automatically from your Safe Learners wallet.',
  ].filter(Boolean);
  pdf.text(notes, M, y);
  pdf.save(`${inv.number}.pdf`);
}
