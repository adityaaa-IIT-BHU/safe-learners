// End-to-end test of instructor document verification on the local emulators, with real OCR on
// synthetic SPECIMEN documents and dummy instructor accounts. Covers uploads, OCR, type detection,
// extraction, comparison, quality, duplicates, risk, admin actions, versions, pause/resume controls,
// queue recovery, retries, expiry reminders (simulated dates), eligibility, test mode and security.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { FS, OWNER, P, TZ, call, checker, getDoc, list, seed, setDoc, signIn, signUp, at, dayAhead } from '../lib.mjs';

const { check, results } = checker();
const SPEC = new URL('./specimens/', import.meta.url);
const BUCKET = 'australiadrivingproj.firebasestorage.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 60000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn().catch(() => null); if (v) return v; await sleep(700); } return v; };
const vId = n => `v${String(n).padStart(3, '0')}`;

// ---------- Setup: fresh emulators, admin, dummy instructors ----------
const s0 = await seed();
let admin = s0.admin;
const hours = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, [{ start: '09:00', end: '18:00' }]]));
async function instructor(email, first, surname, dob, test) {
  const u = await signUp(email);
  await setDoc(`users/${u.uid}`, { role: 'instructor', firstName: first, surname, timezone: TZ, createdAt: new Date(), verificationStatus: 'verified', transmission: 'Auto', pricing: { lesson: 75, testPackage: 225 }, operatingHours: hours,
    calendarSettings: { smartScheduling: false, bufferMinutes: 0, minNoticeHours: 1, maxAdvanceDays: 90, lessonTypes: ['lesson-1h'] },
    serviceAreas: [{ name: 'Blacktown', state: 'NSW', postcode: '2148', lat: -33.771, lng: 150.906 }], servicedSuburbs: ['Blacktown NSW 2148'] });
  await setDoc(`users/${u.uid}/private/profile`, { email, mobile: '0400 000 222', dob });
  await call('onboardUser', u.token, {});
  const fresh = await signIn(email);
  if (test) await call('setTestAccount', admin.token, { uid: fresh.uid, testAccount: true });
  return fresh;
}
const taylor = await instructor('taylor.demo@test.local', 'Taylor', 'Morgan', '1988-04-12', true);
const jordan = await instructor('jordan.demo@test.local', 'Jordan', 'Lee', '1991-09-03', true);
const riley = await instructor('riley.real@test.local', 'Riley', 'Real', '1985-01-01', false);
check('Setup', 'Dummy instructors created; two marked as test accounts', (await getDoc(`users/${taylor.uid}`)).testAccount === true && !(await getDoc(`users/${riley.uid}`)).testAccount);
const settings0 = await call('documentUsage', admin.token, {});
check('Setup', 'Admin can read OCR usage', typeof settings0.pages === 'number', JSON.stringify(settings0));

// ---------- Helpers ----------
async function storageUpload(user, path, file, contentType) {
  const body = readFileSync(new URL(file, SPEC));
  const r = await fetch(`http://127.0.0.1:9199/v0/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(path)}`, { method: 'POST', headers: { Authorization: `Firebase ${user.token}`, 'Content-Type': contentType }, body });
  return r.status;
}
const ctype = f => (f.endsWith('.pdf') ? 'application/pdf' : f.endsWith('.jpg') ? 'image/jpeg' : f.endsWith('.gif') ? 'image/gif' : 'image/png');
let seq = 0;
async function upload(user, type, files, entered = {}) {
  const list_ = [];
  for (const [i, f] of files.entries()) {
    const path = `verification-documents/${user.uid}/${type}/${Date.now()}-${seq++}-${i ? 'back' : 'front'}.${f.split('.').pop()}`;
    const st = await storageUpload(user, path, f, ctype(f));
    if (st !== 200) return { error: `storage ${st}` };
    list_.push({ path, name: f, contentType: ctype(f), side: i ? 'back' : 'front' });
  }
  return call('uploadDocumentVersion', user.token, { type, files: list_, ...entered });
}
const version = (docId, n) => getDoc(`instructorDocuments/${docId}/versions/${vId(n)}`);
const review = (docId, n) => getDoc(`instructorDocuments/${docId}/versions/${vId(n)}/admin/review`);
const job = (docId, n) => getDoc(`documentJobs/${docId}__${vId(n)}`);
const settled = (docId, n, statuses = ['pending_verification', 'manual_verification', 'processing_failed', 'awaiting_ocr', 'processing_paused']) =>
  until(async () => { const v = await version(docId, n); return v && statuses.includes(v.status) ? v : null; });
const usage = async () => (await call('documentUsage', admin.token, {})).pages;
const auditFor = async docId => (await list('documentAudit')).filter(a => a.docId === docId);
const saveSettings = (patch, reason = 'e2e test') => call('saveDocumentSettings', admin.token, { settings: patch, reason });
const decide = (docId, n, action, reason) => call('decideDocument', admin.token, { docId, version: n, action, reason });
const T = (type, who = taylor) => `${who.uid}__${type}`;

