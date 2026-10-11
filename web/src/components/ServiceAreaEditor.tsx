/// <reference types="google.maps" />
import { Loader2, MapPin, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { areaLabel, type ServiceArea } from '@shared/domain';
import { attachSuburbAutocomplete, geocodeArea, loadMaps, suburbAt } from '@/lib/maps';
import { Button } from './ui';

const SAME = (a: ServiceArea, b: ServiceArea) =>
  a.name.toLowerCase() === b.name.toLowerCase() && (a.postcode ?? '') === (b.postcode ?? '');

/**
 * Edits an instructor's service suburbs with Google suggestions (so every suburb carries its postcode
 * and location) and shows them on a map. Older entries without location are looked up automatically.
 */
export function ServiceAreaEditor({ areas, onChange, onUpgraded, disabled }: {
  areas: ServiceArea[];
  onChange: (next: ServiceArea[]) => void;
  /** Called (instead of onChange) after older suburbs were located, so they can be saved straight away. */
  onUpgraded?: (next: ServiceArea[]) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [mapsReady, setMapsReady] = useState<boolean | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const latest = useRef(areas);
  latest.current = areas;

  const add = (area: ServiceArea) => {
    if (latest.current.some(a => SAME(a, area))) {
      toast.info(`${areaLabel(area)} is already in your list.`);
      return;
    }
    onChange([...latest.current, area]);
    if (input.current) input.current.value = '';
  };

  useEffect(() => {
    let cancelled = false;
    loadMaps().then(() => !cancelled && setMapsReady(true)).catch(() => !cancelled && setMapsReady(false));
    if (input.current) attachSuburbAutocomplete(input.current, add).catch(() => undefined);
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Older suburbs (saved as plain names) get their postcode and location filled in.
  useEffect(() => {
    if (!mapsReady || upgrading) return;
    const missing = areas.filter(a => a.lat === undefined);
    if (!missing.length) return;
    let cancelled = false;
    setUpgrading(true);
    (async () => {
      const next = [...areas];
      for (const a of missing) {
        const found = await geocodeArea([a.name, a.state ?? 'NSW', a.postcode].filter(Boolean).join(' '));
        if (cancelled) return;
        const i = next.indexOf(a);
        if (found && i >= 0) next[i] = { ...found, name: /^\d{4}$/.test(a.name) ? a.name : found.name };
      }
      if (!cancelled) {
        (onUpgraded ?? onChange)(next);
        setUpgrading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [mapsReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const addTyped = async () => {
    const value = input.current?.value.trim();
    if (!value) return;
    const found = mapsReady ? await geocodeArea(value) : null;
    // A bare postcode stays a postcode entry, so learners searching it still find you.
    if (found) add(/^\d{4}$/.test(value) ? { ...found, name: value, postcode: value } : found);
    else add({ name: value });
  };

  return (
    <div className="space-y-4">
      <form onSubmit={e => { e.preventDefault(); void addTyped(); }} className="flex gap-2">
        <input ref={input} placeholder="Start typing a suburb or postcode" className="input" aria-label="Add suburb" disabled={disabled} />
        <Button type="submit" variant="dark" icon={<Plus className="size-4" />} disabled={disabled}>Add</Button>
      </form>
      {mapsReady === false && <p className="text-xs text-amber-700">Suburb suggestions are unavailable right now — type “Suburb STATE postcode”, e.g. Kellyville NSW 2155.</p>}
      <div className="flex flex-wrap gap-2">
        {areas.length === 0 && <p className="text-sm text-ink-400">No suburbs yet.</p>}
        {areas.map((a, i) => (
          <span key={`${a.name}-${a.postcode}-${i}`} className="inline-flex items-center gap-1.5 rounded-full bg-ink-100 py-1 pl-3 pr-1 text-sm font-medium dark:bg-ink-800">
            <MapPin className={`size-3.5 ${a.lat !== undefined ? 'text-brand-600' : 'text-ink-400'}`} />
            {areaLabel(a)}
            <button type="button" disabled={disabled} onClick={() => onChange(areas.filter((_, j) => j !== i))} className="rounded-full p-1 hover:bg-ink-200 dark:hover:bg-ink-700" aria-label={`Remove ${a.name}`}><X className="size-3" /></button>
          </span>
        ))}
        {upgrading && <span className="inline-flex items-center gap-1.5 text-xs text-ink-500"><Loader2 className="size-3.5 animate-spin" />Adding postcodes…</span>}
      </div>
      {mapsReady && (
        <>
          <ServiceAreaMap areas={areas} onPick={disabled ? undefined : async (lat, lng) => {
            const area = await suburbAt(lat, lng);
            if (area) add(area);
            else toast.error('Couldn’t find a suburb there — try clicking closer to a town.');
          }} />
          {!disabled && <p className="text-xs text-ink-500">Tip: click the map to add the suburb you clicked on.</p>}
        </>
      )}
    </div>
  );
}

/** Map of service suburbs (yellow circles), fitted to the area covered. */
export function ServiceAreaMap({ areas, className = 'h-72', onPick }: { areas: ServiceArea[]; className?: string; onPick?: (lat: number, lng: number) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const shapes = useRef<google.maps.Circle[]>([]);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    let cancelled = false;
    loadMaps().then(g => {
      if (cancelled || !el.current) return;
      if (!map.current) {
        map.current = new g.maps.Map(el.current, {
          center: { lat: -33.75, lng: 150.9 },
          zoom: 10,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true,
          draggableCursor: onPick ? 'crosshair' : undefined,
        });
        map.current.addListener('click', (e: google.maps.MapMouseEvent) => {
          if (e.latLng && pickRef.current) pickRef.current(e.latLng.lat(), e.latLng.lng());
        });
      }
      shapes.current.forEach(s => s.setMap(null));
      const located = areas.filter(a => a.lat !== undefined && a.lng !== undefined);
      const bounds = new g.maps.LatLngBounds();
      shapes.current = located.map(a => {
        const center = { lat: a.lat!, lng: a.lng! };
        bounds.extend(center);
        return new g.maps.Circle({
          map: map.current!,
          center,
          radius: 1500,
          fillColor: '#ffc700',
          fillOpacity: 0.35,
          strokeColor: '#b38100',
          strokeWeight: 1.5,
          clickable: false, // let clicks reach the map (to add suburbs)
        });
      });
      if (located.length === 1) {
        map.current.setCenter(bounds.getCenter());
        map.current.setZoom(12);
      } else if (located.length > 1) {
        map.current.fitBounds(bounds, 40);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [areas]);

  return <div ref={el} className={`${className} w-full overflow-hidden rounded-xl border border-ink-200 dark:border-ink-700`} role="img" aria-label="Map of the suburbs you cover" />;
}
