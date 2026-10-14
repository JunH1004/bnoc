import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureCatalog } from './fixtureCatalog.mjs';

test('SR-DEMO-002,005,038: synthetic baseline covers roles, teams and states', () => {
  const bundle = FixtureCatalog.load('1');
  assert.deepEqual(bundle.teams, ['무선반', '유선반', '전장반(전산장비)', '정체반', '암호반']);
  assert.equal(new Set(bundle.accounts.filter(a => a.role === 'team').map(a => a.teamId)).size >= 2, true);
  assert.ok(bundle.accounts.every(actor => actor.contactId.startsWith('ID-')));
  for (const status of ['대기', '문서 대기', '배정', '작업 중', '완료', '취소']) assert.ok(bundle.requests.some(r => r.status === status));
  assert.ok(bundle.workItems.some(w => w.status === '반환'));
  assert.ok(bundle.workItems.some(w => w.status === '반환' && w.resolvedByWorkItemIds.length && bundle.workItems.some(next => next.replacesWorkItemId === w.id)));
  assert.ok(bundle.requests.some(r => bundle.workItems.filter(w => w.requestId === r.id).length > 1));
  for (const work of bundle.workItems.filter(w => w.completion)) {
    assert.equal(bundle.accounts.find(actor => actor.id === work.completion.completedBy)?.teamId, work.teamId);
  }
});

test('SR-DEMO-011: public numbers are short, unique and separate from internal ids', () => {
  const bundle = FixtureCatalog.load('1');
  assert.deepEqual(bundle.requests.map(request => request.requestNumber), ['101','102','103','104','105','106','107','108']);
  assert.equal(new Set(bundle.requests.map(request => request.requestNumber)).size, bundle.requests.length);
  assert.ok(bundle.requests.every(request => request.id !== request.requestNumber));
  assert.ok(bundle.workItems.every(work => /^\d+-\d+$/.test(work.workNumber)));
  assert.ok(bundle.workItems.every(work => work.id !== work.workNumber));
});
