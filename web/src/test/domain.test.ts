import { describe, expect, it } from 'vitest';
import {
  CREDIT_PACKAGES,
  coversArea,
  creditPackagePrice,
  formatBookingRef,
  holdsSlot,
  isExpiredProposal,
  isPlausibleAddress,
  learnerCanReschedule,
  learnerCanReview,
  lessonPrice,
  normaliseBooking,
  openSlotsForDay,
  parseLegacyDate,
  parseLegacyTime,
  proposalExpiresAt,
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
  it('sells wallet credit at the fixed package prices', () => {
    expect(CREDIT_PACKAGES.map(p => [p.title, p.price])).toEqual([
      ['1 hour lesson', 70], ['1.5 hour lesson', 100], ['2 hour lesson', 130], ['5 hour package', 315], ['10 hour package', 630],
    ]);
    expect(creditPackagePrice('lesson-1h')).toEqual({ hours: 1, gross: 70, discount: 0, total: 70 });
    expect(creditPackagePrice('lesson-1.5h')).toEqual({ hours: 1.5, gross: 105, discount: 5, total: 100 });
    expect(creditPackagePrice('package-5h')).toEqual({ hours: 5, gross: 350, discount: 35, total: 315 });
    expect(creditPackagePrice('package-10h')).toEqual({ hours: 10, gross: 700, discount: 70, total: 630 });
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

  describe('smart scheduling', () => {
    const saturday = '2026-10-24';
    const satHours = { saturday: [{ start: '09:00', end: '14:00' }] };
    const smart = { day: saturday, durationMinutes: 60, hours: satHours, now, smartGapMinutes: 60, bufferMinutes: 60 };
    const times = (busy: { start: Date; end: Date }[]) => openSlotsForDay({ ...smart, busy }).map(s => formatTime(s.start));

    it('offers every start on a day with no lessons (client report: only 9:00, 11:00 and 1:00 showed)', () => {
      expect(times([])).toEqual(['9:00 am', '9:30 am', '10:00 am', '10:30 am', '11:00 am', '11:30 am', '12:00 pm', '12:30 pm', '1:00 pm']);
    });
    it('still avoids stranding a short gap next to an existing lesson', () => {
      // Lesson 12–1pm with a 1h buffer: the instructor is busy 11am–2pm, so 9–11am is free.
      const busy = [{ start: atLocalTime(saturday, '12:00'), end: atLocalTime(saturday, '13:00') }];
      // 9:30 would leave 30 minutes before the buffer; 9:00 (start of day) and 10:00 (right up to the buffer) are fine.
      expect(times(busy)).toEqual(['9:00 am', '10:00 am']);
    });
  });
});

describe('postcode search', () => {
  const schofields = { serviceAreas: [{ name: 'Colebee', state: 'NSW', postcode: '2761' }] };
  it('matches any suburb that shares the searched postcode', () => {
    const located = { lat: -33.7, lng: 150.9, postcode: '2762', name: 'Schofields', localities: ['Schofields', 'Colebee'] };
    expect(coversArea(schofields, '2762', located)).toBe(true);
    expect(coversArea(schofields, '2762', { ...located, localities: undefined })).toBe(false);
  });
});

describe('proposals', () => {
  const proposed = (hoursAgo: number, startsInHours: number, withExpiry = true): Booking => {
    const createdAt = new Date(Date.now() - hoursAgo * 3_600_000);
    const startAt = new Date(Date.now() + startsInHours * 3_600_000);
    return {
      id: 'p', kind: 'lesson', status: 'proposed', instructorId: 'I', timezone: 'Australia/Sydney', createdAt, startAt,
      endAt: new Date(startAt.getTime() + 3_600_000), expiresAt: withExpiry ? proposalExpiresAt(createdAt, startAt) : undefined,
    };
  };
  it('expires after 24 hours and releases the time', () => {
    expect(isExpiredProposal(proposed(23, 72))).toBe(false);
    expect(holdsSlot(proposed(23, 72))).toBe(true);
    expect(isExpiredProposal(proposed(25, 72))).toBe(true);
    expect(holdsSlot(proposed(25, 72))).toBe(false);
  });
  it('expires when the lesson starts if that is sooner', () => {
    const p = proposed(0, 3);
    expect(p.expiresAt!.getTime()).toBe(p.startAt.getTime());
  });
  it('applies to proposals made before expiry existed', () => {
    expect(isExpiredProposal(proposed(30, 72, false))).toBe(true);
  });
});

describe('feedback', () => {
  const lesson = { kind: 'lesson', endAt: new Date(Date.now() - 3_600_000) } as const;
  it('asks for feedback on finished, unrated lessons only', () => {
    expect(learnerCanReview({ ...lesson, status: 'completed' })).toBe(true);
    expect(learnerCanReview({ ...lesson, status: 'confirmed' })).toBe(true);
    expect(learnerCanReview({ ...lesson, status: 'completed', reviewed: true })).toBe(false);
    expect(learnerCanReview({ ...lesson, status: 'cancelled' })).toBe(false);
  });
});

describe('addresses', () => {
  it('rejects scraps like "12 Y" and accepts real addresses', () => {
    expect(isPlausibleAddress('12 Y')).toBe(false);
    expect(isPlausibleAddress('12')).toBe(false);
    expect(isPlausibleAddress('12 Yelta St, The Ponds NSW 2769')).toBe(true);
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
