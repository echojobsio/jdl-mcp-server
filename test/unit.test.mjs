// Pure unit tests — no network, no server, no API quota.
//
// These cover logic that silently corrupts output rather than throwing, which
// is the failure mode integration tests are worst at catching: a salary
// rendered wrong still "returns data" and still looks like a healthy response.
//
// Run: npm test  (builds first, then `node --test test/`)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSalary, CONTINENT_MAP } from '../dist/server.js';

// The API reports salary in thousands (150 = $150k). formatSalary rejects
// anything outside 10..1000 because the corpus contains non-USD amounts and
// raw annual figures that would render as "$150000k".
test('formatSalary renders a normal range', () => {
  assert.equal(formatSalary(150, 200), '$150k - $200k');
});

test('formatSalary handles a missing bound with ?', () => {
  assert.equal(formatSalary(150, undefined), '$150k - $?k');
  assert.equal(formatSalary(undefined, 200), '$?k - $200k');
});

test('formatSalary reports "Not disclosed" when both bounds are missing', () => {
  assert.equal(formatSalary(undefined, undefined), 'Not disclosed');
});

// The guard that stops raw annual figures rendering as "$150000k".
test('formatSalary rejects out-of-range values as non-USD/absurd', () => {
  assert.equal(formatSalary(150000, 200000), 'Not disclosed', 'raw annual USD must be rejected');
  assert.equal(formatSalary(5, 8), 'Not disclosed', 'below the 10k floor');
  assert.equal(formatSalary(1001, 2000), 'Not disclosed', 'above the 1000k ceiling');
});

// Boundary values: 10 and 1000 are inclusive, so they must render.
test('formatSalary accepts the inclusive bounds 10 and 1000', () => {
  assert.equal(formatSalary(10, 1000), '$10k - $1000k');
});

// A valid bound paired with an invalid one keeps the valid half rather than
// discarding the whole range.
test('formatSalary keeps the valid half of a mixed range', () => {
  assert.equal(formatSalary(150, 999999), '$150k - $?k');
  assert.equal(formatSalary(0, 200), '$?k - $200k');
});

// Zero is falsy and must not render as "$0k".
test('formatSalary treats zero as absent', () => {
  assert.equal(formatSalary(0, 0), 'Not disclosed');
});

// Continent names are a documented feature of the location filter (the server
// instructions advertise "Europe, Asia, Latin America"), so the keys are part
// of the public contract, not an implementation detail.
test('CONTINENT_MAP covers the continents named in the server instructions', () => {
  for (const key of ['europe', 'asia', 'latin america']) {
    assert.ok(CONTINENT_MAP[key], `missing advertised continent: ${key}`);
  }
});

test('CONTINENT_MAP values are comma-separated ISO-3166 alpha-2 codes', () => {
  for (const [name, codes] of Object.entries(CONTINENT_MAP)) {
    for (const code of codes.split(',')) {
      assert.match(code, /^[A-Z]{2}$/, `${name} contains a non-ISO code: ${code}`);
    }
  }
});

// Aliases must not drift apart from the canonical name they mirror.
test('CONTINENT_MAP aliases stay in sync with their canonical entry', () => {
  assert.equal(CONTINENT_MAP['latam'], CONTINENT_MAP['latin america']);
  assert.equal(CONTINENT_MAP['nordics'], CONTINENT_MAP['scandinavia']);
});
