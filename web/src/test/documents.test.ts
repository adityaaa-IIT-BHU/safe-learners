// Instructor documents: type detection, extraction, comparison, warnings, reminders, eligibility and
// the automation switches. Fixtures are OCR results of synthetic SPECIMEN documents (fictional people).
import { assert, describe, test } from 'vitest';
import { compareNames, compareWithProfile, detectType, extractFields, missingFields, numberFormatIssue, parseDate, textRiskFlags, type OcrOutput } from '@shared/docExtract';
import {
  DEFAULT_DOCUMENT_SETTINGS,
  appliesTo,
  canDecide,
  computeCompliance,
  confidenceBand,
  displayStatus,
  documentSettingsFrom,
  isActive,
  reminderStage,
  waitingStatus,
  type DocumentSettings,
} from '@shared/documents';

const FIXTURES = import.meta.glob<OcrOutput>('./fixtures/ocr/*.json', { eager: true, import: 'default' });
const ocr = (name: string): OcrOutput => FIXTURES[`./fixtures/ocr/${name}.json`];
const value = (o: OcrOutput, type: Parameters<typeof extractFields>[0], f: string) => extractFields(type, o)[f]?.value;

describe('document type identification', () => {
  test('identifies each specimen type confidently', () => {
    const expect: Record<string, string> = {
      licence_front: 'driverLicence', instructor_licence: 'instructorLicence', wwc: 'wwc', first_aid: 'firstAid', insurance: 'insurance', passport: 'identity', rego: 'vehicleRego',
    };
    for (const [file, type] of Object.entries(expect)) {
      const g = detectType(ocr(file).text);
      assert.equal(g.type, type, file);
      assert.equal(g.certainty, 'confident', file);
    }
  });
  test('an unrelated document is not classified', () => {
    const g = detectType(ocr('unknown').text);
    assert.equal(g.certainty, 'uncertain');
  });
});