// ---------- 1. Upload and OCR: each type ----------
let r = await upload(taylor, 'driverLicence', ['licence_front.png', 'licence_back.png'], { number: '18845502', expiry: '2029-08-15', state: 'NSW' });
check('Upload', 'Licence (front and back) accepted as version 1', r.version === 1 && r.docId === T('driverLicence'), JSON.stringify(r));
let v = await settled(T('driverLicence'), 1);
check('OCR', 'Licence processed automatically and handed to an admin (not verified)', v?.status === 'pending_verification', v?.status);
check('Type', 'Driver licence identified', v?.detected?.type === 'driverLicence' && v.detected.certainty === 'confident');
check('Extract', 'Name, number, date of birth, expiry, class and state extracted', v?.fields?.fullName?.value === 'TAYLOR JAMIE MORGAN' && v.fields.number?.value === '18845502' && v.fields.dateOfBirth?.value === '1988-04-12' && v.fields.expiryDate?.value === '2029-08-15' && v.fields.licenceClass?.value === 'C' && v.fields.state?.value === 'NSW',
  JSON.stringify(Object.fromEntries(Object.entries(v?.fields ?? {}).map(([k, f]) => [k, f.value]))));
check('Extract', 'Each field stores value, method, OCR confidence, page and review status', ['value', 'method', 'confidence', 'band', 'page', 'review'].every(k => k in (v?.fields?.number ?? {})) && v.fields.number.band === 'high');
let rv = await review(T('driverLicence'), 1);
check('Compare', 'Profile comparison: all match', rv?.comparison?.length >= 4 && rv.comparison.every(x => x.status === 'match'), JSON.stringify(rv?.comparison?.map(x => `${x.field}:${x.status}`)));
check('Trust', 'Trust levels kept apart (extracted yes, reviewed/confirmed no)', v?.trust?.extracted === true && v.trust.reviewed === false && v.trust.confirmed === false);
check('Queue', 'Job finished once', (await job(T('driverLicence'), 1))?.status === 'done');
const a1 = (await auditFor(T('driverLicence'))).map(a => a.action);
check('Audit', 'Upload, OCR started/completed and processing recorded', ['document_uploaded', 'ocr_started', 'ocr_completed', 'processing_completed'].every(x => a1.includes(x)), a1.join(','));
const pagesAfterFirst = await usage();
check('Usage', 'OCR pages counted', pagesAfterFirst >= 2, pagesAfterFirst);

const types = [
  ['instructorLicence', ['instructor_licence.png'], { number: 'DI445566', expiry: '2027-06-30', state: 'NSW' }],
  ['wwc', ['wwc.png'], { number: 'WWC1234567E', expiry: '2026-12-20', state: 'NSW' }],
  ['firstAid', ['first_aid.pdf'], { number: 'FA-778899', expiry: '2028-03-05' }],
  ['insurance', ['insurance.pdf'], { number: 'PL20260011', expiry: '2027-07-01' }],
  ['identity', ['passport.png'], { number: 'PA1234567', expiry: '2033-02-09' }],
  ['vehicleRego', ['rego.png'], { number: 'DEMO1X', expiry: '2027-02-28' }],
];
for (const [type, files, entered] of types) {
  r = await upload(taylor, type, files, entered);
  v = await settled(T(type), 1);
  check('Types', `${type}: identified and extracted`, v?.detected?.type === type && v.detected.certainty === 'confident' && Object.keys(v.fields ?? {}).length >= 3 && !(v.missingFields ?? []).length,
    `${v?.status} ${v?.detected?.type} missing=${(v?.missingFields ?? []).join(',')}`);
}
v = await version(T('firstAid'), 1);
check('PDF', 'Three-page PDF read (3 pages)', v?.processing?.pages === 3, v?.processing?.pages);
rv = await review(T('wwc'), 1);
check('QR', 'WWC verification QR read and recognised as a government address (not visited)', rv?.qr?.[0]?.official === true && /ocg\.nsw\.gov\.au/.test(rv.qr[0].host));

r = await upload(taylor, 'other', ['unknown.png'], {});
v = await settled(T('other'), 1);
check('Type', 'Unrecognised document: Manual document type verification required', v?.status === 'manual_verification' && v.reviewReasons?.includes('Manual document type verification required'), v?.reviewReasons?.join('|'));

// ---------- 2. Wrong category, mismatch, quality ----------
r = await upload(jordan, 'wwc', ['passport.png'], { number: 'PA1234567', expiry: '2033-02-09', state: 'NSW' });
v = await settled(T('wwc', jordan), 1);
rv = await review(T('wwc', jordan), 1);
check('Type', 'Passport uploaded as WWC: flagged for manual verification as a type mismatch', v?.status === 'manual_verification' && rv?.risks?.some(x => x.code === 'type_mismatch'), v?.reviewReasons?.join('|'));
r = await call('changeDocumentCategory', admin.token, { docId: T('wwc', jordan), version: 1, newType: 'identity', reason: 'Uploaded in the wrong slot' });
check('Admin', 'Admin moves it to Identity document', r.docId === T('identity', jordan) && r.version === 1, JSON.stringify(r));
v = await settled(T('identity', jordan), 1);
check('Admin', 'Moved version processed as its new type; original marked moved', v?.detected?.type === 'identity' && (await version(T('wwc', jordan), 1)).status === 'moved');

