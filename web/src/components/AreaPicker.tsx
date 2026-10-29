import { useEffect, useRef, useState } from 'react';
import { areaLabel, type ServiceArea } from '@shared/domain';
import { attachSuburbAutocomplete } from '@/lib/maps';
import { Select } from './ui';

const ANY = '';
const OTHER = '__other';

/**
 * Chooses the suburb extra open hours are limited to: one of the instructor's suburbs, another
 * suburb (e.g. near home) picked from Google suggestions, or none (any of their suburbs).
 */
export function AreaPicker({ areas, value, onChange, disabled }: {
  areas: ServiceArea[];
  value: ServiceArea | undefined;
  onChange: (area: ServiceArea | undefined) => void;
  disabled?: boolean;
}) {
  const known = (a: ServiceArea | undefined) => !!a && areas.some(x => areaLabel(x) === areaLabel(a));
  const [other, setOther] = useState(() => !!value && !known(value));
  const input = useRef<HTMLInputElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (other && input.current) attachSuburbAutocomplete(input.current, a => onChangeRef.current(a)).catch(() => undefined);
  }, [other]);

  const selected = other ? OTHER : value && known(value) ? areaLabel(value) : ANY;
  return (
    <div className="space-y-2">
      <Select label="Where" value={selected} disabled={disabled} onChange={e => {
        const v = e.target.value;
        setOther(v === OTHER);
        onChange(v === ANY || v === OTHER ? undefined : areas.find(a => areaLabel(a) === v));
      }}>
        <option value={ANY}>Any of my suburbs</option>
        {areas.map(a => <option key={areaLabel(a)} value={areaLabel(a)}>Only in {areaLabel(a)}</option>)}
        <option value={OTHER}>Only in another suburb…</option>
      </Select>
      {other && (
        <input ref={input} className="input" placeholder="Start typing a suburb, e.g. Kellyville" aria-label="Suburb" disabled={disabled}
          defaultValue={value ? areaLabel(value) : ''} />
      )}
      <p className="text-xs text-ink-500">
        {value
          ? `Only learners with a pick up in ${areaLabel(value)} can book these hours.`
          : 'Learners in any of your suburbs can book these hours.'}
      </p>
    </div>
  );
}
