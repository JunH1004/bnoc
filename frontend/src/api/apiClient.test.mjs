import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient, ApiError } from './apiClient.mjs';

test('business submission sends the existing id, CSRF and server session; no client actor authority', async () => {
  let sent;
  const client = new ApiClient(async (url, options) => { sent = { url, options }; return new Response(JSON.stringify({ ok: true, requestNumber: '101' }), { headers: { 'Content-Type': 'application/json' } }); });
  client.csrfToken = 'server-csrf';
  const result = await client.dispatch({ type: 'assignTeams', operationId: 'same-retry', requestNumber: '101', expectedRevision: 3, actor: { role: 'bnoc' }, payload: { teamIds: ['정보체계운영반'], priority: '긴급' } });
  assert.equal(sent.options.credentials, 'same-origin', 'SERVER_SESSION_REQUIRED');
  assert.equal(sent.options.headers['X-CSRF-Token'], 'server-csrf', 'CSRF_REQUIRED');
  assert.deepEqual(JSON.parse(sent.options.body), { type: 'assignTeams', operationId: 'same-retry', requestNumber: '101', expectedRevision: 3, payload: { teamIds: ['정보체계운영반'], priority: '긴급' } });
  assert.equal(result.requestNumber, '101');
});

test('query failure stays an error instead of becoming an empty list', async () => {
  const client = new ApiClient(async () => new Response(JSON.stringify({ errorCode: 'FORBIDDEN' }), { status: 403 }));
  await assert.rejects(() => client.getRequestList({}), error => error instanceof ApiError && error.code === 'FORBIDDEN');
});

test('search input is transmitted only by an explicit query and preserves multi-status filters', async () => {
  const urls = [];
  const client = new ApiClient(async url => { urls.push(url); return new Response(JSON.stringify({ data: { items: [] }, total: 0 })); });
  const criteria = { requestNumber: '101', status: ['대기', '문서 대기'], period: { from: '2026-10-01', to: '2026-10-13' } };
  assert.deepEqual(urls, []);
  await client.getRequestList(criteria);
  const url = new URL(urls[0], 'http://localhost');
  assert.equal(url.searchParams.get('requestNumber'), '101');
  assert.deepEqual(url.searchParams.getAll('status'), ['대기', '문서 대기']);
  assert.equal(url.searchParams.get('from'), '2026-10-01');
});

test('query envelope exposes its snapshot and total without returning an empty list on malformed data', async () => {
  const client = new ApiClient(async () => new Response(JSON.stringify({ data: [{ requestNumber: '101' }], queriedAt: '2026-10-13T00:00:00Z', total: 21, page: 1, size: 20 })));
  const result = await client.getRequestList({});
  assert.equal(result.items[0].requestNumber, '101', 'QUERY_ENVELOPE_UNWRAP_REQUIRED');
  assert.equal(result.total, 21);
  assert.equal(result.queriedAt, '2026-10-13T00:00:00Z');
  const malformed = new ApiClient(async () => new Response(JSON.stringify({ data: { total: 0 } })));
  await assert.rejects(() => malformed.getRequestList({}), error => error.code === 'INVALID_RESPONSE', 'MALFORMED_QUERY_MUST_NOT_BECOME_EMPTY');
});

test('session and challenge unwrap the server CSRF without putting browser roles in authentication', async () => {
  const sent = [];
  const client = new ApiClient(async (url, options) => {
    sent.push({ url, options });
    if (url.endsWith('/auth/start')) return new Response(JSON.stringify({ data: { providerUrl: 'http://localhost:8082/login', loginAttempt: 'bound-attempt', csrfToken: 'pre-auth-token' } }));
    if (url.endsWith('/auth/complete')) return new Response(JSON.stringify({ ok: true }));
    return new Response(JSON.stringify({ data: { actor: { id: 'service-user', role: 'requester' }, csrfToken: 'session-token' } }));
  });
  const challenge = await client.startLogin();
  assert.equal(challenge.loginAttempt, 'bound-attempt', 'AUTH_CHALLENGE_UNWRAP_REQUIRED');
  await client.completeLogin('single-use-ticket', challenge.loginAttempt);
  assert.equal(sent[1].options.headers['X-CSRF-Token'], 'pre-auth-token');
  assert.deepEqual(JSON.parse(sent[1].options.body), { ticket: 'single-use-ticket', loginAttempt: 'bound-attempt' });
  const session = await client.session();
  assert.equal(session.actor.id, 'service-user');
  assert.equal(client.csrfToken, 'session-token');
});

