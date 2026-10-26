import { doc, updateDoc } from 'firebase/firestore';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { LESSON_TYPES, LESSON_TYPE_ORDER, REQUIRED_LESSON_TYPES, calendarOf, type CalendarSettings as Settings, type LessonType } from '@shared/domain';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { Button, Card, CardHeader, PageHeader, Segmented, Select, cx } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { db } from '@/lib/firebase';

const BUFFERS = [0, 15, 30, 45, 60, 90];
const NOTICE = [1, 2, 4, 6, 12, 24, 48];
const ADVANCE = [14, 30, 45, 60, 75, 90, 120];

export function CalendarSettings() {
  const me = useProfile();
  const { readOnly } = useAuth();
  const [s, setS] = useState<Required<Settings>>(() => calendarOf(me));
  const [saving, setSaving] = useState(false);
  const update = <K extends keyof Settings>(k: K, v: Required<Settings>[K]) => setS(prev => ({ ...prev, [k]: v }));

  const toggleType = (t: LessonType) => {
    if (REQUIRED_LESSON_TYPES.includes(t)) return;
    update('lessonTypes', s.lessonTypes.includes(t) ? s.lessonTypes.filter(x => x !== t) : LESSON_TYPE_ORDER.filter(x => x === t || s.lessonTypes.includes(x)));
  };

  return (
    <>
      <PageHeader
        title="Calendar settings"
        subtitle="Control how learners can book you. Changes apply to new bookings straight away."
        actions={<Button loading={saving} disabled={readOnly} onClick={async () => {
          setSaving(true);
          try {
            await updateDoc(doc(db, 'users', me.id), { calendarSettings: s });
            toast.success('Calendar settings saved');
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setSaving(false);
          }
        }}>Save changes</Button>}
      />
      <div className="space-y-6">
        <Card>
          <CardHeader title="Lesson lengths" subtitle="Lengths learners can book. 1 hour and 2 hours are always offered." />
          <div className="grid gap-2 p-5 sm:grid-cols-3 lg:grid-cols-5">
            {LESSON_TYPE_ORDER.map(t => {
              const required = REQUIRED_LESSON_TYPES.includes(t);
              const on = s.lessonTypes.includes(t);
              return (
                <button key={t} type="button" role="checkbox" aria-checked={on} disabled={required || readOnly} onClick={() => toggleType(t)}
                  className={cx('flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-sm font-semibold transition',
                    on ? 'border-ink-950 bg-brand-50 dark:border-brand-500 dark:bg-brand-500/10' : 'border-ink-200 dark:border-ink-700',
                    required && 'opacity-70')}>
                  <span className={cx('flex size-5 shrink-0 items-center justify-center rounded-md border-2', on ? 'border-ink-950 bg-ink-950 text-brand-400 dark:border-brand-500 dark:bg-brand-500 dark:text-ink-950' : 'border-ink-300')}>
                    {on && <Check className="size-3.5" strokeWidth={3} />}
                  </span>
                  {LESSON_TYPES[t].short}
                </button>
              );
            })}
          </div>
        </Card>

        <div className="grid grid-cols-1 gap-6 [&>*]:min-w-0 lg:grid-cols-2">
          <Card>
            <CardHeader title="Travel buffer" subtitle="Time kept free between lessons to drive to the next pick up." />
            <div className="p-5">
              <Select value={s.bufferMinutes} onChange={e => update('bufferMinutes', Number(e.target.value))} aria-label="Travel buffer" disabled={readOnly}>
                {BUFFERS.map(m => <option key={m} value={m}>{m ? `${m} minutes` : 'No buffer'}</option>)}
              </Select>
              <p className="mt-2 text-xs text-ink-500">e.g. with 45 minutes, a lesson ending at 10:00 means the next one can start at 10:45 at the earliest.</p>
            </div>
          </Card>

          <Card>
            <CardHeader title="Booking window" subtitle="How soon and how far ahead learners can book." />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <Select label="Minimum notice" value={s.minNoticeHours} onChange={e => update('minNoticeHours', Number(e.target.value))} disabled={readOnly}>
                {NOTICE.map(h => <option key={h} value={h}>{h} hour{h > 1 ? 's' : ''}</option>)}
              </Select>
              <Select label="Furthest ahead" value={s.maxAdvanceDays} onChange={e => update('maxAdvanceDays', Number(e.target.value))} disabled={readOnly}>
                {ADVANCE.map(d => <option key={d} value={d}>{d} days</option>)}
              </Select>
            </div>
          </Card>

          <Card>
            <CardHeader title="Smart scheduling" subtitle="Only offer times that don’t leave short, unbookable gaps in your day." />
            <div className="space-y-4 p-5">
              <label className="flex items-center gap-3">
                <button type="button" role="switch" aria-checked={s.smartScheduling} disabled={readOnly} onClick={() => update('smartScheduling', !s.smartScheduling)}
                  className={cx('relative h-6 w-11 rounded-full transition', s.smartScheduling ? 'bg-ink-950 dark:bg-brand-500' : 'bg-ink-200 dark:bg-ink-700')}>
                  <span className={cx('absolute top-0.5 size-5 rounded-full bg-white shadow transition', s.smartScheduling ? 'left-[22px]' : 'left-0.5')} />
                </button>
                <span className="font-semibold">{s.smartScheduling ? 'On' : 'Off'}</span>
              </label>
              {s.smartScheduling && (
                <div>
                  <p className="mb-2 text-sm text-ink-600 dark:text-ink-300">Avoid gaps shorter than:</p>
                  <Segmented value={String(s.smartGapMinutes)} onChange={v => update('smartGapMinutes', Number(v))}
                    options={[{ value: '60', label: '1 hour' }, { value: '120', label: '2 hours' }]} className="max-w-xs [&_button]:text-center" />
                </div>
              )}
              <p className="text-xs text-ink-500">Example: you have a lesson 12–1pm. Without smart scheduling a learner could book 1:30pm, leaving a 30 minute gap after your lesson that nobody can book. With it on, they’re offered 1pm (or a time that leaves at least the gap above). Times at the start and end of your day are always offered, so quiet days stay fully bookable.</p>
            </div>
          </Card>

          <Card>
            <CardHeader title="Default calendar view" subtitle="On phones the calendar always opens in day view." />
            <div className="p-5">
              <Segmented value={s.defaultView} onChange={v => update('defaultView', v)} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} className="max-w-sm [&_button]:text-center" />
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
