import test from 'node:test';
import assert from 'node:assert/strict';
import { localInputToUtc, utcToLocalInput, calendarRange } from './dateTime.mjs';

test('datetime inputs preserve Korea time while transmitting UTC instants', () => {
  assert.equal(localInputToUtc('2026-10-13T09:30'), '2026-10-13T00:30:00.000Z', 'SEOUL_INPUT_TO_UTC_REQUIRED');
  assert.equal(utcToLocalInput('2026-10-13T00:30:00Z'), '2026-10-13T09:30');
  assert.equal(localInputToUtc(''), undefined);
});

test('calendar uses inclusive Seoul start and exclusive end, Monday week and leap-month limits', () => {
  assert.deepEqual(calendarRange('2026-10-13', 'day'), { from: '2026-10-12T15:00:00.000Z', to: '2026-10-13T15:00:00.000Z', firstDate: '2026-10-13', lastDate: '2026-10-13' });
  const week = calendarRange('2026-10-18', 'week');
  assert.equal(week.firstDate, '2026-10-12', 'MONDAY_WEEK_REQUIRED');
  assert.equal(week.lastDate, '2026-10-18');
  const month = calendarRange('2028-02-15', 'month');
  assert.equal(month.firstDate, '2028-02-01');
  assert.equal(month.lastDate, '2028-02-29');
});
