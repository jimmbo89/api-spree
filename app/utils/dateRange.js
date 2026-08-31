const { Op } = require('sequelize');

function parseDateOnly(value) {
  if (!value) return null;

  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Fecha invalida: ${value}. Se espera YYYY-MM-DD.`);
  }

  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));

  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day)
  ) {
    throw new Error(`Fecha invalida: ${value}.`);
  }

  return date;
}

function getDateOnlyBounds(from, to) {
  const start = parseDateOnly(from);
  const end = parseDateOnly(to);

  if (start && end && start > end) {
    throw new Error('La fecha inicial no puede ser posterior a la fecha final.');
  }

  let endExclusive = null;
  if (end) {
    endExclusive = new Date(end);
    endExclusive.setDate(endExclusive.getDate() + 1);
  }

  return { start, endExclusive };
}

function getDateOnlyRange(from, to) {
  const { start, endExclusive } = getDateOnlyBounds(from, to);
  const range = {};
  if (start) range[Op.gte] = start;

  if (endExclusive) range[Op.lt] = endExclusive;

  return range;
}

function formatLocalSqlDateTime(date) {
  if (!date) return null;

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day} 00:00:00`;
}

function getCalendarWindow(days, referenceDate = new Date()) {
  const endExclusive = new Date(referenceDate);
  endExclusive.setHours(0, 0, 0, 0);
  endExclusive.setDate(endExclusive.getDate() + 1);

  const start = new Date(endExclusive);
  start.setDate(start.getDate() - days);

  return { start, endExclusive };
}

function formatDateOnly(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return `${match[3]}/${match[2]}`;
}

module.exports = {
  getCalendarWindow,
  getDateOnlyBounds,
  getDateOnlyRange,
  formatLocalSqlDateTime,
  formatDateOnly
};
