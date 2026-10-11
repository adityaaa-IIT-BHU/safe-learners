/// <reference types="google.maps" />
import type { ServiceArea } from '@shared/domain';

// The client's Google Maps key (browser key, restricted to the site's domains in Google Cloud).
const MAPS_KEY = 'AIzaSyCnR1zekmfJ04AnY4FeJUVRGildidvU0rg';

let loading: Promise<typeof google> | null = null;

/** Loads the Maps JavaScript API (with Places) once, on the pages that need it. */
export function loadMaps(): Promise<typeof google> {
  if (typeof window !== 'undefined' && window.google?.maps?.places) return Promise.resolve(window.google);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const callback = `__slMapsReady${Date.now()}`;
    (window as unknown as Record<string, () => void>)[callback] = () => resolve(window.google);
    (window as unknown as Record<string, () => void>).gm_authFailure = () => reject(new Error('Google Maps key was rejected'));
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

/** Finds a suburb or postcode in Australia; null if Google can't place it. */
export async function geocodeArea(query: string): Promise<ServiceArea | null> {
  const g = await loadMaps();
  const geocoder = new g.maps.Geocoder();
  const address = /^\d{4}$/.test(query.trim()) ? `${query.trim()}, Australia` : `${query.trim()}, Australia`;
  try {
    const { results } = await geocoder.geocode({ address, componentRestrictions: { country: 'AU' } });
    return results[0] ? placeToArea(results[0]) : null;
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
