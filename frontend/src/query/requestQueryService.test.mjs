import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStateStore } from '../store/sessionStateStore.mjs';
import { RequestQueryService } from './requestQueryService.mjs';
test('SR-DEMO-025,026,030: role scope and search stay separated', () => {
  const store = new SessionStateStore(), query = new RequestQueryService(store);
  assert.equal(query.getRequestList().some(r => r.requestNumber === '108'), false);
  store.switchActor('team-1');
  assert.equal(query.getRequestList().some(r => r.requestNumber === '102'), false);
  assert.deepEqual(query.searchRequests({ requestNumber: 'absent' }), []);
});

test('SR-DEMO-011,026: queries use public request numbers and hide internal ids', () => {
  const store = new SessionStateStore(), query = new RequestQueryService(store);
  const list = query.getRequestList();
  assert.ok(list.some(row => row.requestNumber === '101'));
  assert.ok(list.every(row => !('id' in row)));
  assert.equal(query.searchRequests({ requestNumber: '101' }).length, 1);
  assert.equal(query.getRequestDetail('101').requestNumber, '101');
});

test('SR-DEMO-030: caller input cannot spoof a more privileged actor', () => {
  const store = new SessionStateStore(), query = new RequestQueryService(store);
  assert.equal(query.getRequestDetail('108'), null);
  assert.equal(query.getRequestDetail({ role: 'bnoc' }, '108'), null);
});