test('expired authority triggers reauthentication and processing never reports successful saving', async () => {
  let expired = 0;
  const client = new ApiClient(async () => new Response(JSON.stringify({ code: 'UNAUTHENTICATED', message: 'expired' }), { status: 401 }));
  client.onUnauthenticated = () => expired++;
  await assert.rejects(() => client.getNotifications(), error => error.code === 'UNAUTHENTICATED');
  assert.equal(expired, 1, 'SESSION_EXPIRY_NOTIFY_REQUIRED');
  const pending = new ApiClient(async () => new Response(JSON.stringify({ code: 'PROCESSING', retryAfter: 2 }), { status: 202 }));
  await assert.rejects(() => pending.dispatch({ type: 'createRequest', operationId: 'same-key', payload: {} }), error => error.code === 'PROCESSING', 'PROCESSING_IS_NOT_SAVED');
});

test('lost command response reports an unknown save result and repeats the existing operation id', async () => {
  const sent=[];
  const client=new ApiClient(async(_url,options)=>{ sent.push(JSON.parse(options.body));if(sent.length===1) throw new TypeError('response lost after commit');return new Response(JSON.stringify({ ok:true,requestNumber:'101',replayed:true })); });
  const command={ type:'createRequest',operationId:'same-operation',payload:{ detail:'preserved input' } };
  await assert.rejects(()=>client.dispatch(command),error=>{
    assert.equal(error.code,'NETWORK');
    assert.match(error.message,/저장 결과를 확인하지 못했습니다/,'LOST_COMMAND_MUST_REPORT_UNKNOWN_SAVE_RESULT');
    assert.match(error.message,/같은 제출/,'LOST_COMMAND_MUST_GUIDE_SAME_SUBMISSION_RECHECK');
    return true;
  });
  const result=await client.dispatch(command);
  assert.equal(result.replayed,true);
  assert.deepEqual(sent,[command,command],'UNKNOWN_RESULT_RETRY_MUST_KEEP_OPERATION_ID_AND_INPUT');
  const query=new ApiClient(async()=>{ throw new TypeError('query disconnected'); });
  await assert.rejects(()=>query.getRequestList({}),error=>error.code==='NETWORK' && !error.message.includes('저장 결과'));
});

test('unreadable successful command response is unknown, while unreadable query remains a query error',async()=>{
  const client=new ApiClient(async()=>new Response('not-json',{ status:200 }));
  await assert.rejects(()=>client.dispatch({ type:'createRequest',operationId:'same-operation',payload:{} }),error=>{
    assert.equal(error.code,'INVALID_RESPONSE');
    assert.match(error.message,/저장 결과를 확인하지 못했습니다/,'UNREADABLE_COMMAND_SUCCESS_MUST_REPORT_UNKNOWN_SAVE_RESULT');
    assert.match(error.message,/같은 제출/);
    return true;
  });
  await assert.rejects(()=>client.getRequestList({}),error=>error.code==='INVALID_RESPONSE' && !error.message.includes('저장 결과'));
});

test('confirmed server errors, processing and authentication stay distinct from an unknown command result',async()=>{
  for(const [status,code] of [[503,'SAVE_FAILED'],[202,'PROCESSING'],[401,'UNAUTHENTICATED']]) {
    let expired=0;
    const client=new ApiClient(async()=>new Response(JSON.stringify({ code }),{ status }));client.onUnauthenticated=()=>expired++;
    await assert.rejects(()=>client.dispatch({ type:'createRequest',operationId:'same-operation',payload:{} }),error=>error.code===code && !error.message.includes('저장 결과를 확인하지 못했습니다'));
    assert.equal(expired,status===401 ? 1 : 0);
  }
});
