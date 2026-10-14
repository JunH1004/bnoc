import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStateStore } from '../store/sessionStateStore.mjs';
import { HistoryAndNotificationQueryService } from './historyAndNotificationQueryService.mjs';
test('SR-DEMO-027,030,031: notification recipient and history projection', () => {
  const store = new SessionStateStore(), query = new HistoryAndNotificationQueryService(store);
  const actor = store.accounts.find(a => a.id === 'requester-1');
  store.getSnapshot().history.push({ targetId: 'REQ-101', actorId: 'bnoc-1', at: 'now', field: '상태', before: '대기', after: '배정' });
  assert.ok(query.getNotifications().every(row => row.recipientActorId === actor.id));
  assert.ok(query.getNotifications().every(row => !row.relatedRequestId?.startsWith('REQ-')));
  assert.ok(query.getHistory('101').every(row => !('before' in row)));
  assert.ok(query.getHistory('101').every(row => row.actorLabel === actor.displayName || row.actorLabel === '담당자'));
  assert.equal(query.getHistory('101').some(row => row.actorLabel === '윤하린'), false);
  assert.ok(query.getHistory('101').some(row => row.summary.includes('대기 → 배정')));
});
