import { describe, expect, it } from 'vitest';
import {
  creditPackagePrice,
  formatBookingRef,
  learnerCanReschedule,
  lessonPrice,
  normaliseBooking,
  openSlotsForDay,
  parseLegacyDate,
  parseLegacyTime,
  type Booking,
} from '@shared/domain';
import { atLocalTime, dayKey, formatTime, fromZoned, toZoned, weekdayOfKey } from '@shared/time';

const toDate = (v: unknown) => (v instanceof Date ? v : undefined);

describe('time zones', () => {
  it('converts Sydney wall-clock time to UTC in winter (AEST, +10)', () => {
    expect(fromZoned(2026, 7, 1, 9, 0, 'Australia/Sydney').toISOString()).toBe('2026-06-30T23:00:00.000Z');
  });
  it('converts Sydney wall-clock time to UTC in summer (AEDT, +11)', () => {
    expect(fromZoned(2026, 12, 1, 9, 0, 'Australia/Sydney').toISOString()).toBe('2026-11-30T22:00:00.000Z');
  });
  it('handles the DST change day (4 Oct 2026, clocks jump at 2am)', () => {
    const nine = atLocalTime('2026-10-04', '09:00', 'Australia/Sydney');
    expect(toZoned(nine, 'Australia/Sydney')).toMatchObject({ hour: 9, minute: 0, day: 4 });
  });
  it('round-trips Perth and Adelaide', () => {
    for (const tz of ['Australia/Perth', 'Australia/Adelaide']) {
      const d = atLocalTime('2026-03-15', '14:30', tz);
      expect(toZoned(d, tz)).toMatchObject({ year: 2026, month: 3, day: 15, hour: 14, minute: 30 });
    }
  });
  it('gives the local day regardless of the machine zone', () => {
    // 23:30 UTC on 1 Oct is already 2 Oct in Sydney
    expect(dayKey(new Date('2026-10-01T23:30:00Z'), 'Australia/Sydney')).toBe('2026-10-02');
    expect(weekdayOfKey('2026-10-02')).toBe('friday');
    expect(formatTime(atLocalTime('2026-10-02', '13:05'), 'Australia/Sydney')).toBe('1:05 pm');
  });
});

describe('booking references', () => {
  it('uses the lesson day and month, then the sequence', () => {
    expect(formatBookingRef(atLocalTime('2026-09-09', '10:00'), 1)).toBe('0909-01');
    expect(formatBookingRef(atLocalTime('2026-10-01', '23:00'), 12)).toBe('0110-12');
  });
});

describe('pricing', () => {
  const pricing = { lesson: 75, testPackage: 240 };
  it('prices each lesson type', () => {
    expect(lessonPrice('lesson-1h', pricing)).toBe(75);
    expect(lessonPrice('lesson-1.5h', pricing)).toBe(112.5);
    expect(lessonPrice('lesson-2h', pricing)).toBe(150);
    expect(lessonPrice('test-package', pricing)).toBe(240);
  });
  it('applies package discounts', () => {
    expect(creditPackagePrice(10, 70)).toEqual({ gross: 700, discount: 70, total: 630 });
    expect(creditPackagePrice(6, 70)).toEqual({ gross: 420, discount: 21, total: 399 });
    expect(creditPackagePrice(3, 70)).toEqual({ gross: 210, discount: 0, total: 210 });
  });
});

describe('availability', () => {
  const day = '2026-10-07'; // Wednesday
  const hours = { wednesday: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '15:00' }] };
  const now = new Date('2026-10-01T00:00:00Z');

  it('lists 30-minute starts inside every range', () => {
    const slots = openSlotsForDay({ day, durationMinutes: 60, hours, busy: [], now });
    expect(slots.map(s => formatTime(s.start))).toEqual([
      '8:00 am', '8:30 am', '9:00 am', '9:30 am', '10:00 am', '10:30 am', '11:00 am', '1:00 pm', '1:30 pm', '2:00 pm',
    ]);
  });
  it('removes overlapping busy time', () => {
    const busy = [{ start: atLocalTime(day, '09:00'), end: atLocalTime(day, '10:00') }];
    const slots = openSlotsForDay({ day, durationMinutes: 60, hours, busy, now }).map(s => formatTime(s.start));
    expect(slots).not.toContain('8:30 am');
    expect(slots).not.toContain('9:00 am');
    expect(slots).not.toContain('9:30 am');
    expect(slots).toContain('8:00 am');
    expect(slots).toContain('10:00 am');
  });
  it('fits long lessons only where they fit', () => {
    const slots = openSlotsForDay({ day, durationMinutes: 150, hours, busy: [], now });
    expect(slots.map(s => formatTime(s.start))).toEqual(['8:00 am', '8:30 am', '9:00 am', '9:30 am']);
  });
  it('hides times inside the minimum notice', () => {
    const almost = atLocalTime(day, '09:10');
    const slots = openSlotsForDay({ day, durationMinutes: 60, hours, busy: [], now: almost, minNoticeMinutes: 120 });
    // Earliest allowed start is 11:10; 11:30 would run past the 12:00 break, so the next fit is 1pm.
    expect(formatTime(slots[0].start)).toBe('1:00 pm');
  });
  it('returns nothing on closed days', () => {
    expect(openSlotsForDay({ day: '2026-10-08', durationMinutes: 60, hours, busy: [], now })).toEqual([]);
  });
});