r = await upload(taylor, 'driverLicence', ['licence_mismatch.png'], { number: '18845502', expiry: '2029-08-15', state: 'NSW' });
v = await settled(T('driverLicence'), 2);
rv = await review(T('driverLicence'), 2);
const st = f => rv?.comparison?.find(x => x.field === f)?.status;
check('Compare', 'Different name, date of birth and number flagged as mismatches; profile not overwritten', v?.status === 'manual_verification' && st('name') === 'mismatch' && st('dateOfBirth') === 'mismatch' && st('number') === 'mismatch' && (await getDoc(`users/${taylor.uid}`)).firstName === 'Taylor',
  rv?.comparison?.map(x => `${x.field}:${x.status}`).join(','));

for (const [file, code] of [['licence_blurry.png', 'blurry'], ['licence_glare.png', 'glare'], ['licence_cropped.png', 'cropped']]) {
  r = await upload(jordan, 'driverLicence', [file], { number: '18845502', expiry: '2029-08-15', state: 'NSW' });
  v = await settled(T('driverLicence', jordan), r.version);
  check('Quality', `${code} photo: quality issue shown to the instructor`, v?.quality?.issues?.some(q => q.code === code) && /^Document quality issue/.test(v.instructorMessage ?? ''), (v?.quality?.issues ?? []).map(q => q.code).join(','));
}
r = await upload(taylor, 'insurance', ['corrupt.pdf'], { number: 'X1234', expiry: '2027-07-01' });
check('Quality', 'Corrupted PDF refused at upload with a clear message', /damaged/.test(r.error ?? ''), r.error);
r = await upload(taylor, 'insurance', ['insurance_protected.pdf'], { number: 'PL20260011', expiry: '2027-07-01' });
check('Quality', 'Password-protected PDF refused with a clear message', /password/.test(r.error ?? ''), r.error);
writeFileSync(new URL('./specimens/tiny.gif', import.meta.url), Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'));
r = await upload(taylor, 'insurance', ['tiny.gif'], { number: 'PL20260011', expiry: '2027-07-01' });
check('Quality', 'Unsupported format (GIF) refused by storage rules', /storage 4\d\d/.test(r.error ?? ''), r.error);

// ---------- 3. Duplicates and risk ----------
r = await upload(jordan, 'driverLicence', ['licence_front.png'], { number: '18845502', expiry: '2029-08-15', state: 'NSW' });
v = await settled(T('driverLicence', jordan), r.version);
rv = await review(T('driverLicence', jordan), r.version);
check('Duplicates', 'Level 1: identical file from another instructor, flagged high', rv?.duplicates?.some(d => d.level === 1 && !d.sameInstructor && d.instructorName === 'Taylor Morgan') && rv.risks?.some(x => x.code === 'cross_instructor_file' && x.severity === 'high'));
check('Duplicates', 'Level 3: same licence number on another instructor', rv?.duplicates?.some(d => d.level === 3));
check('Duplicates', 'Not rejected automatically: waits for an admin', v?.status === 'manual_verification');
r = await upload(taylor, 'driverLicence', ['licence_front_resized.jpg'], { number: '18845502', expiry: '2029-08-15', state: 'NSW' });
rv = await (async () => { await settled(T('driverLicence'), r.version); return review(T('driverLicence'), r.version); })();
check('Duplicates', 'Level 2: same number as an earlier version (normal renewal)', rv?.duplicates?.some(d => d.level === 2 && d.sameInstructor));
check('Duplicates', 'Level 4: resized, re-compressed copy recognised as very similar', rv?.duplicates?.some(d => d.level === 4), rv?.duplicates?.map(d => d.level).join(','));
r = await upload(taylor, 'driverLicence', ['licence_altered.png'], { number: '18845502', expiry: '2031-08-15', state: 'NSW' });
await settled(T('driverLicence'), r.version);
rv = await review(T('driverLicence'), r.version);
check('Risk', 'Altered-looking expiry (different text size) flagged', rv?.risks?.some(x => x.code === 'text_size'), rv?.risks?.map(x => x.code).join(','));
r = await upload(jordan, 'insurance', ['insurance_edited_meta.pdf'], { number: 'PL20260011', expiry: '2027-07-01' });
await settled(T('insurance', jordan), 1);
rv = await review(T('insurance', jordan), 1);
check('Risk', 'Editing software in file metadata flagged', rv?.risks?.some(x => x.code === 'edited_metadata'));
check('Risk', 'Cross-instructor policy number flagged', rv?.risks?.some(x => x.code === 'cross_instructor_number'));
r = await upload(jordan, 'wwc', ['wwc_badqr.png'], { number: 'WWC7654321A', expiry: '2030-12-20', state: 'NSW' });
await settled(T('wwc', jordan), r.version);
rv = await review(T('wwc', jordan), r.version);
check('Risk', 'QR pointing to a link shortener flagged (link not visited)', rv?.risks?.some(x => x.code === 'qr_destination') && rv.qr?.[0]?.host === 'bit.ly');

// ---------- 4. Admin verification ----------
r = await decide(T('driverLicence'), 1, 'reject', '');
check('Admin', 'Rejection without a reason is refused', /reason/i.test(r.error ?? ''), r.error);
r = await call('correctDocumentFields', admin.token, { docId: T('instructorLicence'), version: 1, corrections: { expiryDate: '30/06/2027' }, note: 'Checked against the card' });
check('Admin', 'Admin corrects an extracted field (original OCR value kept)', r.ok && (await version(T('instructorLicence'), 1)).fields.expiryDate.correctedValue === '2027-06-30' && (await version(T('instructorLicence'), 1)).fields.expiryDate.value === '2027-06-30');
for (const t of ['driverLicence', 'instructorLicence', 'wwc', 'vehicleRego']) {
  const n = t === 'driverLicence' ? 1 : 1;
  r = await decide(T(t), n, 'approve');
  check('Admin', `Approve ${t} (version ${n})`, r.status === 'verified', r.error);
}
let parent = await getDoc(`instructorDocuments/${T('driverLicence')}`);
check('Versions', 'Approving version 1 keeps later uploads separate; v1 is the verified version', parent.verifiedVersion === 1 && parent.latestVersion >= 4 && parent.verifiedExpiry === '2029-08-15');
v = await version(T('driverLicence'), 1);
check('Trust', 'Approved: reviewed, fields confirmed, decision recorded with admin', v.trust.reviewed === true && v.fields.number.review === 'confirmed' && v.decision.byName);
r = await decide(T('driverLicence'), 2, 'correction', 'The name on this licence does not match your profile.');
check('Admin', 'Request correction (reason shown to instructor)', r.status === 'needs_correction');
r = await decide(T('firstAid'), 1, 'reupload', 'Please upload page 1 only, clearer.');
check('Admin', 'Request re-upload', r.status === 'reupload_required');
r = await decide(T('identity'), 1, 'manual', 'Check the passport with the issuer');
check('Admin', 'Mark for manual verification', r.status === 'manual_verification', r.error ?? r.status);
r = await call('addDocumentNote', admin.token, { docId: T('insurance', jordan), version: 1, text: 'Called insurer: policy belongs to Taylor Morgan, not Jordan.' });
check('Admin', 'Internal note added', r.ok && (await review(T('insurance', jordan), 1)).notes?.length === 1);
r = await call('recordOfficialCheck', admin.token, { docId: T('wwc'), version: 1, result: 'confirmed' });
check('Admin', 'Official check needs a reference', /reference/.test(r.error ?? ''));
r = await call('recordOfficialCheck', admin.token, { docId: T('wwc'), version: 1, result: 'confirmed', reference: 'OCG-TEST-0001' });
check('Trust', 'Official check recorded → confirmed with issuer', r.ok && (await version(T('wwc'), 1)).trust.confirmed === true);
r = await decide(T('insurance', jordan), 1, 'reject', 'The policy is in another instructor’s name.');
check('Admin', 'Reject', r.status === 'rejected');
const notes = (await list('notifications')).filter(n => n.userId === taylor.uid);
check('Notify', 'Instructor notified of approvals and correction requests (in-app)', notes.some(n => /approved/.test(n.title)) && notes.some(n => /correct the details/.test(n.title)));
const aud = (await list('documentAudit')).map(a => a.action);
check('Audit', 'Approve, reject, re-upload, correction, manual, field correction, category, note and official check all recorded',
  ['document_approved', 'document_rejected', 'reupload_requested', 'correction_requested', 'manual_verification', 'fields_corrected', 'category_changed', 'note_added', 'official_check_recorded'].every(a => aud.includes(a)));

// ---------- 5. Eligibility ----------
let comp = await getDoc(`users/${taylor.uid}`);
check('Eligibility', 'Taylor meets the mandatory rules after the four core documents are verified', comp.compliance?.eligible === true && comp.compliance.enforced === true, JSON.stringify(comp.compliance));
const privC = await getDoc(`users/${taylor.uid}/private/compliance`);
check('Eligibility', 'Details kept in the private record (WWC expiring soon), not on the public profile', Array.isArray(privC?.expiringSoon) && !('expiringSoon' in comp.compliance), JSON.stringify(privC?.expiringSoon));
check('Eligibility', 'Optional documents (first aid re-upload requested) do not block', comp.compliance.eligible === true);

// ---------- 6. Version management ----------
r = await upload(taylor, 'wwc', ['wwc.png'], { number: 'WWC1234567E', expiry: '2026-12-20', state: 'NSW' });
v = await settled(T('wwc'), 2);
parent = await getDoc(`instructorDocuments/${T('wwc')}`);
check('Versions', 'Renewal is version 2; version 1 stays verified and in use', parent.latestVersion === 2 && parent.verifiedVersion === 1 && (await version(T('wwc'), 1)).status === 'verified');
check('Duplicates', 'Same file re-uploaded by the same instructor reported (level 1, same instructor)', (await review(T('wwc'), 2)).duplicates?.some(d => d.level === 1 && d.sameInstructor));

// ---------- 7. OCR pause / resume ----------
r = await saveSettings({ features: { ocr: false } }, 'Testing OCR pause');
check('Pause', 'OCR paused (setting saved and audited)', r.ok && (await list('documentAudit')).some(a => a.action === 'settings_changed' && a.details?.setting === 'ocr' && a.reason === 'Testing OCR pause'));
const pagesBefore = await usage();
r = await upload(jordan, 'firstAid', ['first_aid.pdf'], { number: 'FA-778899', expiry: '2028-03-05' });
check('Pause', 'Upload still succeeds while OCR is paused', r.version === 1, JSON.stringify(r));
v = await settled(T('firstAid', jordan), 1, ['awaiting_ocr']);
check('Pause', 'New upload marked Awaiting OCR', v?.status === 'awaiting_ocr');
let j = await job(T('firstAid', jordan), 1);
check('Pause', 'Job kept in the queue (not deleted), waiting for OCR, no attempt counted', j?.status === 'queued' && j.waitingFor === 'ocr_paused' && (j.attempts ?? 0) === 0);
await call('documentTestHooks', admin.token, { forceDue: true });
await call('documentTestHooks', admin.token, { runQueue: true });
j = await job(T('firstAid', jordan), 1);
check('Pause', 'Queue worker leaves it alone while paused (no retries)', j?.status === 'queued' && (j.attempts ?? 0) === 0);
check('Pause', 'No OCR requests while paused (page count unchanged)', (await usage()) === pagesBefore, `${pagesBefore} → ${await usage()}`);
const sc = await call('scanDocument', jordan.token, { key: 'wwc', path: `verification-documents/${jordan.uid}/wwc/x.png` });
check('Pause', 'Instant OCR suggestion also stops while paused', sc.reason === 'paused', JSON.stringify(sc));
r = await decide(T('firstAid', jordan), 1, 'approve');
check('Pause', 'Admin can still review and approve manually while OCR is paused', r.status === 'verified', r.error);
r = await upload(jordan, 'insurance', ['insurance.pdf'], { number: 'PL20260011', expiry: '2027-07-01' });
await settled(T('insurance', jordan), r.version, ['awaiting_ocr']);
const compBefore = (await getDoc(`users/${taylor.uid}`)).compliance;
check('Pause', 'Pausing OCR did not change any instructor’s eligibility', compBefore.eligible === true);
r = await saveSettings({ features: { ocr: true } }, 'Testing OCR resume');
v = await settled(T('insurance', jordan), 2, ['pending_verification', 'manual_verification']);
check('Resume', 'Resuming OCR processes the waiting document (same file read before: earlier OCR result reused, no new charge)', !!v && (v.processing?.pages ?? 0) + (v.processing?.cachedPages ?? 0) >= 1, `${v?.status} pages=${v?.processing?.pages} reused=${v?.processing?.cachedPages}`);
j = await job(T('insurance', jordan), 2);
check('Resume', 'Processed exactly once', j?.status === 'done' && j.attempts === 1 && (await auditFor(T('insurance', jordan))).filter(a => a.action === 'processing_completed' && a.version === 2).length === 1);
await call('documentTestHooks', admin.token, { runQueue: true });
check('Resume', 'Running the queue again creates no duplicate processing', (await auditFor(T('insurance', jordan))).filter(a => a.action === 'processing_completed' && a.version === 2).length === 1);

// ---------- 8. Complete automation pause / resume ----------
r = await saveSettings({ automation: false }, 'Testing automation pause');
r = await upload(jordan, 'vehicleRego', ['rego.png'], { number: 'DEMO1X', expiry: '2027-02-28' });
check('Automation', 'Upload succeeds while automation is paused', r.version === 1);
v = await settled(T('vehicleRego', jordan), 1, ['processing_paused']);
check('Automation', 'Marked Processing paused; job kept', v?.status === 'processing_paused' && (await job(T('vehicleRego', jordan), 1)).status === 'queued');
const ex = await call('runDocumentExpiryNow', admin.token, {});
check('Automation', 'Expiry monitoring keeps running while automation is paused', !ex.skipped, JSON.stringify(ex));
check('Automation', 'Existing verified records stay verified', (await getDoc(`instructorDocuments/${T('driverLicence')}`)).verifiedVersion === 1);
r = await decide(T('vehicleRego', jordan), 1, 'reject', 'Manual review while paused: wrong plate');
check('Automation', 'Manual reject works while automation is paused', r.status === 'rejected');
r = await upload(jordan, 'vehicleRego', ['rego.png'], { number: 'DEMO1X', expiry: '2027-02-28' });
await settled(T('vehicleRego', jordan), 2, ['processing_paused']);
r = await saveSettings({ automation: true }, 'Testing automation resume');
v = await settled(T('vehicleRego', jordan), 2, ['pending_verification', 'manual_verification']);
check('Automation', 'Resumed: waiting document processed once', !!v && (await job(T('vehicleRego', jordan), 2)).attempts === 1);

// ---------- 9. Individual switches ----------
await saveSettings({ features: { duplicateDetection: false, riskIndicators: false } });
r = await upload(jordan, 'instructorLicence', ['instructor_licence.png'], { number: 'DI445566', expiry: '2027-06-30', state: 'NSW' });
v = await settled(T('instructorLicence', jordan), 1);
rv = await review(T('instructorLicence', jordan), 1);
check('Switches', 'Duplicate detection paused: OCR and extraction run, no duplicate checks', !!v.fields?.number && !(rv.duplicates ?? []).length && v.processing.steps.duplicateDetection === 'paused' && v.processing.steps.extraction === 'done',
  JSON.stringify(v.processing?.steps));
check('Switches', 'Risk indicators paused: none produced', !(rv.risks ?? []).length && v.processing.steps.riskIndicators === 'paused');
await saveSettings({ features: { duplicateDetection: true, riskIndicators: true, eligibilityUpdates: false } });
r = await decide(T('wwc'), 2, 'reject', 'Testing: eligibility updates paused');
check('Switches', 'Eligibility updates paused: decisions do not change eligibility', (await getDoc(`users/${taylor.uid}`)).compliance.eligible === true);
await saveSettings({ features: { eligibilityUpdates: true } });

// ---------- 10. OCR failure and retry ----------
// Fresh files (never read before), so the OCR result cache can't hide the simulated outage.
const { PNG } = (await import(new URL('../../backend/node_modules/pngjs/lib/png.js', import.meta.url).href)).default ?? await import(new URL('../../backend/node_modules/pngjs/lib/png.js', import.meta.url).href);
for (const [name, px] of [['fresh1.png', 0], ['fresh2.png', 1]]) {
  const img = PNG.sync.read(readFileSync(new URL('unknown.png', SPEC)));
  img.data[px * 4] = (img.data[px * 4] + 7 + Date.now()) % 256;
  writeFileSync(new URL(name, SPEC), PNG.sync.write(img));
}
await call('documentTestHooks', admin.token, { failNext: 1 });
r = await upload(jordan, 'other', ['fresh1.png'], {});
v = await until(async () => { const x = await version(T('other', jordan), 1); return x?.processing?.lastError ? x : null; });
j = await job(T('other', jordan), 1);
check('Retry', 'Temporary OCR failure: error recorded, retry scheduled', v?.status === 'processing' && j.status === 'queued' && j.waitingFor === 'retry' && j.attempts === 1, `${v?.status} ${j?.status} ${j?.attempts}`);
await call('documentTestHooks', admin.token, { forceDue: true });
await call('documentTestHooks', admin.token, { runQueue: true });
v = await settled(T('other', jordan), 1);
check('Retry', 'Automatic retry succeeds', v?.status === 'manual_verification' && (await job(T('other', jordan), 1)).status === 'done');
await call('documentTestHooks', admin.token, { failNext: 3 });
r = await upload(jordan, 'other', ['fresh2.png'], {});
for (let i = 0; i < 2; i++) { await until(async () => (await job(T('other', jordan), 2))?.status === 'queued' && (await job(T('other', jordan), 2)).attempts === i + 1); await call('documentTestHooks', admin.token, { forceDue: true }); await call('documentTestHooks', admin.token, { runQueue: true }); }
v = await settled(T('other', jordan), 2, ['processing_failed']);
check('Retry', 'After 3 failed attempts: Processing failed, original kept for manual review', v?.status === 'processing_failed' && (await job(T('other', jordan), 2)).status === 'failed' && v.files?.length === 1);
check('Retry', 'Cybria alerted about the failure (not client admins)', (await list('notifications')).some(n => n.userId === 'cybria' && /processing failed/i.test(n.title)));
r = await call('retryDocumentProcessing', admin.token, { docId: T('other', jordan), version: 2 });
check('Retry', 'Admin retries an individual failed document', r.outcome === 'done' && (await version(T('other', jordan), 2)).status === 'manual_verification', JSON.stringify(r));
await saveSettings({ features: { ocr: false } });
r = await call('retryDocumentProcessing', admin.token, { docId: T('other', jordan), version: 2 });
check('Retry', 'Retry while OCR is paused is saved for later, not run', r.outcome === 'waiting' && /OCR is paused/.test(r.message), r.message);
await saveSettings({ features: { ocr: true } });

// ---------- 11. Expiry monitoring (simulated dates) ----------
// Taylor's verified WWC expires 2026-12-20. Today in this test is mid-November 2026.
const run = asOf => call('runDocumentExpiryNow', admin.token, { asOf });
const ledger = async () => (await list('documentNotifications')).filter(n => n.docId === T('wwc'));
r = await run('2026-11-21T00:00:00Z');
check('Expiry', '30-day reminder created', (await ledger()).some(n => n.stage === 'd30'), JSON.stringify(r));
r = await run('2026-11-21T03:00:00Z');
check('Expiry', 'Same reminder is not sent twice', (await ledger()).filter(n => n.stage === 'd30').length === 1 && r.generated === 0);
await run('2026-12-06T00:00:00Z');
check('Expiry', '15-day reminder', (await ledger()).some(n => n.stage === 'd15'));
await saveSettings({ features: { ocr: false } });
await run('2026-12-14T00:00:00Z');
check('Expiry', '7-day reminder still sent while OCR is paused', (await ledger()).some(n => n.stage === 'd7'));
await saveSettings({ features: { ocr: true }, automation: false });
await run('2026-12-20T00:00:00Z');
check('Expiry', 'Expiry-date reminder still sent while all automation is paused', (await ledger()).some(n => n.stage === 'd0'));
await saveSettings({ automation: true, features: { typeDetection: false, extraction: false } });
r = await run('2026-12-28T00:00:00Z');
const wdoc = await getDoc(`instructorDocuments/${T('wwc')}`);
check('Expiry', 'After expiry: reminder sent and document marked Expired (type detection and extraction paused)', (await ledger()).some(n => n.stage === 'w1') && wdoc.expiryState === 'expired', JSON.stringify(r));
await saveSettings({ features: { typeDetection: true, extraction: true } });
const nts = (await list('notifications'));
check('Expiry', 'Instructor and admin dashboard notifications created', nts.some(n => n.userId === taylor.uid && /Document Expir/.test(n.title)) && nts.some(n => n.userId === 'cybria' && /Document Expir/.test(n.title)) && !nts.some(n => n.userId === 'admin' && /Document Expir/.test(n.title)));
const one = (await ledger())[0];
check('Expiry', 'Email delivery tracked (email service not set up yet → recorded, retry-safe)', one.email?.status === 'not_configured', one.email?.status);
const dev = await list('devEmails');
check('Expiry', 'Email wording matches the brief', dev.some(e => /is due to expire on 20 December 2026/.test(e.text) && /Please upload your renewed document before the expiry date/.test(e.text)));
comp = await getDoc(`users/${taylor.uid}`);
check('Eligibility', 'Expired mandatory WWC: instructor flagged, new bookings blocked', comp.compliance.eligible === false);
const learner = await signIn('learner@test.local');
const day = dayAhead(3);
r = await call('createBooking', learner.token, { instructorId: taylor.uid, lessonType: 'lesson-1h', startAt: at(day, '10:00').toISOString(), experience: 'some', testBooked: false, pickupLocation: '11 Kildare Rd, Blacktown NSW 2148' });
check('Eligibility', 'Booking refused by the server', /can’t take new bookings/.test(r.error ?? ''), r.error ?? JSON.stringify(r));
check('Eligibility', 'Cybria alerted that the instructor needs compliance action', (await list('notifications')).some(n => n.userId === 'cybria' && /compliance action/.test(n.title)));
// Renewal approved → eligible again (real date).
r = await upload(taylor, 'wwc', ['wwc_badqr.png'], { number: 'WWC7654321A', expiry: '2030-12-20', state: 'NSW' });
await settled(T('wwc'), r.version);
r = await decide(T('wwc'), r.version, 'approve');
comp = await getDoc(`users/${taylor.uid}`);
check('Eligibility', 'Renewal approved: eligibility recalculated, bookable again', r.status === 'verified' && comp.compliance.eligible === true);
await saveSettings({ features: { expiryMonitoring: false } });
r = await run('2027-01-30T00:00:00Z');
check('Expiry', 'Only the Expiry Monitoring switch pauses expiry checks', r.skipped === 'Expiry monitoring is paused');
await saveSettings({ features: { expiryMonitoring: true } });

// ---------- 12. Test mode isolation ----------
const before12 = await usage();
r = await upload(riley, 'driverLicence', ['licence_front.png'], { number: '18845502', expiry: '2029-08-15', state: 'NSW' });
v = await settled(T('driverLicence', riley), 1);
check('Test mode', 'Non-test instructor: no automation, plain manual review, no OCR call', v?.status === 'pending_verification' && v.processing?.skipped === 'test_mode' && (await usage()) === before12);
check('Test mode', 'Non-test instructor’s eligibility untouched', !(await getDoc(`users/${riley.uid}`)).compliance);

// ---------- 13. Whole-instructor approval and the original per-document review ----------
const sam = await instructor('sam.new@test.local', 'Sam', 'Newman', '1990-05-05', true);
await setDoc(`users/${sam.uid}`, { verificationStatus: 'not_submitted' }, ['verificationStatus']);
for (const [type, files, entered] of [['driverLicence', ['licence_front.png'], { number: '55500011', expiry: '2029-08-15', state: 'NSW' }], ['instructorLicence', ['instructor_licence.png'], { number: 'DI999000', expiry: '2027-06-30', state: 'NSW' }], ['wwc', ['wwc.png'], { number: 'WWC1112223A', expiry: '2027-12-20', state: 'NSW' }], ['vehicleRego', ['rego.png'], { number: 'SAM01', expiry: '2027-02-28' }]]) {
  r = await upload(sam, type, files, entered);
  await settled(T(type, sam), 1);
}
r = await call('submitVerification', sam.token, {});
check('Original flow', 'New instructor submits for review with the new uploads', r.ok === true, r.error);
r = await call('reviewVerification', admin.token, { uid: sam.uid, approve: true });
const samDocs = await Promise.all(['driverLicence', 'instructorLicence', 'wwc', 'vehicleRego'].map(t => getDoc(`instructorDocuments/${T(t, sam)}`)));
check('Original flow', 'Approving the instructor verifies the four core document versions', r.ok && samDocs.every(d => d.verifiedVersion === 1));
r = await upload(sam, 'wwc', ['wwc.png'], { number: 'WWC1112223A', expiry: '2027-12-20', state: 'NSW' });
await settled(T('wwc', sam), 2);
r = await call('reviewDocument', admin.token, { uid: sam.uid, key: 'wwc', approve: false, note: 'Old screen: please upload the back too' });
check('Original flow', 'The original per-document Reject button routes to the new records', r.ok && (await version(T('wwc', sam), 2)).status === 'rejected');

// ---------- 14. Earlier documents import ----------
const bik = s0.bik;
await setDoc(`users/${bik.uid}/private/profile`, { verification: { driverLicence: { url: 'https://example.invalid/old.jpg', number: '1234567', expiry: '2028-01-01', state: 'NSW' } } }, ['verification']);
r = await call('importLegacyDocuments', admin.token, {});
const bd = await getDoc(`instructorDocuments/${bik.uid}__driverLicence`);
check('Import', 'Earlier verified documents imported as verified (before OCR), not re-read', r.created >= 1 && bd?.verifiedVersion === 1 && (await version(`${bik.uid}__driverLicence`, 1)).verifiedBeforeOcr === true && !(await job(`${bik.uid}__driverLicence`, 1)));
r = await call('importLegacyDocuments', admin.token, {});
check('Import', 'Running the import again creates nothing new', r.created === 0);

// ---------- 15. Security ----------
const userGet = (path, u) => fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${u.token}` } }).then(x => x.status);
check('Security', 'Instructor reads own document record', (await userGet(`instructorDocuments/${T('driverLicence')}`, taylor)) === 200);
check('Security', 'Instructor cannot read another instructor’s document', (await userGet(`instructorDocuments/${T('driverLicence')}`, jordan)) === 403);
check('Security', 'Instructor cannot read another instructor’s versions', (await userGet(`instructorDocuments/${T('driverLicence')}/versions/v001`, jordan)) === 403);
check('Security', 'Instructor cannot read admin review details (risk, duplicates, notes) even for own document', (await userGet(`instructorDocuments/${T('driverLicence')}/versions/v001/admin/review`, taylor)) === 403);
check('Security', 'Instructor cannot read the audit trail or jobs', (await userGet(`documentAudit/x`, taylor)) === 403 && (await userGet(`documentJobs/x`, taylor)) === 403);
r = await call('getDocumentFile', jordan.token, { docId: T('driverLicence'), version: 1 });
check('Security', 'Instructor cannot open another instructor’s file', /can’t open/.test(r.error ?? ''), r.error);
r = await call('getDocumentFile', taylor.token, { docId: T('driverLicence'), version: 1 });
check('Security', 'Owner opens own file through the server', !!r.data && r.contentType === 'image/png');
r = await call('getDocumentFile', admin.token, { docId: T('driverLicence'), version: 1, index: 1 });
check('Security', 'Admin opens any file (back of licence)', !!r.data);
const dl = await fetch(`http://127.0.0.1:9199/v0/b/${BUCKET}/o/${encodeURIComponent((await version(T('driverLicence'), 1)).files[0].path)}?alt=media`, { headers: { Authorization: `Firebase ${taylor.token}` } });
check('Security', 'No direct download from storage, even for the owner (no shareable links)', dl.status === 403, dl.status);
check('Security', 'Instructor cannot upload into another instructor’s folder', (await storageUpload(taylor, `verification-documents/${jordan.uid}/wwc/x.png`, 'wwc.png', 'image/png')) === 403);
const pw = await fetch(`${FS}/users/${taylor.uid}/private/profile?updateMask.fieldPaths=verification`, { method: 'PATCH', headers: { Authorization: `Bearer ${taylor.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { verification: { mapValue: { fields: { wwc: { mapValue: { fields: { expiry: { stringValue: '2099-01-01' } } } } } } } } }) });
check('Security', 'Instructor cannot edit approved document details directly', pw.status === 403, pw.status);
for (const [fn, data] of [['decideDocument', { docId: T('wwc'), version: 1, action: 'approve' }], ['saveDocumentSettings', { settings: { automation: false } }], ['correctDocumentFields', { docId: T('wwc'), version: 1, corrections: {} }], ['setTestAccount', { uid: taylor.uid, testAccount: false }]]) {
  r = await call(fn, taylor.token, data);
  check('Security', `Instructor cannot call ${fn}`, /Admins only|Cybria Super Admin only/.test(r.error ?? ''), r.error);
}
const del = await fetch(`${FS}/documentAudit/${(await list('documentAudit'))[0].id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${admin.token}` } });
check('Security', 'Nobody can delete audit records (admin tried)', del.status === 403, del.status);
const edit = await fetch(`${FS}/integrations/documentSettings?updateMask.fieldPaths=automation`, { method: 'PATCH', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { automation: { booleanValue: false } } }) });
check('Security', 'Settings can only change through the server (with audit), not by writing the database', edit.status === 403, edit.status);

// ---------- 16. Retention ----------
const hadText = !!(await review(T('driverLicence'), 1))?.ocrText;
r = await call('documentTestHooks', admin.token, { cleanupAt: Date.now() + 31 * 86_400_000 });
const after = await review(T('driverLicence'), 1);
check('Retention', 'OCR text removed 30 days after a final decision; extracted fields kept', hadText && !after.ocrText && !!after.ocrTextRemovedAt && !!(await version(T('driverLicence'), 1)).fields?.number, JSON.stringify(r));
check('Retention', 'Undecided documents keep their OCR text for review', !!(await review(T('driverLicence'), 2))?.ocrText);
check('Retention', 'Cached OCR results older than 30 days removed', r.cleanup?.cache > 0 && (await list('ocrCache')).length === 0);

const passed = results.filter(x => x.ok).length;
console.log(`\n${passed}/${results.length} passed`);
mkdirSync(new URL('../results/', import.meta.url), { recursive: true }); writeFileSync(new URL('../results/documents.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results, users: { taylor: taylor.uid, jordan: jordan.uid, riley: riley.uid, sam: sam.uid, admin: admin.uid } }, null, 2));
