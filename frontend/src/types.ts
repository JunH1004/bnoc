export type Role = 'requester' | 'bnoc' | 'team' | 'admin';
export type RequestStatus = '대기' | '문서 대기' | '배정' | '작업 중' | '완료' | '취소';
export type WorkItemStatus = '배정' | '작업 중' | '완료' | '반환';
export type ErrorCode = 'VALIDATION' | 'FORBIDDEN' | 'INVALID_STATE' | 'NOT_FOUND' | 'CONFLICT' | 'DUPLICATE_ACTION' | 'SAVE_FAILED' | 'UNAUTHENTICATED' | 'NETWORK' | 'INVALID_RESPONSE' | 'PROCESSING';
export interface Actor { id: string; role: Role; displayName: string; department: string; rank?: string; contactId?: string; teamId?: string; departmentManager?: boolean; accessAdmin?: boolean }
export interface SessionContext { activeActorId: string }
export interface MaintenanceTarget { department: string; rank: string; name: string; phone: string }
export interface AttachmentMeta { id: string; fileName: string; size: number; type: string }
export interface Completion { completedBy: string; completedAt: string; memo?: string }
export interface Request {
  id: string; requestNumber: string; registeredBy: string; requesterActorId?: string; requesterDisplayText: string;
  category: string; subcategories: { systemType?: string; resourceType?: string; workType?: string; meetingType?: string };
  detail: string; location: string; contact: string; equipmentId?: string; maintenanceTarget?: MaintenanceTarget;
  scheduledAt?: string; documentRef?: string; attachments: AttachmentMeta[]; status: RequestStatus;
  registeredAt: string; revision: number
}
export interface WorkItem {
  id: string; requestId: string; workNumber: string; teamId: string; status: WorkItemStatus; schedule?: string; memo?: string;
  returnReason?: string; completion?: Completion; replacesWorkItemId?: string;
  resolvedByWorkItemIds: string[]; origin?: 'assigned' | 'after-action'; revision: number
}
export interface HistoryEntry { targetId: string; actorId: string; at: string; field: string; before: unknown; after: unknown }
export interface Notification { recipientActorId: string; event: string; relatedRequestId?: string; relatedWorkItemId?: string; at: string; read: boolean }
export interface OperationReceipt { operationId: string; actorId: string; fingerprint: string; changedIds: string[]; requestNumber?: string; resultCode: 'OK' }
export interface AppState {
  baselineVersion: string; requests: Request[]; workItems: WorkItem[]; history: HistoryEntry[];
  notifications: Notification[]; receipts: Record<string, OperationReceipt>
}
export interface ViewCommand<P = unknown> { type: string; operationId: string; requestNumber?: string; workNumber?: string; expectedRevision?: number; payload: P }
export interface Command<P = unknown> { type: string; operationId: string; targetId?: string; expectedRevision?: number; payload: P }
export type CommandResult = { ok: true; nextState: AppState; changedIds: string[]; requestNumber?: string; replayed?: boolean } |
  { ok: false; state: AppState; errorCode: ErrorCode; fieldErrors?: Record<string,string>; latestValue?: unknown };
export type ViewCommandResult = { ok: true; requestNumber?: string; workNumber?: string; publicRef?: string; revision?: number; replayed?: boolean } |
  { ok: false; errorCode: ErrorCode; message?: string; fieldErrors?: Record<string,string>; refreshRequired?: boolean };
export type Priority = 'general' | 'urgent' | '일반' | '긴급';
export function priorityLabel(priority?: string | null) { return priority === 'general' || priority === '일반' ? '일반' : priority === 'urgent' || priority === '긴급' ? '긴급' : '미분류'; }
export interface RequestSummary { requestNumber: string; requesterDisplayText: string; category: string; status: RequestStatus; teamIds: string[]; updatedAt: string; priority?: Priority }
export interface HistoryView { at: string; actorLabel: string; field: string; summary: string }
export interface WorkItemView {
  workNumber: string; teamId: string; status: WorkItemStatus; schedule?: string; memo?: string;
  returnReason?: string; completion?: Completion; resolved: boolean; editable: boolean; revision: number; assignedAt?: string;
  assignedPersons?: RosterPerson[]; assignedPersonRefs?: string[]; origin?: 'assigned' | 'after-action'
}
export interface RequestDetail extends RequestSummary {
  detail: string; location: string; contact?: string; subcategories: Request['subcategories']; equipmentId?: string;
  maintenanceTarget?: MaintenanceTarget; scheduledAt?: string; documentRef?: string; registeredBy: string;
  registeredAt: string; revision: number; workItems: WorkItemView[]; attachments: AttachmentMeta[]; history: HistoryView[]; assignedAt?: string; canEdit?: boolean; canCancel?: boolean
}
export interface SearchCriteria { period?: { from: string; to: string }; status?: RequestStatus[]; category?: string; teamId?: string; location?: string; requestNumber?: string; requesterDeptOrName?: string }
export interface ScheduleEntry { workNumber: string; teamId: string; request: RequestSummary; scheduledAt?: string; status: WorkItemStatus }
export interface OverviewCounts { total: number; byStatus: Record<RequestStatus,number>; list: RequestSummary[] }
export interface ServerSession { actor: Actor; teams: string[]; departments: string[]; csrfToken: string; sourceMode?: string; integrationMode?: string }
export interface RosterPerson { personRef: string; displayName: string; active?: boolean }
export interface Roster { department: string; revision: number; entries: RosterPerson[] }
export interface SharedWork { workNumber: string; requestNumber: string; teamId: string; department?: string; category: string; workType?: string; status: WorkItemStatus; priority?: Priority; schedule?: string; scheduledAt?: string; canOpenDetail?: boolean; origin?: string }
export interface WorkOverview { counts: Record<string, number>; byDepartment: { department: string; assigned: number; completed: number; remaining: number; returned: number }[]; items: SharedWork[]; total: number; page?: number; size?: number; queriedAt?: string; unassignedRequests?: number | RequestSummary[]; afterActionCompleted?: number | SharedWork[] }
export interface PersonnelEntry extends RosterPerson { status: 'leave' | 'trip' | 'available' | null }
export interface PersonnelDay { date: string; departments: { department: string; revision: number; submitted: boolean; entries: PersonnelEntry[] }[] }
export interface NightDutyDay { date: string; departments: { department: string; revision: number; submitted: boolean; entries: RosterPerson[] }[] }
export interface SituationSnapshot { kind: string; scopeKey?: string; stageCode?: number | string; stageLabel?: string; observedAt?: string; lastAttempt?: string; lastSuccess?: string; collectionState: 'not_collected' | 'ok' | 'failed' | 'stale' | 'unconfigured'; failureCode?: string; sourceMode: string }
export interface Notice { noticeRef: string; title: string; body: string; createdAt: string; updatedAt: string; createdBy: string; revision: number; attachments: AttachmentMeta[] }
export interface AccessAssignment { subjectRef: string; displayName: string; role: Role; department: string; teamId?: string; departmentManager: boolean; active: boolean; revision: number }
