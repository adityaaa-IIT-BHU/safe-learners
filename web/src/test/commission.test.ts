// Commission rules: priority, effective dates, introductory places, amounts and validation.
import { assert, describe, test } from 'vitest';
import { INITIAL_VERSION, activeVersion, resolveCommission, splitCommission, upcomingChange, validRate, type CommissionVersion, type CustomRateEntry } from '@shared/commission';
import { DEFAULT_ACCOUNTING_SETTINGS, lessonLines } from '@shared/finance';

const v = (effectiveFrom: string, defaultRate: number, introRate: number, introEnabled = true, introPlaces = 10, createdMs = 0): CommissionVersion =>
  ({ id: `v-${effectiveFrom}-${createdMs}`, defaultRate, introRate, introEnabled, introPlaces, effectiveFrom, createdMs });
const versions = [v('2026-11-01', 20, 10), v('2027-01-01', 22, 12)];
const custom = (rate: number | null, effectiveFrom: string, createdMs = 1): CustomRateEntry => ({ id: `c-${effectiveFrom}-${rate}`, rate, effectiveFrom, createdMs });

describe('which rate applies', () => {
  test('before any structure is set, everyone uses the long-standing 15%', () => {
    assert.deepEqual(activeVersion([], '2026-11-19'), INITIAL_VERSION);
    assert.equal(resolveCommission({}, '2026-11-19').rate, 15);
  });
  test('default rate for an instructor without a place or custom rate', () => {
    const r = resolveCommission({ versions }, '2026-11-19');
    assert.equal(r.rate, 20); assert.equal(r.category, 'default');
  });
  test('introductory rate for an instructor holding a place', () => {
    const r = resolveCommission({ versions, intro: { status: 'allocated', place: 3 } }, '2026-11-19');
    assert.equal(r.rate, 10); assert.equal(r.category, 'introductory');
  });
  test('an excluded (duplicate) account gets the default rate', () => {
    assert.equal(resolveCommission({ versions, intro: { status: 'excluded' } }, '2026-11-19').category, 'default');
  });
  test('custom rate overrides the introductory rate', () => {
    const r = resolveCommission({ versions, intro: { status: 'allocated', place: 1 }, custom: [custom(12, '2026-11-10')] }, '2026-11-19');
    assert.equal(r.rate, 12); assert.equal(r.category, 'custom');
  });
  test('removing the custom rate restores the introductory rate from the removal date', () => {
    const input = { versions, intro: { status: 'allocated' as const, place: 1 }, custom: [custom(12, '2026-11-10'), custom(null, '2026-12-01', 2)] };
    assert.equal(resolveCommission(input, '2026-11-30').rate, 12);
    const r = resolveCommission(input, '2026-12-01');
    assert.equal(r.rate, 10); assert.equal(r.category, 'introductory');
  });
  test('changing the default rate does not affect a custom rate', () => {
    const input = { versions, custom: [custom(14, '2026-11-10')] };
    assert.equal(resolveCommission(input, '2027-02-01').rate, 14);
    assert.equal(resolveCommission({ versions }, '2027-02-01').rate, 22);
  });
  test('turning the offer off keeps existing places (no silent change)', () => {
    const off = [...versions, v('2027-03-01', 22, 12, false)];
    assert.equal(resolveCommission({ versions: off, intro: { status: 'allocated', place: 2 } }, '2027-03-02').category, 'introductory');
  });
  test('a scheduled change applies only from its effective date, and is reported as upcoming', () => {
    assert.equal(resolveCommission({ versions }, '2026-12-31').rate, 20);
    assert.equal(resolveCommission({ versions }, '2027-01-01').rate, 22);
    const up = upcomingChange({ versions }, '2026-11-19');
    assert.equal(up?.rate, 22); assert.equal(up?.effectiveFrom, '2027-01-01');
    assert.equal(upcomingChange({ versions }, '2027-02-01'), null);
  });
  test('two changes for the same date: the later one wins', () => {
    const same = [v('2026-11-01', 20, 10, true, 10, 1), v('2026-11-01', 18, 10, true, 10, 2)];
    assert.equal(resolveCommission({ versions: same }, '2026-11-19').rate, 18);
  });
});

describe('amounts', () => {
  test('commission and earnings add up to the lesson price, to the cent', () => {
    for (const [price, rate] of [[75, 15], [100, 12.5], [130, 10], [99.99, 17.5], [0, 20]]) {
      const s = splitCommission(price, rate);
      assert.equal(Math.round((s.commission + s.earnings) * 100), Math.round(price * 100));
    }
    assert.deepEqual(splitCommission(100, 12.5), { commission: 12.5, earnings: 87.5 });
    assert.deepEqual(splitCommission(75, 10), { commission: 7.5, earnings: 67.5 });
  });
  test('rates are validated', () => {
    for (const ok of [0, 10, 12.5, 99.99]) assert.equal(validRate(ok), true, String(ok));
    for (const bad of [-1, 100, 150, 12.345, NaN, Infinity, '10' as unknown]) assert.equal(validRate(bad), false, String(bad));
  });
  test('agent invoices use the lesson’s own commission as the booking fee', () => {
    const s = { ...DEFAULT_ACCOUNTING_SETTINGS, sellerModel: 'agent' as const, lineAmountTypes: 'Inclusive' as const, instructorPayableAccount: '800', feeAccount: '200', feeTaxType: 'OUTPUT', instructorTaxTypeUnregistered: 'BASEXCLUDED', taxRates: { OUTPUT: 10 } };
    const booking = { price: 100, lessonType: 'lesson-1h' as const, instructorName: 'Sam', startAt: new Date('2026-12-01T00:00:00Z'), timezone: 'Australia/Sydney' };
    const lines = lessonLines(booking, s, false, 0.12);
    assert.equal(lines[1].lineAmount, 12); assert.equal(lines[0].lineAmount, 88);
    assert.equal(lessonLines(booking, s, false)[1].lineAmount, 15, 'falls back to the settings rate');
  });
});
