import { MapPin, Plus, X } from 'lucide-react';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { toast } from 'sonner';
import { areaLabel, areasOrList, parseAreaString, type ServiceArea } from '@shared/domain';
import { attachSuburbAutocomplete, geocodeArea } from '@/lib/maps';
import { Button, Select } from './ui';

const ANY = '';
const OTHER = '__other';
const SAME = (a: ServiceArea, b: ServiceArea) => areaLabel(a).toLowerCase() === areaLabel(b).toLowerCase();

export interface AreaPickerHandle {
  /** Adds a suburb still typed in the box; resolves to the final suburbs, or null when it can't be found. */
  commit: () => Promise<ServiceArea[] | null>;
}

/** Looks up a typed suburb (or postcode). Only a match for what was typed counts, so a typo is never saved as another suburb. */
async function findSuburb(typed: string): Promise<ServiceArea | null> {
  const found = await geocodeArea(typed).catch(() => null);
  if (!found) return null;
  if (/^\d{4}$/.test(typed)) return found;
  const name = parseAreaString(typed).name.toLowerCase();
  const names = [found.name, ...(found.localities ?? [])].map(n => n.toLowerCase());
  if (!names.includes(name)) return null;
  const { localities: _, ...area } = found;
  return area;
}

/**
 * Chooses the suburbs extra open hours are limited to: one of the instructor's suburbs, other
 * suburbs (e.g. a few near home) picked from Google suggestions, or none (any of their suburbs).
 * `onChange` gets the chosen suburbs and whether the choice can be saved (other suburbs needs one chosen or typed).
 */
export function AreaPicker({ areas, value, onChange, disabled, ref }: {
  areas: ServiceArea[];
  value: ServiceArea[];
  onChange: (areas: ServiceArea[], complete: boolean) => void;
  disabled?: boolean;
  ref?: Ref<AreaPickerHandle>;
}) {
  const known = (a: ServiceArea | undefined) => !!a && areas.some(x => SAME(x, a));
  const [other, setOther] = useState(() => value.length > 1 || (value.length === 1 && !known(value[0])));
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [looking, setLooking] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };

  const clearInput = () => {
    if (input.current) input.current.value = '';
    setTyped('');
    setError('');
  };

  /** Adds a suburb and returns the new list. */
  const add = (area: ServiceArea): ServiceArea[] => {
    const { value: current, onChange: change } = latest.current;
    clearInput();
    if (current.some(a => SAME(a, area))) {
      toast.info(`${areaLabel(area)} is already chosen.`);
      return current;
    }
    const next = [...current, area];
    change(next, true);
    return next;
  };

  useEffect(() => {
    if (other && input.current) attachSuburbAutocomplete(input.current, add).catch(() => undefined);
  }, [other]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Looks up what's typed and adds it; null (with a message by the box) when it isn't a suburb. */
  const addTyped = async (): Promise<ServiceArea[] | null> => {
    const text = input.current?.value.trim() ?? '';
    if (!text) return latest.current.value;
    setLooking(true);
    const found = await findSuburb(text);
    setLooking(false);
    if (found) return add(found);
    setError(`Couldn’t find ${text} — pick it from the suggestions.`);
    return null;
  };

  useImperativeHandle(ref, () => ({
    commit: async () => {
      if (!other) return latest.current.value;
      const next = await addTyped();
      if (next && !next.length) {
        setError('Add at least one suburb, or choose Any of my suburbs.');
        return null;
      }
      return next;
    },
  }));

  const remove = (i: number) => {
    const next = value.filter((_, j) => j !== i);
    onChange(next, next.length > 0 || !!typed.trim());
  };

  const selected = other ? OTHER : value.length === 1 && known(value[0]) ? areaLabel(value[0]) : ANY;
  return (
    <div className="space-y-2">
      <Select label="Where" value={selected} disabled={disabled} onChange={e => {
        const v = e.target.value;
        setOther(v === OTHER);
        clearInput();
        if (v === OTHER) onChange([], false);
        else onChange(v === ANY ? [] : areas.filter(a => areaLabel(a) === v), true);
      }}>
        <option value={ANY}>Any of my suburbs</option>
        {areas.map(a => <option key={areaLabel(a)} value={areaLabel(a)}>Only in {areaLabel(a)}</option>)}
        <option value={OTHER}>Only in other suburbs…</option>
      </Select>
      {other && (
        <>
          <div className="flex gap-2">
            <input ref={input} className={`input ${error ? 'border-red-400' : ''}`} placeholder="Start typing a suburb, e.g. Kellyville" aria-label="Add suburb" disabled={disabled}
              onChange={e => {
                setTyped(e.target.value);
                setError('');
                onChange(value, value.length > 0 || !!e.target.value.trim());
              }}
              // A highlighted suggestion is added by Google's own handler first; this only catches plain typed text.
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); setTimeout(() => void addTyped(), 300); } }} />
            <Button type="button" variant="dark" icon={<Plus className="size-4" />} loading={looking} disabled={disabled || !typed.trim()} onClick={() => void addTyped()}>Add</Button>
          </div>
          {error && <p className="text-xs font-medium text-red-600">{error}</p>}
          {value.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {value.map((a, i) => (
                <span key={`${areaLabel(a)}-${i}`} className="inline-flex items-center gap-1.5 rounded-full bg-ink-100 py-1 pl-3 pr-1 text-sm font-medium dark:bg-ink-800">
                  <MapPin className="size-3.5 text-brand-600" />
                  {areaLabel(a)}
                  <button type="button" disabled={disabled} onClick={() => remove(i)} className="rounded-full p-1 hover:bg-ink-200 dark:hover:bg-ink-700" aria-label={`Remove ${a.name}`}><X className="size-3" /></button>
                </span>
              ))}
            </div>
          )}
        </>
      )}
      <p className={`text-xs ${other && !value.length ? 'text-amber-700 dark:text-amber-400' : 'text-ink-500'}`}>
        {value.length
          ? `Only learners with a pick up in ${value.length === 1 ? areaLabel(value[0]) : areasOrList(value)} can book these hours.`
          : other
            ? 'Add one or more suburbs.'
            : 'Learners in any of your suburbs can book these hours.'}
      </p>
    </div>
  );
}