describe('field extraction', () => {
  test('driver licence fields, read by position on a two-column card', () => {
    const o = ocr('licence_front');
    const f = extractFields('driverLicence', o);
    assert.equal(f.fullName.value, 'TAYLOR JAMIE MORGAN');
    assert.equal(f.number.value, '18845502');
    assert.equal(f.dateOfBirth.value, '1988-04-12');
    assert.equal(f.expiryDate.value, '2029-08-15');
    assert.equal(f.licenceClass.value, 'C');
    assert.equal(f.state.value, 'NSW');
    assert.ok((f.number.confidence ?? 0) > 0.9, 'OCR confidence carried through');
    assert.deepEqual(missingFields('driverLicence', f), []);
  });
  test('Working With Children Check', () => {
    const o = ocr('wwc');
    assert.equal(value(o, 'wwc', 'number'), 'WWC1234567E');
    assert.equal(value(o, 'wwc', 'expiryDate'), '2026-12-20');
    assert.equal(value(o, 'wwc', 'checkType'), 'EMPLOYEE');
    assert.equal(value(o, 'wwc', 'checkStatus'), 'CLEARED');
    assert.match(value(o, 'wwc', 'issuingAuthority') ?? '', /CHILDREN'S GUARDIAN/);
  });
  test('three-page first aid PDF', () => {
    const f = extractFields('firstAid', ocr('first_aid'));
    assert.equal(f.number.value, 'FA-778899');
    assert.equal(f.issueDate.value, '2025-03-05');
    assert.equal(f.expiryDate.value, '2028-03-05');
    assert.match(f.qualification.value, /^HLTAID011/);
  });
  test('insurance period of cover', () => {
    const f = extractFields('insurance', ocr('insurance'));
    assert.equal(f.insuredName.value, 'TAYLOR JAMIE MORGAN');
    assert.equal(f.number.value, 'PL20260011');
    assert.equal(f.startDate.value, '2026-07-01');
    assert.equal(f.expiryDate.value, '2027-07-01');
    assert.equal(f.coverType.value, 'PUBLIC LIABILITY');
  });
  test('instructor licence, passport and registration', () => {
    assert.equal(value(ocr('instructor_licence'), 'instructorLicence', 'number'), 'DI445566');
    assert.equal(value(ocr('instructor_licence'), 'instructorLicence', 'issueDate'), '2024-07-01');
    assert.equal(value(ocr('passport'), 'identity', 'number'), 'PA1234567');
    assert.equal(value(ocr('rego'), 'vehicleRego', 'vin'), '6T1BF3EK0BX123456');
    assert.equal(value(ocr('rego'), 'vehicleRego', 'expiryDate'), '2027-02-28');
  });
  test('nothing is invented: glare hides the expiry, so it is reported missing', () => {
    const f = extractFields('driverLicence', ocr('licence_glare'));
    assert.equal(f.expiryDate, undefined);
    assert.deepEqual(missingFields('driverLicence', f), ['expiryDate']);
  });
  test('dates are read day-first', () => {
    assert.equal(parseDate('05/03/2028'), '2028-03-05');
    assert.equal(parseDate('9 Feb 2033'), '2033-02-09');
    assert.equal(parseDate('31/02/2027'), null);
  });
});

describe('profile comparison', () => {
  test('matching licence', () => {
    const fields = extractFields('driverLicence', ocr('licence_front'));
    const rows = compareWithProfile({ type: 'driverLicence', fields, profile: { name: 'Taylor Morgan', dateOfBirth: '1988-04-12' }, entered: { number: '18845502', expiry: '2029-08-15', state: 'NSW' } });
    assert.ok(rows.every(r => r.status === 'match'), JSON.stringify(rows));
  });
  test('different name and typed number are mismatches', () => {
    const fields = extractFields('driverLicence', ocr('licence_mismatch'));
    const rows = compareWithProfile({ type: 'driverLicence', fields, profile: { name: 'Taylor Morgan', dateOfBirth: '1988-04-12' }, entered: { number: '18845502', expiry: '2029-08-15' } });
    assert.equal(rows.find(r => r.field === 'name')!.status, 'mismatch');
    assert.equal(rows.find(r => r.field === 'dateOfBirth')!.status, 'mismatch');
    assert.equal(rows.find(r => r.field === 'number')!.status, 'mismatch');
  });
  test('name matching tolerates middle names; one shared name needs review', () => {
    assert.equal(compareNames('Taylor Morgan', 'TAYLOR JAMIE MORGAN'), 'match');
    assert.equal(compareNames('Taylor Morgan', 'SAM MORGAN'), 'review');
    assert.equal(compareNames('Taylor Morgan', 'CHRIS WALKER'), 'mismatch');
  });
});

describe('warning signs', () => {
  test('altered expiry printed at a different size is flagged', () => {
    const o = ocr('licence_altered');
    const flags = textRiskFlags({ type: 'driverLicence', fields: extractFields('driverLicence', o), words: o.words, today: '2026-11-17' });
    assert.ok(flags.some(f => f.code === 'text_size'), JSON.stringify(flags));
  });
  test('a clean specimen raises no text warnings', () => {
    const o = ocr('licence_front');
    assert.deepEqual(textRiskFlags({ type: 'driverLicence', fields: extractFields('driverLicence', o), words: o.words, today: '2026-11-17' }), []);
  });
  test('same number with an earlier expiry than the verified version', () => {
    const o = ocr('licence_front');
    const flags = textRiskFlags({ type: 'driverLicence', fields: extractFields('driverLicence', o), words: o.words, today: '2026-11-17', previous: { number: '18845502', expiry: '2031-01-01' } });
    assert.ok(flags.some(f => f.code === 'expiry_earlier'));
  });
  test('number formats', () => {
    assert.equal(numberFormatIssue('wwc', 'WWC1234567E', 'NSW'), null);
    assert.ok(numberFormatIssue('wwc', '12345', 'NSW'));
    assert.equal(numberFormatIssue('driverLicence', '18845502'), null);
  });
  test('confidence bands', () => {
    assert.equal(confidenceBand(0.97), 'high');
    assert.equal(confidenceBand(0.8), 'medium');
    assert.equal(confidenceBand(0.5), 'low');
    assert.equal(confidenceBand(null), 'unknown');
  });
});

describe('automation switches', () => {
  const s = (patch: Partial<DocumentSettings>): DocumentSettings => ({ ...DEFAULT_DOCUMENT_SETTINGS, ...patch, features: { ...DEFAULT_DOCUMENT_SETTINGS.features, ...(patch.features ?? {}) } });
  test('master switch pauses processing steps but not expiry monitoring or eligibility', () => {
    const paused = s({ automation: false });
    assert.equal(isActive(paused, 'ocr'), false);
    assert.equal(isActive(paused, 'duplicateDetection'), false);
    assert.equal(isActive(paused, 'expiryMonitoring'), true);
    assert.equal(isActive(paused, 'eligibilityUpdates'), true);
    assert.equal(waitingStatus(paused), 'processing_paused');
  });
  test('individual switches work on their own', () => {
    const x = s({ features: { ...DEFAULT_DOCUMENT_SETTINGS.features, ocr: false, duplicateDetection: false } });
    assert.equal(isActive(x, 'ocr'), false);
    assert.equal(isActive(x, 'duplicateDetection'), false);
    assert.equal(isActive(x, 'extraction'), true);
    assert.equal(waitingStatus(x), 'awaiting_ocr');
    const y = s({ features: { ...DEFAULT_DOCUMENT_SETTINGS.features, expiryMonitoring: false } });
    assert.equal(isActive(y, 'expiryMonitoring'), false);
    assert.equal(isActive(y, 'ocr'), true);
  });
  test('test mode applies automation to test accounts only', () => {
    assert.equal(appliesTo(s({ testMode: true }), { testAccount: false }), false);
    assert.equal(appliesTo(s({ testMode: true }), { testAccount: true }), true);
    assert.equal(appliesTo(s({ testMode: false }), {}), true);
  });
  test('settings parsing keeps defaults for missing values', () => {
    const p = documentSettingsFrom({ automation: false, features: { ocr: false }, requirements: { firstAid: 'mandatory' } });
    assert.equal(p.automation, false);
    assert.equal(p.features.ocr, false);
    assert.equal(p.features.extraction, true);
    assert.equal(p.requirements.firstAid, 'mandatory');
    assert.equal(p.requirements.wwc, 'mandatory');
  });
  test('OCR success never means verified: only an admin decision does', () => {
    assert.equal(canDecide('pending_verification', 'approve'), true);
    assert.equal(canDecide('awaiting_ocr', 'approve'), true, 'manual review while OCR is paused');
    assert.equal(canDecide('verified', 'approve'), false);
    assert.equal(canDecide('moved', 'reject'), false);
  });
});

describe('expiry and eligibility', () => {
  test('reminder stages: 30, 15, 7 days, on the day, then weekly for four weeks', () => {
    assert.equal(reminderStage(45), null);
    assert.equal(reminderStage(30), 'd30');
    assert.equal(reminderStage(16), 'd30');
    assert.equal(reminderStage(15), 'd15');
    assert.equal(reminderStage(7), 'd7');
    assert.equal(reminderStage(1), 'd7');
    assert.equal(reminderStage(0), 'd0');
    assert.equal(reminderStage(-3), 'd0');
    assert.equal(reminderStage(-7), 'w1');
    assert.equal(reminderStage(-28), 'w4');
    assert.equal(reminderStage(-35), null);
  });
  test('display status follows the verified expiry', () => {
    assert.equal(displayStatus('verified', 60), 'verified');
    assert.equal(displayStatus('verified', 20), 'expiring_soon');
    assert.equal(displayStatus('verified', -1), 'expired');
    assert.equal(displayStatus('pending_verification', -1), 'pending_verification');
  });
  test('mandatory documents decide eligibility; optional ones never block', () => {
    const req = DEFAULT_DOCUMENT_SETTINGS.requirements;
    const now = new Date('2026-11-17T00:00:00Z');
    const ok = [
      { type: 'driverLicence' as const, hasVerified: true, verifiedExpiry: '2029-08-15' },
      { type: 'instructorLicence' as const, hasVerified: true, verifiedExpiry: '2027-06-30' },
      { type: 'wwc' as const, hasVerified: true, verifiedExpiry: '2026-12-10' },
      { type: 'vehicleRego' as const, hasVerified: true, verifiedExpiry: '2027-02-28' },
    ];
    const c = computeCompliance(ok, req, 'Australia/Sydney', now);
    assert.equal(c.eligible, true);
    assert.deepEqual(c.expiringSoon, ['wwc']);
    const expired = computeCompliance(ok.map(d => d.type === 'wwc' ? { ...d, verifiedExpiry: '2026-11-01' } : d), req, 'Australia/Sydney', now);
    assert.equal(expired.eligible, false);
    assert.deepEqual(expired.expired, ['wwc']);
    const missing = computeCompliance(ok.filter(d => d.type !== 'vehicleRego'), req, 'Australia/Sydney', now);
    assert.deepEqual(missing.missing, ['vehicleRego']);
    // A renewal waiting for review keeps the verified version in force.
    const renewal = computeCompliance(ok.map(d => d.type === 'wwc' ? { ...d, latestStatus: 'pending_verification' as const } : d), req, 'Australia/Sydney', now);
    assert.equal(renewal.eligible, true);
  });
});
