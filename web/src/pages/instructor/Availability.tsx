import { doc, updateDoc } from 'firebase/firestore';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { areaLabel, serviceAreasOf, type OperatingHours, type ServiceArea, type TestLocation, type TimeRange } from '@shared/domain';
import { TestLocationsEditor } from '@/components/TestLocationsEditor';
import { ServiceAreaEditor } from '@/components/ServiceAreaEditor';
import { DEFAULT_TIMEZONE, hhmmToMinutes, type Weekday } from '@shared/time';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { Button, Card, CardHeader, PageHeader, Select, cx } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { db } from '@/lib/firebase';

const ORDER: Weekday[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const AU_ZONES = [
  ['Australia/Sydney', 'NSW / ACT / VIC / TAS (AEST/AEDT)'],
  ['Australia/Brisbane', 'QLD (AEST, no daylight saving)'],
  ['Australia/Adelaide', 'SA (ACST/ACDT)'],
  ['Australia/Darwin', 'NT (ACST)'],
  ['Australia/Perth', 'WA (AWST)'],
] as const;

function validate(hours: OperatingHours): string | null {
  for (const day of ORDER) {
    const ranges = [...(hours[day] ?? [])].sort((a, b) => hhmmToMinutes(a.start) - hhmmToMinutes(b.start));
    for (let i = 0; i < ranges.length; i++) {
      if (hhmmToMinutes(ranges[i].end) <= hhmmToMinutes(ranges[i].start)) return `On ${day}, each end time must be after its start time.`;
      if (i > 0 && hhmmToMinutes(ranges[i].start) < hhmmToMinutes(ranges[i - 1].end)) return `On ${day}, time ranges overlap.`;
    }
  }
  return null;
}

export function Availability() {
  const me = useProfile();
  const { readOnly } = useAuth();
  const [hours, setHours] = useState<OperatingHours>(() => structuredClone(me.operatingHours ?? {}));
  const [areas, setAreas] = useState<ServiceArea[]>(() => serviceAreasOf(me));
  const [testLocations, setTestLocations] = useState<TestLocation[]>(me.testLocations ?? []);
  const [timezone, setTimezone] = useState(me.timezone ?? DEFAULT_TIMEZONE);
  const [saving, setSaving] = useState(false);

  const setDay = (day: Weekday, ranges: TimeRange[]) => setHours(h => ({ ...h, [day]: ranges }));
  const save = async () => {
    const problem = validate(hours);
    if (problem) return toast.error(problem);
    setSaving(true);
    try {
      const clean = Object.fromEntries(ORDER.map(d => [d, hours[d] ?? []]));
      await updateDoc(doc(db, 'users', me.id), {
        operatingHours: clean,
        // Located areas power postcode search and the map; plain labels keep older screens working.
        serviceAreas: areas.map(a => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined))),
        servicedSuburbs: areas.map(areaLabel),
        testLocations: testLocations.map(l => Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined))),
        timezone,
      });
      toast.success('Availability saved — learners see your new times straight away.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title="Availability & service area" subtitle="Learners can only book inside these hours, and only when you’re free."
        actions={<Button onClick={save} loading={saving} disabled={readOnly}>Save changes</Button>} />
      <div className="grid grid-cols-1 gap-6 [&>*]:min-w-0 lg:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader title="Weekly hours" action={
            <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => {
              const monday = hours.monday ?? [];
              setHours(h => ({ ...h, tuesday: structuredClone(monday), wednesday: structuredClone(monday), thursday: structuredClone(monday), friday: structuredClone(monday) }));
              toast.success('Copied Monday to Tuesday–Friday');
            }}>Copy Mon to weekdays</Button>
          } />
          <ul className="divide-y divide-ink-100 dark:divide-ink-800">
            {ORDER.map(day => {
              const ranges = hours[day] ?? [];
              const on = ranges.length > 0;
              return (
                <li key={day} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start">
                  <label className="flex w-36 shrink-0 items-center gap-3 pt-2">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={on}
                      onClick={() => setDay(day, on ? [] : [{ start: '09:00', end: '17:00' }])}
                      className={cx('relative h-6 w-11 rounded-full transition', on ? 'bg-ink-950 dark:bg-brand-500' : 'bg-ink-200 dark:bg-ink-700')}
                    >
                      <span className={cx('absolute top-0.5 size-5 rounded-full bg-white shadow transition', on ? 'left-[22px]' : 'left-0.5')} />
                    </button>
                    <span className="font-semibold capitalize">{day}</span>
                  </label>
                  <div className="flex-1 space-y-2">
                    {!on && <p className="pt-2 text-sm text-ink-400">Unavailable</p>}
                    {ranges.map((r, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input type="time" step={900} className="input w-32" value={r.start} aria-label={`${day} start`}
                          onChange={e => setDay(day, ranges.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
                        <span className="text-ink-400">–</span>
                        <input type="time" step={900} className="input w-32" value={r.end} aria-label={`${day} end`}
                          onChange={e => setDay(day, ranges.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
                        <button type="button" onClick={() => setDay(day, ranges.filter((_, j) => j !== i))} className="rounded-lg p-2 text-ink-400 hover:bg-ink-100 hover:text-red-600 dark:hover:bg-ink-800" aria-label="Remove range"><Trash2 className="size-4" /></button>
                      </div>
                    ))}
                    {on && (
                      <button type="button" onClick={() => setDay(day, [...ranges, { start: ranges.at(-1)?.end ?? '13:00', end: '17:00' }])} className="flex items-center gap-1 text-xs font-semibold text-ink-500 hover:text-ink-900 dark:hover:text-white">
                        <Plus className="size-3.5" />Add a break / second shift
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Suburbs you cover" subtitle="Pick suburbs from the suggestions so learners can find you by suburb or postcode." />
            <div className="p-5">
              <ServiceAreaEditor
                areas={areas}
                onChange={setAreas}
                disabled={readOnly}
                onUpgraded={next => {
                  setAreas(next);
                  if (readOnly) return;
                  updateDoc(doc(db, 'users', me.id), {
                    serviceAreas: next.map(a => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined))),
                    servicedSuburbs: next.map(areaLabel),
                  }).then(() => toast.success('Postcodes and map locations added to your suburbs.')).catch(() => undefined);
                }}
              />
            </div>
          </Card>
          <Card>
            <CardHeader title="Driving test locations" subtitle="Test centres you take learners to. Learners choose one when booking a test package." />
            <div className="p-5"><TestLocationsEditor value={testLocations} onChange={setTestLocations} disabled={readOnly} /></div>
          </Card>
          <Card>
            <CardHeader title="Time zone" />
            <div className="p-5">
              <Select value={timezone} onChange={e => setTimezone(e.target.value)} aria-label="Time zone">
                {AU_ZONES.map(([z, label]) => <option key={z} value={z}>{label}</option>)}
              </Select>
              <p className="mt-2 text-xs text-ink-500">All your lesson times are shown in this zone, wherever you or your learners are.</p>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
