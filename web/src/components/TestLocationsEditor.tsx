import { Building2, Plus, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { TestLocation } from '@shared/domain';
import { attachPlaceAutocomplete, findPlace } from '@/lib/maps';
import { Button } from './ui';

/** The driving test centres an instructor takes learners to (picked from Google places). */
export function TestLocationsEditor({ value, onChange, disabled }: { value: TestLocation[]; onChange: (next: TestLocation[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(value);
  latest.current = value;

  const add = (loc: TestLocation) => {
    if (latest.current.some(l => l.name.toLowerCase() === loc.name.toLowerCase())) return toast.info(`${loc.name} is already in your list.`);
    onChange([...latest.current, loc]);
    if (input.current) input.current.value = '';
  };

  useEffect(() => {
    if (input.current) attachPlaceAutocomplete(input.current, add).catch(() => undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-3">
      <form className="flex gap-2" onSubmit={async e => {
        e.preventDefault();
        const name = input.current?.value.trim();
        if (!name) return;
        // Typed without picking a suggestion: look up the exact address so learners see it.
        const found = await findPlace(name).catch(() => null);
        add(found ? { name, address: found.address, lat: found.lat, lng: found.lng } : { name });
      }}>
        <input ref={input} className="input" placeholder="e.g. Service NSW Blacktown" aria-label="Add test centre" disabled={disabled} />
        <Button type="submit" variant="dark" icon={<Plus className="size-4" />} disabled={disabled}>Add</Button>
      </form>
      {value.length === 0 ? <p className="text-sm text-ink-400">No test centres yet. Learners booking a test package will pick from this list.</p> : (
        <ul className="space-y-2">
          {value.map((l, i) => (
            <li key={`${l.name}-${i}`} className="flex items-start gap-2 rounded-xl bg-ink-50 p-3 text-sm dark:bg-ink-800/60">
              <Building2 className="mt-0.5 size-4 shrink-0 text-ink-400" />
              <span className="min-w-0 flex-1"><strong>{l.name}</strong>{l.address
                ? <span className="block truncate text-xs text-ink-500">{l.address}</span>
                : <span className="block text-xs text-amber-700">No address found — remove it and pick it from the suggestions so learners see the exact address.</span>}</span>
              <button type="button" disabled={disabled} onClick={() => onChange(value.filter((_, j) => j !== i))} className="rounded-full p-1 hover:bg-ink-200 dark:hover:bg-ink-700" aria-label={`Remove ${l.name}`}><X className="size-3.5" /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
