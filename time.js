// Lengths of time in milliseconds, and helpers for dates written as 'YYYY-MM-DD' (always UTC).

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso, days) => isoDay(Date.parse(`${iso}T00:00:00Z`) + days * DAY);
const today = () => isoDay(Date.now());

module.exports = { MINUTE, HOUR, DAY, isoDay, addDays, today };