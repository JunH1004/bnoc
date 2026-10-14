import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { ApiError } from '../api/apiClient.mjs';

// Run the actual hook with retained state/effects and controllable HTTP promises.
function resourceHook() {
  const states = [], effects = [];
  let cursor = 0, pending = [];
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useEffect(effect, dependencies) {
      const index = cursor++, previous = effects[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        pending.push(() => { previous?.cleanup?.(); effects[index] = { dependencies, cleanup: effect() }; });
      }
    },
    useCallback(callback) { cursor++; return callback; }
  };
  const source = readFileSync(new URL('./useResource.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'exports', 'module', output)(path => path === 'react' ? react : { ApiError }, module.exports, module);
  return (load, dependencies, context) => {
    cursor = 0; pending = [];
    const result = module.exports.useResource(load, dependencies, context);
    pending.forEach(effect => effect());
    return result;
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settled = () => new Promise(resolve => setImmediate(resolve));

test('two-argument resource callers keep data, errors and explicit reload behavior', async () => {
  const render = resourceHook();
  let calls = 0;
  const load = async () => ({ total: ++calls });
  render(load, []); await settled();
  let result = render(load, []);
  assert.equal(result.data.total, 1);
  assert.equal(result.loading, false);
  assert.equal(result.error, null);
  result.reload(); render(load, []); await settled();
  result = render(load, []);
  assert.equal(result.data.total, 2);
  assert.equal(calls, 2);
});

test('pending and failed conditions keep the successful data, conditions and confirmation together', async () => {
  const render = resourceHook(), first = deferred(), next = deferred();
  const loadFirst = () => first.promise, loadNext = () => next.promise;
  const firstContext = { conditions: '상태 완료', page: 1 };
  render(loadFirst, ['완료'], firstContext);
  first.resolve({ items: ['101'], total: 1 }); await settled();
  let result = render(loadFirst, ['완료'], firstContext);
  assert.ok(result.success, 'QUERY_SUCCESS_MUST_INCLUDE_CONTEXT');
  assert.deepEqual(result.success.context, { conditions: '상태 완료', page: 1 });
  assert.equal(Number.isNaN(Date.parse(result.success.confirmedAt)), false);
  const successful = result.success;

  const nextContext = { conditions: '상태 배정', page: 0 };
  render(loadNext, ['배정'], nextContext);
  result = render(loadNext, ['배정'], nextContext);
  assert.equal(result.loading, true);
  assert.equal(result.success, successful, 'PENDING_QUERY_MUST_KEEP_SUCCESSFUL_CONTEXT');
  assert.deepEqual(result.data.items, ['101']);
  next.reject(new Error('다음 조건 조회 실패')); await settled();
  result = render(loadNext, ['배정'], nextContext);
  assert.equal(result.error.message, '다음 조건 조회 실패');
  assert.equal(result.loading, false);
  assert.equal(result.success, successful, 'FAILED_QUERY_MUST_KEEP_SUCCESSFUL_CONTEXT');
  assert.deepEqual(result.data.items, ['101'], 'FAILED_QUERY_MUST_NOT_REPLACE_DATA_WITH_EMPTY_RESULT');
});

test('an aborted older query cannot replace the newer successful result or its conditions', async () => {
  const render = resourceHook(), old = deferred(), current = deferred();
  const loadOld = () => old.promise, loadCurrent = () => current.promise;
  render(loadOld, ['old'], { conditions: '이전 기간' });
  render(loadCurrent, ['current'], { conditions: '현재 기간' });
  current.resolve({ items: ['102'] }); await settled();
  let result = render(loadCurrent, ['current'], { conditions: '현재 기간' });
  assert.ok(result.success, 'QUERY_SUCCESS_MUST_INCLUDE_CONTEXT');
  const successful = result.success;
  old.resolve({ items: ['101'] }); await settled();
  result = render(loadCurrent, ['current'], { conditions: '현재 기간' });
  assert.deepEqual(result.data.items, ['102'], 'ABORTED_QUERY_MUST_NOT_REPLACE_NEWER_RESULT');
  assert.equal(result.success, successful);
  assert.deepEqual(result.success.context, { conditions: '현재 기간' });
});
