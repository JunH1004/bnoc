import test from 'node:test';
import assert from 'node:assert/strict';
import { requestFieldErrors, focusFormError, saveFailureMessage } from './formFeedback.mjs';

test('server subtype group errors identify missing active choices without marking valid or hidden choices', () => {
  const input = { category:'장비/체계', systemType:'인터넷', resourceType:'PC', workType:'', meetingType:'', phoneType:'' };
  const errors = { subcategories:'허용된 값을 선택하세요.' };
  const mapped = requestFieldErrors(input, errors);
  assert.equal(mapped.workType, errors.subcategories, 'SUBCATEGORY_ERROR_MUST_REACH_MISSING_CHOICE');
  assert.equal(mapped.systemType, undefined);
  assert.equal(mapped.resourceType, undefined);
  assert.equal(mapped.meetingType, undefined);
  assert.equal(mapped.phoneType, undefined);
  assert.deepEqual(errors, { subcategories:'허용된 값을 선택하세요.' }, 'SERVER_ERRORS_MUST_REMAIN_UNCHANGED');
  const meeting = requestFieldErrors({ ...input, category:'회의 지원', meetingType:'' }, errors);
  assert.equal(meeting.meetingType, errors.subcategories);
  assert.equal(meeting.workType, undefined);
  const telephone = requestFieldErrors({ ...input, resourceType:'전화', workType:'지원', phoneType:'잘못된 값' }, errors);
  assert.equal(telephone.phoneType, errors.subcategories);
  assert.equal(requestFieldErrors({ ...input, resourceType:'전화', workType:'지원' }, errors).phoneType, undefined, 'OPTIONAL_PHONE_TYPE_MUST_STAY_OPTIONAL');
  assert.equal(requestFieldErrors(input, { ...errors, workType:'유형을 선택하세요.' }).workType, '유형을 선택하세요.');
});

test('first field error opens containing optional information before focus; general errors focus the message', () => {
  const events = [];
  const outer = { open:false, parentElement:null };
  const inner = { open:false, parentElement:{ closest:()=>outer } };
  const field = { closest:()=>inner, focus:()=>events.push([inner.open, outer.open]) };
  focusFormError({ querySelector:()=>field }, { focus:()=>events.push('fallback') });
  assert.deepEqual(events, [[true,true]], 'HIDDEN_ERROR_MUST_OPEN_BEFORE_FOCUS');
  focusFormError({ querySelector:()=>null }, { focus:()=>events.push('fallback') });
  assert.equal(events.at(-1), 'fallback');
});

test('unknown saves and expiry retain explicit recovery messages instead of success', () => {
  for (const errorCode of ['SAVE_FAILED','NETWORK','PROCESSING','INVALID_RESPONSE']) assert.match(saveFailureMessage({ ok:false,errorCode }), /결과를 확인하지 못했습니다/);
  assert.match(saveFailureMessage({ ok:false,errorCode:'UNAUTHENTICATED' }), /입력 내용은 유지됩니다/);
  assert.match(saveFailureMessage({ ok:false,errorCode:'CONFLICT' }), /최신 내용/);
  assert.equal(saveFailureMessage({ ok:false,errorCode:'VALIDATION',message:'서버 입력 오류' }), '서버 입력 오류');
});
