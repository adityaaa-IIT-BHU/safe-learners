import { describe, expect, it } from 'vitest';
import {
  calendarOf,
  coversArea,
  openSlotsForDay,
  parseAreaString,
  priceChangeEffectiveAt,
  pricingFor,
  pricingOf,
  type UserProfile,
} from '@shared/domain';
import { parseDocumentText } from '@shared/ocr';
import { atLocalTime, formatDate, formatTime } from '@shared/time';

const day = '2026-10-14'; // Wednesday
const hours = { wednesday: [{ start: '09:00', end: '17:00' }] };
const now = new Date('2026-10-01T00:00:00Z');
const times = (slots: { start: Date }[]) => slots.map(s => formatTime(s.start));
const lesson = (from: string, to: string) => ({ start: atLocalTime(day, from), end: atLocalTime(day, to) });

describe('travel buffer between lessons', () => {
  it('keeps the buffer free after and before existing lessons', () => {
    const slots = openSlotsForDay({ day, durationMinutes: 60, hours, busy: [lesson('10:00', '11:00')], bufferMinutes: 45, now });
    const t = times(slots);
    expect(t).toContain('11:45 am'); // 11:00 + 45 min buffer
    expect(t).not.toContain('11:30 am');
    expect(t).not.toContain('9:00 am'); // 9–10 would end with no buffer before 10:00
    expect(t).not.toContain('8:15 am');
  });
});

describe('personal events without a travel buffer', () => {
  it('lets lessons be booked right up to them', () => {
    const lunch = { ...lesson('12:00', '13:00'), bufferMinutes: 0 };
    const t = times(openSlotsForDay({ day, durationMinutes: 60, hours, busy: [lunch], bufferMinutes: 30, now }));
    expect(t).toContain('11:00 am'); // ends exactly at 12:00
    expect(t).toContain('1:00 pm'); // starts right after
  });
  it('still keeps the buffer around lessons', () => {
    const t = times(openSlotsForDay({ day, durationMinutes: 60, hours, busy: [lesson('12:00', '13:00')], bufferMinutes: 30, now }));
    expect(t).not.toContain('11:00 am');
    expect(t).toContain('1:30 pm');
  });
});

describe('smart scheduling', () => {
  it('does not offer 10am on an empty 9–5 day (it would waste 9–10)', () => {
    const slots = openSlotsForDay({ day, durationMinutes: 60, hours, busy: [], smartGapMinutes: 120, now });
    const t = times(slots);
    expect(t).toContain('9:00 am');
    expect(t).not.toContain('9:30 am'); // leaves a 30 min gap
    expect(t).not.toContain('10:00 am'); // leaves a 1 hr gap (< 2 hr)
    expect(t).toContain('11:00 am'); // leaves a 2 hr gap: bookable
    expect(t).toContain('4:00 pm'); // finishes exactly at close
  });
  it('counts the travel buffer when judging gaps (the client’s 10am example)', () => {
    const t = times(openSlotsForDay({ day, durationMinutes: 60, hours, busy: [], bufferMinutes: 30, smartGapMinutes: 60, now }));
    expect(t[0]).toBe('9:00 am');
    expect(t).not.toContain('10:00 am'); // 9–10 can't fit a lesson + 30 min buffer
    expect(t).toContain('10:30 am'); // leaves 9–10:30: a 1 hr lesson + buffer fits
  });
  it('still offers times in a short window (flush to its start or end)', () => {
    const extra = [{ start: atLocalTime('2026-10-18', '10:00'), end: atLocalTime('2026-10-18', '12:00') }];
    const t = times(openSlotsForDay({ day: '2026-10-18', durationMinutes: 60, hours: {}, busy: [], extraOpen: extra, bufferMinutes: 30, smartGapMinutes: 60, now }));
    expect(t).toEqual(['10:00 am', '11:00 am']);
  });
  it('slots right after an existing lesson plus buffer', () => {
    const slots = openSlotsForDay({ day, durationMinutes: 60, hours, busy: [lesson('09:00', '10:00')], bufferMinutes: 30, smartGapMinutes: 60, now });
    expect(times(slots)[0]).toBe('10:30 am');
  });
});

