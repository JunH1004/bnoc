import { localInputToUtc } from '../app/dateTime.mjs';
export function requestPayload(input, role) {
  return {
    ...(role === 'bnoc' ? { requesterDisplayText: input.requesterDisplayText } : {}),
    category: input.category,
    subcategories: input.category === '장비/체계'
      ? { systemType: input.systemType, resourceType: input.resourceType, workType: input.workType, ...(input.resourceType === '전화' && input.phoneType ? { phoneType: input.phoneType } : {}) }
      : { meetingType: input.meetingType },
    detail: input.detail, location: input.location, contact: input.contact,
    ...(input.equipmentId ? { equipmentId: input.equipmentId } : {}),
    ...(input.scheduledAt ? { scheduledAt: localInputToUtc(input.scheduledAt) } : {}),
    ...(input.documentRef ? { documentRef: input.documentRef } : {}),
    ...(input.differentTarget ? { maintenanceTarget: { department: input.targetDepartment, rank: input.targetRank, name: input.targetName, phone: input.targetPhone } } : {}),
    attachments: input.attachments
  };
}
export function afterActionPayload(input, actual) {
  const payload = requestPayload(input, 'team'); delete payload.scheduledAt;
  return { ...payload, actualRequesterText: input.requesterDisplayText, completedConfirmed: actual.done, actualStartedAt: localInputToUtc(actual.started), actualCompletedAt: localInputToUtc(actual.completed), reason: actual.reason, completionMemo: actual.memo };
}
