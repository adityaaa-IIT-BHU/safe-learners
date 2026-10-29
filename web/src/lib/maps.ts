/// <reference types="google.maps" />
import type { PlaceInput, ServiceArea } from '@shared/domain';

// The client's Google Maps key (browser key, restricted to the site's domains in Google Cloud).
const MAPS_KEY = 'AIzaSyCnR1zekmfJ04AnY4FeJUVRGildidvU0rg';

let loading: Promise<typeof google> | null = null;
let authFailed = false;
const authFailureListeners = new Set<() => void>();

/** Calls `cb` if Google rejects the key (it can do so after loading); returns an unsubscribe. */
export function onMapsUnavailable(cb: () => void): () => void {
  if (authFailed) cb();
  authFailureListeners.add(cb);
  return () => authFailureListeners.delete(cb);
}

/** Loads the Maps JavaScript API (with Places) once, on the pages that need it. */
export function loadMaps(): Promise<typeof google> {
  if (typeof window !== 'undefined' && window.google?.maps?.places) return Promise.resolve(window.google);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const callback = `__slMapsReady${Date.now()}`;
    (window as unknown as Record<string, () => void>)[callback] = () => resolve(window.google);
    (window as unknown as Record<string, () => void>).gm_authFailure = () => {
      authFailed = true;
      authFailureListeners.forEach(f => f());
      reject(new Error('Google Maps key was rejected'));
    };
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${MAPS_KEY}&libraries=places&loading=async&callback=${callback}&region=AU`;
    script.async = true;
    script.onerror = () => { loading = null; reject(new Error('Google Maps failed to load')); };
    document.head.appendChild(script);
  });
  return loading;
}

function component(place: google.maps.places.PlaceResult | google.maps.GeocoderResult, type: string, short = false) {
  const c = place.address_components?.find(x => x.types.includes(type));
  return c ? (short ? c.short_name : c.long_name) : undefined;
}

/** A suburb (or postcode area) picked from Google, with postcode and location. */
export function placeToArea(place: google.maps.places.PlaceResult | google.maps.GeocoderResult): ServiceArea | null {
  const loc = place.geometry?.location;
  const postcode = component(place, 'postal_code');
  const name = component(place, 'locality') ?? ('name' in place ? place.name : undefined) ?? postcode;
  if (!name) return null;
  return {
    name,
    state: component(place, 'administrative_area_level_1', true),
    postcode,
    ...(loc ? { lat: Math.round(loc.lat() * 1e5) / 1e5, lng: Math.round(loc.lng() * 1e5) / 1e5 } : {}),
  };
}

/** A searched suburb or postcode; `localities` lists every suburb sharing the postcode. */
export type LocatedArea = ServiceArea & { localities?: string[] };

/** Finds a suburb or postcode in Australia; null if Google can't place it. */
export async function geocodeArea(query: string): Promise<LocatedArea | null> {
  const g = await loadMaps();
  const geocoder = new g.maps.Geocoder();
  try {
    const { results } = await geocoder.geocode({ address: `${query.trim()}, Australia`, componentRestrictions: { country: 'AU' } });
    const area = results[0] ? placeToArea(results[0]) : null;
    if (!area) return null;
    // Postcode results name one suburb but list all of them here (e.g. 2762: Schofields, Colebee).
    const localities = results[0].postcode_localities?.filter(Boolean);
    return localities?.length ? { ...area, localities } : area;
  } catch {
    return null;
  }
}

/** Attaches Google street-address suggestions to a text input; `onPick` gets the chosen address and its location. */
export async function attachAddressAutocomplete(input: HTMLInputElement, onPick: (place: PlaceInput) => void) {
  const g = await loadMaps();
  const ac = new g.maps.places.Autocomplete(input, {
    types: ['address'],
    componentRestrictions: { country: 'au' },
    fields: ['formatted_address', 'geometry'],
  });
  ac.addListener('place_changed', () => {
    const p = ac.getPlace();
    const address = p?.formatted_address?.replace(/,\s*Australia$/, '');
    const loc = p?.geometry?.location;
    if (address) onPick({ address, ...(loc ? { lat: loc.lat(), lng: loc.lng() } : {}) });
  });
  return ac;
}

/** Looks up a typed place name (e.g. "Service NSW Blacktown") to get its full address and location. */
export async function findPlace(query: string): Promise<{ address: string; lat: number; lng: number } | null> {
  const g = await loadMaps();
  try {
    const { results } = await new g.maps.Geocoder().geocode({ address: `${query.trim()}, Australia`, componentRestrictions: { country: 'AU' } });
    const r = results[0];
    if (!r?.formatted_address) return null;
    return { address: r.formatted_address.replace(/,\s*Australia$/, ''), lat: r.geometry.location.lat(), lng: r.geometry.location.lng() };
  } catch {
    return null;
  }
}

/** Attaches Google suburb suggestions to a text input. */
export async function attachSuburbAutocomplete(input: HTMLInputElement, onPick: (area: ServiceArea) => void) {
  const g = await loadMaps();
  const ac = new g.maps.places.Autocomplete(input, {
    types: ['(regions)'],
    componentRestrictions: { country: 'au' },
    fields: ['address_components', 'geometry', 'name'],
  });
  ac.addListener('place_changed', () => {
    const area = placeToArea(ac.getPlace());
    if (area) onPick(area);
  });
  return ac;
}

/** Attaches Google place suggestions (e.g. "Service NSW Blacktown") to a text input. */
export async function attachPlaceAutocomplete(input: HTMLInputElement, onPick: (place: { name: string; address?: string; lat?: number; lng?: number }) => void) {
  const g = await loadMaps();
  const ac = new g.maps.places.Autocomplete(input, {
    types: ['establishment'],
    componentRestrictions: { country: 'au' },
    fields: ['name', 'formatted_address', 'geometry'],
  });
  ac.addListener('place_changed', () => {
    const p = ac.getPlace();
    if (!p?.name) return;
    const loc = p.geometry?.location;
    onPick({ name: p.name, address: p.formatted_address, ...(loc ? { lat: loc.lat(), lng: loc.lng() } : {}) });
  });
  return ac;
}

/** The suburb at a point on the map (reverse geocoding). */
export async function suburbAt(lat: number, lng: number): Promise<ServiceArea | null> {
  const g = await loadMaps();
  try {
    const { results } = await new g.maps.Geocoder().geocode({ location: { lat, lng } });
    const locality = results.find(r => r.types.includes('locality')) ?? results.find(r => r.address_components?.some(c => c.types.includes('locality')));
    if (!locality) return null;
    const area = placeToArea(locality);
    // Centre on the suburb, not the exact click.
    return area ? { ...area, ...(locality.types.includes('locality') ? {} : { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5 }) } : null;
  } catch {
    return null;
  }
}
