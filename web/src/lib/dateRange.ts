// Dashboard periods in Sydney time: presets (today, last 7 days, ...) and custom ranges as [from, to) instants.
export type Preset = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'prevMonth' | 'custom';
export const TZ = 'Australia/Sydney';
/** Midnight in Sydney for a YYYY-MM-DD day, as a Date. */
export function sydneyMidnight(day: string): Date {
  const probe = new Date(`${day}T12:00:00Z`);
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' }).formatToParts(probe).find(p => p.type === 'timeZoneName')!.value;
  const hours = Number(offset.replace('GMT', '')) || 10;
  return new Date(Date.parse(`${day}T00:00:00Z`) - hours * 3_600_000);
}
export const dayOf = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function rangeFor(p: Preset, custom: { from: string; to: string }): { from: string; to: string; label: string } {
  const today = dayOf(new Date());
  const [y, m] = today.split('-').map(Number);
  const first = `${y}-${String(m).padStart(2, '0')}-01`;
  const prevFirst = m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
  const r = {
    today: [today, addDays(today, 1), 'Today'], yesterday: [addDays(today, -1), today, 'Yesterday'], '7d': [addDays(today, -6), addDays(today, 1), 'Last 7 days'],
    '30d': [addDays(today, -29), addDays(today, 1), 'Last 30 days'], month: [first, addDays(today, 1), 'This month'], prevMonth: [prevFirst, first, 'Previous month'],
    custom: [custom.from, addDays(custom.to, 1), 'Custom range'],
  }[p] as [string, string, string];
  return { from: sydneyMidnight(r[0]).toISOString(), to: sydneyMidnight(r[1]).toISOString(), label: r[2] };
}


export const PRESETS: { value: Preset; label: string }[] = [
  { value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: '7d', label: 'Last 7 days' }, { value: '30d', label: 'Last 30 days' },
  { value: 'month', label: 'This month' }, { value: 'prevMonth', label: 'Previous month' }, { value: 'custom', label: 'Custom range' },
];