describe('extra open hours and booking window', () => {
  it('adds bookable time outside the weekly hours', () => {
    const extra = [{ start: atLocalTime(day, '18:00'), end: atLocalTime(day, '20:00') }];
    const t = times(openSlotsForDay({ day, durationMinutes: 60, hours, busy: [], extraOpen: extra, now }));
    expect(t).toContain('6:00 pm');
    expect(t).toContain('7:00 pm');
  });
  it('opens a closed day', () => {
    const closedDay = '2026-10-15';
    const extra = [{ start: atLocalTime(closedDay, '10:00'), end: atLocalTime(closedDay, '12:00') }];
    expect(times(openSlotsForDay({ day: closedDay, durationMinutes: 60, hours, busy: [], extraOpen: extra, now }))).toEqual(['10:00 am', '10:30 am', '11:00 am']);
  });
  it('respects the furthest-ahead limit', () => {
    expect(openSlotsForDay({ day, durationMinutes: 60, hours, busy: [], latest: new Date('2026-10-10T00:00:00Z'), now })).toEqual([]);
  });
  it('always offers 1 and 2 hour lessons and keeps the order', () => {
    expect(calendarOf({ calendarSettings: { lessonTypes: ['test-package'] } }).lessonTypes).toEqual(['lesson-1h', 'lesson-2h', 'test-package']);
  });
});

describe('pricing', () => {
  const instructor = { id: 'I', pricing: { lesson: 79, testPackage: 250, privateLesson: 75, privateTestPackage: 225 } } as UserProfile;
  it('charges private rates to learners the instructor invited', () => {
    expect(pricingFor(instructor, { invitedBy: 'I' } as UserProfile)).toEqual({ lesson: 75, testPackage: 225 });
    expect(pricingFor(instructor, { privateInstructorIds: ['I'] } as UserProfile).lesson).toBe(75);
    expect(pricingFor(instructor, { invitedBy: 'someone-else' } as UserProfile)).toEqual({ lesson: 79, testPackage: 250 });
    expect(pricingFor(instructor, null).lesson).toBe(79);
  });
  it('starts price changes at the next local midnight', () => {
    const at = priceChangeEffectiveAt(new Date('2026-10-09T09:23:00Z'), 'Australia/Sydney'); // 8:23pm Fri in Sydney
    expect(formatDate(at, 'Australia/Sydney')).toBe('Sat, 10 Oct 2026');
    expect(formatTime(at, 'Australia/Sydney')).toBe('12:00 am');
  });
  it('uses the new price as soon as midnight passes, before the job runs', () => {
    const u = { pricing: { lesson: 70, testPackage: 225 }, pendingPriceChange: { newPrice: 80, effectiveAt: new Date('2026-10-10T00:00:00Z') } } as UserProfile;
    expect(pricingOf(u, new Date('2026-10-09T23:00:00Z')).lesson).toBe(70);
    expect(pricingOf(u, new Date('2026-10-10T00:01:00Z')).lesson).toBe(80);
  });
});

describe('postcode search', () => {
  const bik = { servicedSuburbs: ['Schofields', 'Tallawong', '2769'] } as UserProfile;
  const located = { serviceAreas: [{ name: 'Schofields', state: 'NSW', postcode: '2762', lat: -33.703, lng: 150.87 }] } as UserProfile;
  it('reads plain suburbs and postcodes from the old site', () => {
    expect(parseAreaString('Kellyville NSW 2155')).toEqual({ name: 'Kellyville', state: 'NSW', postcode: '2155' });
    expect(parseAreaString('2769')).toEqual({ name: '2769', state: undefined, postcode: '2769' });
  });
  it('matches by postcode, name, or a located postcode area', () => {
    expect(coversArea(bik, '2769')).toBe(true);
    expect(coversArea(bik, 'schofields')).toBe(true);
    expect(coversArea(bik, '2762')).toBe(false); // old plain names have no postcode…
    expect(coversArea(bik, '2762', { lat: -33.7, lng: 150.87, postcode: '2762', name: 'Schofields' })).toBe(true); // …unless the search is located
    expect(coversArea(located, '2762')).toBe(true);
    expect(coversArea(located, 'Rouse Hill', { lat: -33.68, lng: 150.92 })).toBe(false); // ~5 km away
    expect(coversArea(located, 'Nirimba Fields', { lat: -33.71, lng: 150.875 })).toBe(true); // within 3 km
  });
});

describe('reading documents', () => {
  it('reads an NSW driver licence', () => {
    const text = 'NEW SOUTH WALES\nDRIVER LICENCE\nBIKRAMJIT SINGH\nLicence No. 12345678\nDate of Birth 30 SEP 1977\nCard Expiry 28 NOV 2027\nClass C';
    expect(parseDocumentText('driverLicence', text)).toEqual({ number: '12345678', expiry: '2027-11-28', state: 'NSW' });
  });
  it('reads a WWC check', () => {
    expect(parseDocumentText('wwc', 'Working With Children Check\nWWC1858993E\nExpiry 15/03/2029\nNSW Government')).toMatchObject({ number: 'WWC1858993E', expiry: '2029-03-15', state: 'NSW' });
  });
  it('reads a rego certificate', () => {
    expect(parseDocumentText('vehicleRego', 'Certificate of Registration\nPlate number CX30AB\nRegistration expires 07/05/2027')).toMatchObject({ number: 'CX30AB', expiry: '2027-05-07' });
  });
});
