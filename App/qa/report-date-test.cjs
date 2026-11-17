const assert = require('node:assert/strict');

function localDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localDateStart(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function isInLocalRange(timestamp, startDate, endDate) {
  const value = new Date(timestamp);
  const start = localDateStart(startDate);
  const endExclusive = localDateStart(endDate);
  endExclusive.setDate(endExclusive.getDate() + 1);
  return value >= start && value < endExclusive;
}

const afterMidnightPakistan = new Date('2026-07-20T03:00:00+05:00');
assert.equal(afterMidnightPakistan.toISOString().slice(0, 10), '2026-07-19');
assert.equal(localDateString(afterMidnightPakistan), '2026-07-20');

assert.equal(isInLocalRange('2026-07-19T19:00:00.000Z', '2026-07-20', '2026-07-20'), true);
assert.equal(isInLocalRange('2026-07-20T18:59:59.999Z', '2026-07-20', '2026-07-20'), true);
assert.equal(isInLocalRange('2026-07-19T18:59:59.999Z', '2026-07-20', '2026-07-20'), false);
assert.equal(isInLocalRange('2026-07-20T19:00:00.000Z', '2026-07-20', '2026-07-20'), false);

assert.equal(isInLocalRange('2026-07-31T18:59:59.999Z', '2026-07-01', '2026-07-31'), true);
assert.equal(isInLocalRange('2026-07-31T19:00:00.000Z', '2026-07-01', '2026-07-31'), false);

console.log('Report local-date boundary tests passed.');
