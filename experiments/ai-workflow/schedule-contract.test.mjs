import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Ground truth: user correction, 2026-10-13; requirements §4 and FR-016/018.
// This file is copied beside an isolated source tree by run-sensitivity.mjs.
const source = resolve(import.meta.dirname, 'src');
const { RequestCommands } = await import(pathToFileURL(resolve(source, 'workflow/requestCommands.mjs')));
const { WorkItemCommands } = await import(pathToFileURL(resolve(source, 'workflow/workItemCommands.mjs')));

function fixture() {
  let sequence = 0;
  return {
    state: {
      requests: [{ id: 'REQ-101', requestNumber: '101', registeredBy: 'requester', requesterActorId: 'requester', status: '대기', revision: 1 }],
      workItems: [], history: [], notifications: [], receipts: {},
    },
    accounts: [{ id: 'requester', role: 'requester' }, { id: 'bnoc', role: 'bnoc' }, { id: 'team', role: 'team', teamId: 'TEAM_A' }],
    teams: ['TEAM_A', 'TEAM_B'],
    id: () => `WORK-${++sequence}`,
    now: () => '2026-10-13T00:00:00Z',
  };
}

function assign(env, teamIds = ['TEAM_A']) {
  return RequestCommands.assignTeams({ targetId: 'REQ-101', expectedRevision: 1, payload: { teamIds } }, { activeActorId: 'bnoc' }, env);
}

test('BNOC assignment does not decide a work schedule', () => {
  const result = assign(fixture(), ['TEAM_A', 'TEAM_B']);
  assert.equal(result.ok, true);
  assert.equal(result.nextState.workItems.length, 2);
  for (const work of result.nextState.workItems) assert.equal(work.schedule, undefined, 'BNOC_ASSIGNMENT_MUST_NOT_SET_SCHEDULE');
});

test('assigned team can set its work schedule', () => {
  const env = fixture();
  env.state = assign(env).nextState;
  const work = env.state.workItems[0];
  const result = WorkItemCommands.updateWorkDetails({ targetId: work.id, expectedRevision: work.revision, payload: { schedule: '2026-10-20T09:00' } }, { activeActorId: 'team' }, env);
  assert.equal(result.ok, true);
  assert.equal(result.nextState.workItems[0].schedule, '2026-10-20T09:00');
});

test('BNOC cannot edit a work schedule through the team command', () => {
  const env = fixture();
  env.state = assign(env).nextState;
  const work = env.state.workItems[0];
  const result = WorkItemCommands.updateWorkDetails({ targetId: work.id, expectedRevision: work.revision, payload: { schedule: '2026-10-20T09:00' } }, { activeActorId: 'bnoc' }, env);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'FORBIDDEN');
});