describe('legacy bookings from the old site', () => {
  it('parses old date and time strings', () => {
    expect(parseLegacyDate('Wed, 9 Sep 2026')).toBe('2026-09-09');
    expect(parseLegacyDate('2026-09-09')).toBe('2026-09-09');
    expect(parseLegacyTime('10:00 am')).toBe('10:00');
    expect(parseLegacyTime('12:30 PM')).toBe('12:30');
    expect(parseLegacyTime('12:15 am')).toBe('00:15');
    expect(parseLegacyTime('14:30')).toBe('14:30');
  });
  it('normalises an old cancelled booking', () => {
    const b = normaliseBooking('oawKHxh123', {
      learnerId: 'L', instructorId: 'I', date: 'Wed, 9 Sep 2026', startTime: '10:00 am', endTime: '11:00 am',
      status: 'CANCELLED', lessonType: '1 hour', bookingRef: '0909-01', pickupLocation: 'Tallawong',
    }, toDate)!;
    expect(b.status).toBe('cancelled');
    expect(b.ref).toBe('0909-01');
    expect(b.lessonType).toBe('lesson-1h');
    expect(b.legacy).toBe(true);
    expect(formatTime(b.startAt)).toBe('10:00 am');
    expect(b.endAt.getTime() - b.startAt.getTime()).toBe(3_600_000);
  });
  it('maps old proposals and personal events', () => {
    expect(normaliseBooking('x', { date: '2026-10-01', time: '09:00', status: 'pending', lessonType: '2 hour', instructorId: 'I' }, toDate)!.status).toBe('proposed');
    const event = normaliseBooking('y', { date: 'Thu, 1 Oct 2026', startTime: '1:00 pm', endTime: '3:00 pm', type: 'personal', learnerName: 'Dentist', status: 'CONFIRMED', instructorId: 'I' }, toDate)!;
    expect(event.kind).toBe('event');
    expect(event.title).toBe('Dentist');
  });
  it('skips documents without a usable date', () => {
    expect(normaliseBooking('z', { date: 'soon', startTime: '??' }, toDate)).toBeNull();
  });
});

describe('reschedule rules', () => {
  const base = { id: 'b', kind: 'lesson', instructorId: 'I', timezone: 'Australia/Sydney' } as const;
  const at = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * 3_600_000);
  it('lets learners rebook cancelled lessons', () => {
    expect(learnerCanReschedule({ ...base, status: 'cancelled', startAt: at(-10), endAt: at(-9) } as Booking)).toBe(true);
  });
  it('blocks moving a confirmed lesson inside 24 hours', () => {
    expect(learnerCanReschedule({ ...base, status: 'confirmed', startAt: at(5), endAt: at(6) } as Booking)).toBe(false);
    expect(learnerCanReschedule({ ...base, status: 'confirmed', startAt: at(30), endAt: at(31) } as Booking)).toBe(true);
  });
  it('does not offer it twice', () => {
    expect(learnerCanReschedule({ ...base, status: 'cancelled', rescheduledTo: 'n', startAt: at(30), endAt: at(31) } as Booking)).toBe(false);
  });
});

describe('document expiry dates', () => {
  it('reads every format we have seen', async () => {
    const { normaliseExpiry } = await import('@shared/domain');
    expect(normaliseExpiry('2029-06-30')).toBe('2029-06-30');
    expect(normaliseExpiry('0029-04-08')).toBe('2029-04-08'); // Chrome date box with a 2-digit year
    expect(normaliseExpiry('08/04/2029')).toBe('2029-04-08'); // Australian DD/MM/YYYY
    expect(normaliseExpiry('8/4/29')).toBe('2029-04-08');
    expect(normaliseExpiry('03 JUL 2029')).toBe('2029-07-03');
    expect(normaliseExpiry('31/02/2029')).toBeNull();
    expect(normaliseExpiry('soon')).toBeNull();
  });
  it('only flags genuinely past dates as expired', async () => {
    const { isExpired } = await import('@shared/domain');
    const now = new Date('2026-10-02T03:00:00Z');
    expect(isExpired('0029-04-08', undefined, now)).toBe(false);
    expect(isExpired('2026-10-02', undefined, now)).toBe(false); // expires today: still valid today
    expect(isExpired('2026-10-01', undefined, now)).toBe(true);
    expect(isExpired('garbage', undefined, now)).toBe(false);
  });
});
