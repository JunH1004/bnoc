import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = resolve(import.meta.dirname, '../..');

function isolatedRun(extraTest) {
  const root = mkdtempSync(join(tmpdir(), 'bnoc-workflow-runner-test-'));
  try {
    const directory = join(root, 'experiments/ai-workflow');
    mkdirSync(directory, { recursive: true });
    mkdirSync(join(root, 'frontend'));
    cpSync(join(repo, 'frontend/src'), join(root, 'frontend/src'), { recursive: true });
    symlinkSync(join(repo, 'frontend/node_modules'), join(root, 'frontend/node_modules'), 'dir');
    for (const name of ['run-sensitivity.mjs', 'schedule-contract.test.mjs']) cpSync(join(import.meta.dirname, name), join(directory, name));
    if (extraTest) writeFileSync(join(root, 'frontend/src/workflow/added-regression.test.mjs'), extraTest);
    // Run a standalone Node process, outside the parent's test-runner protocol.
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const result = spawnSync(process.execPath, [join(directory, 'run-sensitivity.mjs')], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    const outputRoot = join(root, '.local/ai-workflow-sensitivity');
    const output = join(outputRoot, readdirSync(outputRoot)[0]);
    const summary = result.status === 0 ? JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8')) : undefined;
    const mutationPatch = summary?.mutationDiff ? readFileSync(join(output, summary.mutationDiff), 'utf8') : '';
    return { status: result.status, text: result.stdout + result.stderr, summary, mutationPatch };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const scheduleRegression = `
import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestCommands } from './requestCommands.mjs';
test('team assignment leaves the schedule undecided', () => {
  const env = {
    state: { requests: [{ id: 'REQ-1', requestNumber: '1', registeredBy: 'requester', status: '대기', revision: 1 }], workItems: [], history: [], notifications: [], receipts: {} },
    accounts: [{ id: 'bnoc', role: 'bnoc' }], teams: ['TEAM_A'], id: () => 'WORK-1', now: () => '2026-10-13T00:00:00Z',
  };
  const result = RequestCommands.assignTeams({ targetId: 'REQ-1', expectedRevision: 1, payload: { teamIds: ['TEAM_A'] } }, { activeActorId: 'bnoc' }, env);
  assert.equal(result.ok, true);
  assert.equal(result.nextState.workItems[0].schedule, undefined, 'EXISTING_REGRESSION_CAUGHT_SCHEDULE');
});`;

test('current original and mutation produce a successful sensitivity check', () => {
  const result = isolatedRun();
  assert.equal(result.status, 0, result.text);
  assert.equal(result.summary.productSourceUnchanged, true);
  assert.match(result.mutationPatch, /--- original\/src\/workflow\/requestCommands.mjs/);
  assert.match(result.mutationPatch, /^\+.*schedule: '2026-10-20T09:00'/m);
});

test('an existing regression detecting the mutation is an improvement, not a runner failure', () => {
  const result = isolatedRun(scheduleRegression);
  assert.equal(result.status, 0, result.text);
  const observation = result.summary.results.find(item => item.label === 'mutated-existing');
  assert.equal(observation.exitCode, 1);
  assert.equal(observation.fail, 1);
});

test('a failing original remains a failed check', () => {
  const result = isolatedRun("import test from 'node:test'; import assert from 'node:assert/strict'; test('broken baseline', () => assert.fail('BASELINE_FAILURE'));");
  assert.equal(result.status, 1);
  assert.match(result.text, /original: existing tests did not pass/);
});
