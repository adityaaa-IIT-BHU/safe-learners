// File checks on synthetic SPECIMEN documents: format, corruption, password protection, image quality,
// editing-software metadata, near-duplicate fingerprints and QR codes (never visited).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyseQr, hammingHex, inspectFile, sniff, textSimilarity } from '../src/docs/fileChecks.ts';

const file = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name));
const codes = (r: { issues: { code: string }[] }) => r.issues.map(i => i.code);

test('a clear licence photo passes with no quality issues', async () => {
  const r = await inspectFile(file('licence_front.png'), 'image/png', { analyseImage: true });
  assert.equal(r.kind, 'png');
  assert.equal(r.readable, true);
  assert.deepEqual(codes(r), []);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.ok(r.dHash);
});

test('blur and glare are reported as quality issues', async () => {
  assert.ok(codes(await inspectFile(file('licence_blurry.png'), 'image/png', { analyseImage: true })).includes('blurry'));
  assert.ok(codes(await inspectFile(file('licence_glare.png'), 'image/png', { analyseImage: true })).includes('glare'));
});

test('image quality checks are skipped when that switch is off', async () => {
  const r = await inspectFile(file('licence_blurry.png'), 'image/png', { analyseImage: false });
  assert.deepEqual(codes(r), []);
});

test('password-protected and damaged PDFs are refused with a clear reason', async () => {
  const p = await inspectFile(file('insurance_protected.pdf'), 'application/pdf', { analyseImage: true });
  assert.equal(p.passwordProtected, true);
  assert.deepEqual(codes(p), ['password_protected']);
  const c = await inspectFile(file('corrupt.pdf'), 'application/pdf', { analyseImage: true });
  assert.deepEqual(codes(c), ['corrupt']);
});

test('multi-page PDFs are counted, and editing software in metadata is found', async () => {
  assert.equal((await inspectFile(file('first_aid.pdf'), 'application/pdf', { analyseImage: true })).pageCount, 3);
  assert.match((await inspectFile(file('insurance_edited_meta.pdf'), 'application/pdf', { analyseImage: true })).software ?? '', /Photoshop/);
});

test('a file whose content does not match its type is refused', async () => {
  const r = await inspectFile(file('licence_front.png'), 'application/pdf', { analyseImage: true });
  assert.deepEqual(codes(r), ['type_mismatch']);
  assert.equal(sniff(Buffer.from('hello')), 'unknown');
  assert.deepEqual(codes(await inspectFile(Buffer.from('GIF89a....'), 'image/gif', { analyseImage: true })), ['unsupported']);
});

test('a resized, re-compressed copy has a nearby fingerprint', async () => {
  const a = await inspectFile(file('licence_front.png'), 'image/png', { analyseImage: false });
  const b = await inspectFile(file('licence_front_resized.jpg'), 'image/jpeg', { analyseImage: false });
  assert.notEqual(a.sha256, b.sha256);
  assert.ok(hammingHex(a.dHash!, b.dHash!) <= 6);
});

test('QR codes are read and classified without being visited', async () => {
  const ok = await inspectFile(file('wwc.png'), 'image/png', { analyseImage: false });
  assert.equal(ok.qr.length, 1);
  const good = analyseQr(ok.qr[0]);
  assert.equal(good.official, true);
  assert.equal(good.host, 'www.ocg.nsw.gov.au');
  const bad = analyseQr((await inspectFile(file('wwc_badqr.png'), 'image/png', { analyseImage: false })).qr[0]);
  assert.equal(bad.official, false);
  assert.match(bad.warning ?? '', /shortener/i);
  assert.equal(analyseQr('http://example.com/x').warning, 'Not a government (.gov.au) address');
});

test('text similarity spots the same document re-saved', () => {
  const t = 'CERTIFICATE OF CURRENCY INSURER EXAMPLE MUTUAL POLICY NUMBER PL20260011 PUBLIC LIABILITY';
  assert.equal(textSimilarity(t, t), 1);
  assert.ok(textSimilarity(t, 'DRIVER LICENCE NEW SOUTH WALES CLASS C') < 0.1);
});
