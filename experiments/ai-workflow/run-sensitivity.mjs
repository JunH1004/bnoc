import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const repo = resolve(import.meta.dirname, '../..');
const source = join(repo, 'frontend/src');
const suite = join(import.meta.dirname, 'schedule-contract.test.mjs');
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]).sort();
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const sourceHashes = () => Object.fromEntries(files(source).map(path => [relative(source, path), hash(path)]));
const before = sourceHashes();
const started = new Date().toISOString();
const runParent = join(repo, '.local/ai-workflow-sensitivity');
mkdirSync(runParent, { recursive: true });
const output = mkdtempSync(join(runParent, 'run-'));
const temporary = mkdtempSync(join(tmpdir(), 'bnoc-eval-'));
const results = [];
const anchor = "origin: 'assigned', resolvedByWorkItemIds: []";
const injected = "origin: 'assigned', schedule: '2026-10-20T09:00', resolvedByWorkItemIds: []";

function run(label, directory, tests) {
  const start = performance.now();
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...tests], { cwd: directory, encoding: 'utf8', timeout: 60000 });
  const text = (result.stdout || '') + (result.stderr || '');
  writeFileSync(join(output, label + '.log'), text);
  assert.equal(result.error, undefined, `${label}: runner error`);
  assert.equal(result.signal, null, `${label}: terminated`);
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => {
    const match = text.match(new RegExp(`^.*?\\b${key} (\\d+)\\s*$`, 'm'));
    assert.ok(match, `${label}: missing ${key} count`);
    return [key, Number(match[1])];
  }));
  assert.equal(counts.cancelled + counts.skipped + counts.todo, 0, `${label}: incomplete test run`);
  results.push({ label, exitCode: result.status, ...counts, elapsedMs: Math.round(performance.now() - start), log: label + '.log' });
  return { exitCode: result.status, text, counts };
}

try {
  for (const variant of ['original', 'mutated']) {
    const directory = join(temporary, variant);
    mkdirSync(directory);
    cpSync(source, join(directory, 'src'), { recursive: true });
    symlinkSync(join(repo, 'frontend/node_modules'), join(directory, 'node_modules'), 'dir');
    cpSync(suite, join(directory, 'schedule-contract.test.mjs'));
    if (variant === 'mutated') {
      const path = join(directory, 'src/workflow/requestCommands.mjs');
      const text = readFileSync(path, 'utf8');
      assert.equal(text.split(anchor).length, 2, 'Mutation must have exactly one target');
      const changed = text.replace(anchor, injected);
      const lines = text.split('\n');
      const index = lines.findIndex(line => line.includes(anchor));
      writeFileSync(path, changed);
      writeFileSync(join(output, 'mutation.patch'), `--- original/src/workflow/requestCommands.mjs\n+++ mutated/src/workflow/requestCommands.mjs\n@@ -${index + 1},1 +${index + 1},1 @@\n-${lines[index]}\n+${changed.split('\n')[index]}\n`);
    }
    const previousTests = files(join(directory, 'src')).filter(path => path.endsWith('.test.mjs'));
    const existing = run(variant + '-existing', directory, previousTests);
    const contract = run(variant + '-contract', directory, [join(directory, 'schedule-contract.test.mjs')]);
    assert.ok(existing.counts.tests > 0, `${variant}: no existing tests`);
    if (variant === 'original') {
      assert.equal(existing.exitCode, 0, `${variant}: existing tests did not pass`);
      assert.equal(existing.counts.pass, existing.counts.tests, `${variant}: incomplete existing suite`);
    } else {
      // Existing tests may improve and start detecting the injected error.
      assert.ok([0, 1].includes(existing.exitCode), 'Unexpected existing-suite exit code');
      assert.equal(existing.counts.pass + existing.counts.fail, existing.counts.tests);
      assert.doesNotMatch(existing.text, /SyntaxError|ERR_MODULE_NOT_FOUND/);
    }
    assert.equal(contract.counts.tests, 3, `${variant}: missing contract tests`);
    assert.equal(contract.counts.pass, variant === 'original' ? 3 : 2, `${variant}: unexpected contract pass count`);
    assert.equal(contract.counts.fail, variant === 'original' ? 0 : 1, `${variant}: unexpected contract fail count`);
    assert.equal(contract.exitCode, variant === 'original' ? 0 : 1, `${variant}: unexpected contract result`);
    if (variant === 'mutated') {
      assert.match(contract.text, /BNOC_ASSIGNMENT_MUST_NOT_SET_SCHEDULE/);
      assert.doesNotMatch(contract.text, /SyntaxError|ERR_MODULE_NOT_FOUND/);
    }
  }
  assert.deepEqual(sourceHashes(), before, 'Product source changed during the experiment');
  assert.equal(results[0].tests, results[2].tests, 'Existing suite counts differ between variants');
  const summary = { kind: 'test-sensitivity-smoke', nodeVersion: process.version, startedAt: started, completedAt: new Date().toISOString(), result: 'PASS', mutationCount: 1, mutationDiff: 'mutation.patch', productSourceUnchanged: true, existingUnitTestsPerRun: results[0].tests, contractTestsPerRun: results[1].tests, mutatedExistingObservation: results[2].exitCode === 0 ? 'passed' : 'failed-needs-review', results, sourceHashes: before, contractTestSha256: hash(suite), runnerSha256: hash(new URL(import.meta.url)), limitations: ['One intentionally selected defect; not an AI workflow A/B experiment.', 'No productivity or general defect-prevention claim.', 'Existing browser tests were not included.', 'A mutated existing-suite failure is an observation, not automatically a confirmed detection.'] };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ result: summary.result, results, output: relative(repo, output) }, null, 2));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
