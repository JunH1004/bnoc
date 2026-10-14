import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureCatalog } from './fixtureCatalog.mjs';
import { AppStateFactory } from './appStateFactory.mjs';
test('SR-DEMO-001,006: baseline restores same independent state', () => {
  const a = AppStateFactory.restoreBaseline(), b = AppStateFactory.restoreBaseline();
  assert.deepEqual(a,b);
  a.requests[0].detail = '변경';
  assert.notEqual(a.requests[0].detail,b.requests[0].detail);
  const bad = FixtureCatalog.load();
  bad.workItems[0].requestId = 'missing';
  assert.throws(() => AppStateFactory.createInitialState(bad), /참조/);
});
