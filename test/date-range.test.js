const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { getCalendarWindow, getDateOnlyRange, formatDateOnly } = require('../app/utils/dateRange');

test('getDateOnlyRange incluye día final completo mediante límite exclusivo', () => {
  const range = getDateOnlyRange('2026-08-01', '2026-08-31');

  assert.equal(range[Op.gte].getFullYear(), 2026);
  assert.equal(range[Op.gte].getMonth(), 7);
  assert.equal(range[Op.gte].getDate(), 1);
  assert.equal(range[Op.lt].getFullYear(), 2026);
  assert.equal(range[Op.lt].getMonth(), 8);
  assert.equal(range[Op.lt].getDate(), 1);
});

test('getCalendarWindow usa días calendario completos', () => {
  const reference = new Date(2026, 7, 31, 11, 43, 0);
  const range = getCalendarWindow(7, reference);

  assert.equal(range.start.getFullYear(), 2026);
  assert.equal(range.start.getMonth(), 7);
  assert.equal(range.start.getDate(), 25);
  assert.equal(range.start.getHours(), 0);
  assert.equal(range.endExclusive.getMonth(), 8);
  assert.equal(range.endExclusive.getDate(), 1);
  assert.equal(range.endExclusive.getHours(), 0);

  const previousReference = new Date(range.start);
  previousReference.setDate(previousReference.getDate() - 1);
  const previousRange = getCalendarWindow(7, previousReference);
  assert.equal(previousRange.start.getDate(), 18);
  assert.equal(previousRange.endExclusive.getDate(), 25);
});

test('formatDateOnly conserva día SQL sin conversión de zona horaria', () => {
  assert.equal(formatDateOnly('2026-08-31'), '31/08');
});
