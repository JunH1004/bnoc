import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStateStore } from '../store/sessionStateStore.mjs';
import { OpsQueryService } from './opsQueryService.mjs';
test('SR-DEMO-028,029,030: team schedule scoped and overview count matches list', () => {
  const store = new SessionStateStore(), query = new OpsQueryService(store);
  store.switchActor('team-1');
  assert.ok(query.getTeamSchedule().every(row => row.teamId === '무선반'));
  store.switchActor('bnoc-1');
  const overview = query.getBnocOverview({ status: ['배정'] });
  assert.equal(overview.total, overview.list.length);
});
