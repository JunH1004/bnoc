import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptsLoginMessage } from './loginProof.mjs';

test('only the opened provider window, its origin and the current challenge may complete login', () => {
  const popup = {}, otherWindow = {};
  const challenge = { providerUrl: 'http://127.0.0.1:8082/login?attempt=bound', loginAttempt: 'bound' };
  const good = { origin: 'http://127.0.0.1:8082', source: popup, data: { type: 'bnoc-auth', ticket: 'one-use', loginAttempt: 'bound' } };
  assert.equal(acceptsLoginMessage(good, popup, challenge), true);
  assert.equal(acceptsLoginMessage({ ...good, source: otherWindow }, popup, challenge), false, 'LOGIN_WINDOW_BINDING_REQUIRED');
  assert.equal(acceptsLoginMessage({ ...good, origin: 'http://127.0.0.1:8081' }, popup, challenge), false, 'LOGIN_PROVIDER_ORIGIN_REQUIRED');
  assert.equal(acceptsLoginMessage({ ...good, data: { ...good.data, loginAttempt: 'other' } }, popup, challenge), false, 'LOGIN_ATTEMPT_BINDING_REQUIRED');
  assert.equal(acceptsLoginMessage({ ...good, data: { ...good.data, ticket: '' } }, popup, challenge), false);
});
