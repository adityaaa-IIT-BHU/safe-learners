// Shared helpers for end-to-end checks against the local emulators (project demo-safelearners).
export const P = 'demo-safelearners';
export const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1';
export const FS = `http://127.0.0.1:8080/v1/projects/${P}/databases/(default)/documents`;
export const FN = `http://127.0.0.1:5001/${P}/australia-southeast1`;
export const OWNER = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
export const PASSWORD = 'password123';
export const TZ = 'Australia/Sydney';
/** Test Super Admin (local emulator only). Must be listed in SUPER_ADMIN_EMAILS for the emulator. */
export const SUPER_EMAIL = process.env.E2E_SUPER_EMAIL || 'super.admin@test.local';

export async function resetEmulators() {
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${P}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${P}/accounts`, { method: 'DELETE' });
}
export async function post(url, body, headers = { 'Content-Type': 'application/json' }) {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  return res.json();
}
export async function signUp(email, password = PASSWORD) {
  const r = await post(`${AUTH}/accounts:signUp?key=fake`, { email, password, returnSecureToken: true });
  return { uid: r.localId, token: r.idToken, email };
}
export async function signIn(email, password = PASSWORD) {
  const r = await post(`${AUTH}/accounts:signInWithPassword?key=fake`, { email, password, returnSecureToken: true });
  return r.error ? { error: r.error.message } : { uid: r.localId, token: r.idToken, email };
}
export function v(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (x instanceof Date) return { timestampValue: x.toISOString() };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(v) } };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (typeof x === 'number') return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (typeof x === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(x).map(([k, y]) => [k, v(y)])) } };
  return { stringValue: String(x) };
}
export function unv(f) {
  if (!f) return undefined;
  if ('stringValue' in f) return f.stringValue;
  if ('integerValue' in f) return Number(f.integerValue);
  if ('doubleValue' in f) return f.doubleValue;
  if ('booleanValue' in f) return f.booleanValue;
  if ('timestampValue' in f) return new Date(f.timestampValue);
  if ('nullValue' in f) return null;
  if ('arrayValue' in f) return (f.arrayValue.values ?? []).map(unv);
  if ('mapValue' in f) return Object.fromEntries(Object.entries(f.mapValue.fields ?? {}).map(([k, y]) => [k, unv(y)]));
}
export async function setDoc(path, data, mask, headers = OWNER) {
  const q = mask ? '?' + mask.map(m => `updateMask.fieldPaths=${m}`).join('&') : '';
  const res = await fetch(`${FS}/${path}${q}`, { method: 'PATCH', headers, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, y]) => [k, v(y)])) }) });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
}
export async function getDoc(path, headers = OWNER) {
  const r = await (await fetch(`${FS}/${path}`, { headers })).json();
  return r.fields ? Object.fromEntries(Object.entries(r.fields).map(([k, y]) => [k, unv(y)])) : null;
}
export async function list(path, headers = OWNER) {
  const r = await (await fetch(`${FS}/${path}?pageSize=300`, { headers })).json();
  return (r.documents ?? []).map(d => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, y]) => [k, unv(y)])) }));
}
export async function call(fn, token, data) {
  const r = await post(`${FN}/${fn}`, { data }, { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
  return r.error ? { error: r.error.message } : r.result;
}
const fmtDay = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
export const fmtTime = iso => new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)).replace(' ', '').toLowerCase();
export function at(dayKey, hhmm) {
  const probe = new Date(`${dayKey}T12:00:00Z`);
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' }).formatToParts(probe).find(p => p.type === 'timeZoneName').value;
  const hours = Number(offset.replace('GMT', '')) || 10;
  return new Date(Date.parse(`${dayKey}T${hhmm}:00Z`) - hours * 3_600_000);
}
export const dayAhead = n => fmtDay(new Date(Date.now() + n * 86_400_000));
export function checker() {
  const results = [];
  const check = (area, name, ok, detail = '') => {
    results.push({ area, name, ok: !!ok, detail: String(detail ?? '') });
    console.log(`${ok ? 'PASS' : 'FAIL'}  [${area}] ${name}${detail ? `  — ${detail}` : ''}`);
  };
  return { check, results };
}

/** Fresh emulators with an instructor (Bik), two learners, and a verified admin. */
export async function seed() {
  await resetEmulators();
  const hours = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, [{ start: '10:00', end: '18:00' }]]));
  const bik = await signUp('bik@test.local');
  const learner = await signUp('learner@test.local');
  const other = await signUp('other.learner@test.local');
  const admin = await signUp(SUPER_EMAIL);
  await fetch(`${AUTH}/projects/${P}/accounts:update`, { method: 'POST', headers: OWNER, body: JSON.stringify({ localId: admin.uid, emailVerified: true }) });
  await setDoc(`users/${bik.uid}`, {
    role: 'instructor', firstName: 'Bik', surname: 'Singh', timezone: TZ, createdAt: new Date(), verificationStatus: 'verified', transmission: 'Auto',
    pricing: { lesson: 75, testPackage: 225 }, operatingHours: hours,
    calendarSettings: { smartScheduling: true, smartGapMinutes: 60, bufferMinutes: 45, minNoticeHours: 2, maxAdvanceDays: 60, lessonTypes: ['lesson-1h', 'lesson-2h', 'test-package'] },
    serviceAreas: [
      { name: 'Blacktown', state: 'NSW', postcode: '2148', lat: -33.771, lng: 150.906 },
      { name: 'Quakers Hill', state: 'NSW', postcode: '2763', lat: -33.733, lng: 150.884 },
      { name: 'Marsden Park', state: 'NSW', postcode: '2765', lat: -33.694, lng: 150.834 },
    ],
    servicedSuburbs: ['Blacktown NSW 2148', 'Quakers Hill NSW 2763', 'Marsden Park NSW 2765'],
    testLocations: [{ name: 'Service NSW Blacktown', address: 'Shop B1-B2/14 St Martins Cres, Blacktown NSW 2148' }],
    vehicle: { make: 'Mazda', model: 'CX30', dualControls: true },
  });
  await setDoc(`users/${bik.uid}/private/profile`, { email: 'bik@test.local', mobile: '0400 000 111' });
  for (const [u, first] of [[learner, 'Safe'], [other, 'Other']]) {
    await setDoc(`users/${u.uid}`, { role: 'learner', firstName: first, surname: 'Learner', timezone: TZ, createdAt: new Date(), email: u.email, mobile: '0400000001', walletBalance: 0, instructorId: bik.uid });
    await setDoc(`users/${u.uid}/private/profile`, { email: u.email, mobile: '0400000001' });
  }
  // Admin claim is granted on the first onboarding call; sign in again to get a token carrying it.
  const a0 = await signIn(SUPER_EMAIL);
  await call('onboardUser', a0.token, {});
  const adminFresh = await signIn(SUPER_EMAIL);
  for (const u of [bik, learner, other]) await call('onboardUser', u.token, {});
  return { bik, learner: await signIn('learner@test.local'), other: await signIn('other.learner@test.local'), admin: adminFresh };
}
