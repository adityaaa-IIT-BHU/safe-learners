import { assert, test } from 'vitest';
import {
  DEFAULT_ACCOUNTING_SETTINGS,
  invoiceNumberFor,
  invoiceStatusOf,
  lessonLines,
  lineTax,
  missingSettings,
  planAllocation,
  refundableAmount,
  totals,
  type AccountingSettings,
} from '@shared/finance';

const base: AccountingSettings = {
  ...DEFAULT_ACCOUNTING_SETTINGS,
  enabled: true,
  startDate: '2026-11-01',
  sellerModel: 'principal',
  lineAmountTypes: 'Inclusive',
  lessonAccount: '200',
  lessonTaxType: 'OUTPUT',
  cancellationFeeAccount: '260',
  cancellationFeeTaxType: 'OUTPUT',
  prepaymentAccount: '835',
  topupBankAccount: '090',
  refundBankAccount: '090',
  promotionsAccount: '400',
  goodwillAccount: '400',
  adjustmentsAccount: '260',
  openingCreditAccount: '835',
  creditTaxType: 'BASEXCLUDED',
  taxRates: { OUTPUT: 10, BASEXCLUDED: 0 },
  business: { name: 'Safe Learners', abn: '', address: '', email: '' },
};

const booking = { id: 'abcdefghijkl', ref: '1711-01', price: 75, lessonType: 'lesson-1h' as const, instructorName: 'Bik', startAt: new Date('2026-11-17T00:00:00Z'), timezone: 'Australia/Sydney' };

test('GST-inclusive lesson: the price is unchanged and GST is one eleventh', () => {
  const lines = lessonLines(booking, base, false);
  assert.equal(lines.length, 1);
  const t = totals(lines, 'Inclusive');
  assert.equal(t.total, 75);
  assert.equal(t.tax, 6.82);
  assert.equal(t.subtotal, 68.18);
});

test('GST-exclusive adds GST on top; no-tax adds none', () => {
  assert.equal(lineTax(100, 'Exclusive', 10), 10);
  assert.equal(totals(lessonLines(booking, { ...base, lineAmountTypes: 'Exclusive' }, false), 'Exclusive').total, 82.5);
  assert.equal(lineTax(100, 'NoTax', 10), 0);
});

test('agent model splits the fee from the instructor share without changing the total', () => {
  const s: AccountingSettings = { ...base, sellerModel: 'agent', feeAccount: '201', feeTaxType: 'OUTPUT', instructorPayableAccount: '820', instructorTaxTypeRegistered: 'OUTPUT', instructorTaxTypeUnregistered: 'BASEXCLUDED' };
  const lines = lessonLines(booking, s, false);
  assert.deepEqual(lines.map(l => [l.accountCode, l.lineAmount, l.taxType]), [['820', 63.75, 'BASEXCLUDED'], ['201', 11.25, 'OUTPUT']]);
  assert.equal(totals(lines, 'Inclusive').total, 75);
  assert.equal(lessonLines(booking, s, true)[0].taxType, 'OUTPUT');
});

test('invoice numbers carry the year because booking references restart each year', () => {
  assert.equal(invoiceNumberFor(booking), 'SL-2026-1711-01');
  assert.equal(invoiceNumberFor({ ...booking, ref: undefined }), 'SL-ABCDEFGHIJ');
});

test('credit is used oldest first, across sources, and a gap is reported', () => {
  const sources = [{ id: 'b', remaining: 30, date: 2 }, { id: 'a', remaining: 50, date: 1 }];
  assert.deepEqual(planAllocation(sources, 60), { pieces: [{ sourceId: 'a', amount: 50 }, { sourceId: 'b', amount: 10 }], shortfall: 0 });
  assert.deepEqual(planAllocation(sources, 100), { pieces: [{ sourceId: 'a', amount: 50 }, { sourceId: 'b', amount: 30 }], shortfall: 20 });
  assert.deepEqual(planAllocation([], 0), { pieces: [], shortfall: 0 });
});

test('invoice statuses', () => {
  const inv = { total: 75, amountPaid: 0, amountCredited: 0, dueDate: '2026-11-20' };
  assert.equal(invoiceStatusOf(inv, '2026-11-16'), 'authorised');
  assert.equal(invoiceStatusOf(inv, '2026-11-20'), 'awaiting_payment');
  assert.equal(invoiceStatusOf({ ...inv, amountPaid: 40 }, '2026-11-16'), 'partially_paid');
  assert.equal(invoiceStatusOf({ ...inv, amountPaid: 75 }, '2026-11-16'), 'paid');
  assert.equal(invoiceStatusOf({ ...inv, amountPaid: 40, amountCredited: 35 }, '2026-11-16'), 'credited');
  assert.equal(invoiceStatusOf({ ...inv, voided: true }, '2026-11-16'), 'voided');
});

test('settings: nothing can be switched on until every required account is chosen', () => {
  assert.deepEqual(missingSettings(base), []);
  assert.ok(missingSettings(DEFAULT_ACCOUNTING_SETTINGS).includes('Seller model (principal or agent)'));
  assert.ok(missingSettings({ ...base, sellerModel: 'agent' }).includes('Platform fee revenue account'));
  assert.ok(!missingSettings({ ...base, lineAmountTypes: 'NoTax', lessonTaxType: null }).includes('Lesson tax type'));
});

test('refunds can never exceed credit not already requested', () => {
  assert.equal(refundableAmount(100, [30, 20]), 50);
  assert.equal(refundableAmount(10, [30]), 0);
});
