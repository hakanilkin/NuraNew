// lib/rtdcTime.js
//
// Small date/time helpers shared by the RTDC libs. Everything RTDC does is
// keyed on a calendar day and a few clock times ("by 2 PM", "order by 11"),
// so the libs work in local-time strings — 'YYYY-MM-DD' and 'HH:MM' — and
// only touch Date objects at the edges.

const pad = n => String(n).padStart(2, '0');

const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const isValidDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const isValidTime = s => typeof s === 'string' && /^\d{2}:\d{2}$/.test(s);

// Local-midnight Date for a 'YYYY-MM-DD'.
function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

// 'YYYY-MM-DD' + 'HH:MM' → Date (local).
function at(dateStr, timeStr) {
  const d = parseDate(dateStr);
  const [h, m] = timeStr.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d;
}

const toMinutes = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMinutes = m => `${pad(Math.floor(Math.max(0, m) / 60))}:${pad(Math.max(0, m) % 60)}`;

// ISO-ish timestamp → { date, time } in local time; null-safe.
function split(ts) {
  if (!ts) return null;
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return { date: fmtDate(d), time: fmtTime(d), ms: d.getTime() };
}

// 0 = Sunday … 6 = Saturday, from a 'YYYY-MM-DD'.
const dow = s => parseDate(s).getDay();
const isWeekday = s => { const w = dow(s); return w >= 1 && w <= 5; };

// Monday of the ISO week containing s.
function weekStart(s) {
  const w = dow(s);
  return addDays(s, w === 0 ? -6 : 1 - w);
}

function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

module.exports = {
  pad, fmtDate, fmtTime, isValidDate, isValidTime, parseDate, addDays, at,
  toMinutes, fromMinutes, split, dow, isWeekday, weekStart, daysBetween, eachDay,
};
