export function requestFieldErrors(input, errors) {
  const mapped = { ...errors };
  if (!errors.subcategories) return mapped;
  const choices = {
    systemType:['인트라넷','인터넷','AFCCS','KJCCS','기타'],
    resourceType:['PC','컴퓨터','프린터','회선','전화','기타'],
    workType:['신설','고장','지원','대여','점검','이전','기타'],
    meetingType:['화상회의','일반회의','기타'],
    phoneType:['IP','아날로그','인터컴','비상벨']
  };
  const active = input.category === '장비/체계' ? ['systemType','resourceType','workType'] : input.category === '회의 지원' ? ['meetingType'] : [];
  if (input.category === '장비/체계' && input.resourceType === '전화' && input.phoneType) active.push('phoneType');
  for (const key of active) if (!choices[key].includes(input[key])) mapped[key] ??= errors.subcategories;
  return mapped;
}

export function focusFormError(container, fallback) {
  const field = container?.querySelector('input[aria-invalid="true"]:not(:disabled), select[aria-invalid="true"]:not(:disabled), textarea[aria-invalid="true"]:not(:disabled), button[aria-invalid="true"]:not(:disabled), [tabindex][aria-invalid="true"]');
  if (!field) { fallback?.focus(); return; }
  let disclosure = field.closest('details');
  while (disclosure) { disclosure.open = true; disclosure = disclosure.parentElement?.closest('details'); }
  field.focus();
}

export function saveFailureMessage(result) {
  return result.message ?? (result.errorCode === 'UNAUTHENTICATED'
    ? '로그인이 만료됐습니다. 다시 로그인하세요. 입력 내용은 유지됩니다.'
    : ['SAVE_FAILED', 'NETWORK', 'PROCESSING', 'INVALID_RESPONSE'].includes(result.errorCode)
      ? '저장 결과를 확인하지 못했습니다. 입력을 유지하고 같은 제출로 다시 시도하세요.'
      : result.errorCode === 'CONFLICT'
        ? '다른 변경이 반영됐습니다. 입력을 유지하고 최신 내용을 확인하세요.'
        : '저장하지 못했습니다. 입력 항목을 확인하세요. 입력 내용은 유지됩니다.');
}
