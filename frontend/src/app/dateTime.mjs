export function localInputToUtc(value) {
  if (!value) return undefined;
  const date = new Date(value + ':00+09:00');
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
export function utcToLocalInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16);
}
export function displayTime(value) {
  if (!value) return '미정';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '시각 확인 불가';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(date);
}
/** @param {string | Date} [value] */
export function seoulDate(value = new Date()) { return new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10); }
export function moveDate(value, days) {
  const date = new Date(value + 'T00:00:00Z'); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
}
export function movePeriod(value, mode, direction) {
  if (mode !== 'month') return moveDate(value, direction * (mode === 'week' ? 7 : 1));
  const date = new Date(value + 'T00:00:00Z'); date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + direction); return date.toISOString().slice(0, 10);
}
export function calendarRange(value, mode) {
  const date = new Date(value + 'T00:00:00Z');
  if (mode === 'week') date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  if (mode === 'month') date.setUTCDate(1);
  const firstDate = date.toISOString().slice(0, 10);
  if (mode === 'month') date.setUTCMonth(date.getUTCMonth() + 1);
  else date.setUTCDate(date.getUTCDate() + (mode === 'week' ? 7 : 1));
  const nextDate = date.toISOString().slice(0, 10);
  return { from: localInputToUtc(firstDate + 'T00:00'), to: localInputToUtc(nextDate + 'T00:00'), firstDate, lastDate: moveDate(nextDate, -1) };
}
