/// <reference types="google.maps" />
import { useEffect, useRef, useState } from 'react';
import {
  addressArea,
  areaLabel,
  areasSummary,
  isPlausibleAddress,
  placeInAreas,
  serviceAreasOf,
  type PlaceInput,
  type ServiceArea,
  type UserProfile,
} from '@shared/domain';
import { attachAddressAutocomplete, onMapsUnavailable } from '@/lib/maps';
import { Input } from './ui';

/** An address field: `valid` once picked from Google's suggestions (or, if Maps is unavailable, when it looks like a real address). */
export interface AddressValue {
  text: string;
  valid: boolean;
  lat?: number;
  lng?: number;
}

export const EMPTY_ADDRESS: AddressValue = { text: '', valid: false };

/** The address as sent to the server (coordinates only when Google supplied them). */
export function placeOf(value: AddressValue): PlaceInput {
  return { address: value.text.trim(), ...(value.lat !== undefined && value.lng !== undefined ? { lat: value.lat, lng: value.lng } : {}) };
}

/**
 * Why this address can't be used with this instructor, or null when it's fine (or not picked yet).
 * Mirrors the server check: the instructor's suburbs, plus suburbs they've opened extra hours in.
 */
export function areaProblem(instructor: UserProfile, value: AddressValue, extraAreas: ServiceArea[], role: 'pick up' | 'drop off'): string | null {
  const areas = serviceAreasOf(instructor);
  if (!value.valid || !areas.length) return null;
  if (placeInAreas(placeOf(value), [...areas, ...extraAreas])) return null;
  const where = areaLabel(addressArea(value.text));
  return `${instructor.firstName} doesn’t ${role} in ${where || 'that suburb'}. Choose an address in ${areasSummary(areas)}${extraAreas.length ? ` or ${areasSummary(extraAreas, 2)}` : ''}.`;
}

/**
 * Address input with Google suggestions. Typing clears the picked address until a suggestion is chosen.
 * `areaError` explains why a picked address can't be used (e.g. outside the instructor's suburbs).
 */
export function AddressInput({ label, placeholder, hint, value, onChange, className, areaError, requireSuggestion = true }: {
  label: string;
  placeholder: string;
  hint?: React.ReactNode;
  value: AddressValue;
  onChange: (value: AddressValue) => void;
  className?: string;
  areaError?: string | null;
  /** Instructors may also type a suburb name; learners must pick a full address. */
  requireSuggestion?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [mapsDown, setMapsDown] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lenient = mapsDown || !requireSuggestion;

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    let ac: google.maps.places.Autocomplete | undefined;
    let cancelled = false;
    attachAddressAutocomplete(input, place => onChangeRef.current({ text: place.address, valid: true, lat: place.lat, lng: place.lng }))
      .then(a => { if (cancelled) google.maps.event.clearInstanceListeners(a); else ac = a; })
      .catch(() => !cancelled && setMapsDown(true));
    const unsubscribe = onMapsUnavailable(() => setMapsDown(true));
    return () => {
      cancelled = true;
      unsubscribe();
      if (ac) google.maps.event.clearInstanceListeners(ac);
    };
  }, []);

  // Without Google, fall back to a basic check of what was typed.
  useEffect(() => {
    if (mapsDown && value.text && value.lat === undefined && value.valid !== isPlausibleAddress(value.text)) {
      onChangeRef.current({ text: value.text, valid: isPlausibleAddress(value.text) });
    }
  }, [mapsDown, value]);

  const typedOk = (text: string) => (requireSuggestion ? isPlausibleAddress(text) : text.trim().length > 2);
  const showError = value.text.trim().length > 0 && !value.valid;
  const error = showError
    ? (lenient ? 'Enter the full street address, e.g. 12 Windsor Rd, Kellyville NSW 2155.' : 'Choose your address from the suggestions list.')
    : value.valid ? areaError ?? undefined : undefined;
  return (
    <Input
      ref={ref}
      label={label}
      placeholder={placeholder}
      autoComplete="off"
      value={value.text}
      onChange={e => onChange({ text: e.target.value, valid: lenient && typedOk(e.target.value) })}
      wrapperClassName={className}
      hint={hint}
      error={error}
    />
  );
}
