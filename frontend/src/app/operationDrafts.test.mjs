import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyPersonnelEntries, currentOperationalResource } from './operationDrafts.mjs';
test('daily personnel sends only selected states and clearing a state leaves it unrecorded', () => {
  const entries = [{ personRef:'first',status:null },{ personRef:'second',status:null }];
  assert.deepEqual(dailyPersonnelEntries(entries,{ first:'leave' }), [{ personRef:'first',status:'leave' }], 'UNRECORDED_PERSONNEL_MUST_NOT_BE_NULL_COMMAND_ENTRY');
  assert.deepEqual(dailyPersonnelEntries([{ personRef:'first',status:'leave' },{ personRef:'second',status:'trip' }], { first:null }), [{ personRef:'second',status:'trip' }], 'CLEARING_PERSONNEL_MUST_OMIT_ENTRY');
});
test('a failed or loading date/department change never authorizes writing the previous response', () => {
  const previous = { data:{ date:'2026-10-01',department:'무선반' },loading:false,error:null };
  assert.equal(currentOperationalResource(previous,'date','2026-10-02'),false,'PREVIOUS_DATE_MUST_NOT_BE_WRITABLE');
  assert.equal(currentOperationalResource(previous,'department','유선반'),false,'PREVIOUS_DEPARTMENT_MUST_NOT_BE_WRITABLE');
  assert.equal(currentOperationalResource({ ...previous,error:new Error('failed') },'date','2026-10-01'),false);
  assert.equal(currentOperationalResource({ ...previous,loading:true },'date','2026-10-01'),false);
  assert.equal(currentOperationalResource(previous,'date','2026-10-01'),true);
});
