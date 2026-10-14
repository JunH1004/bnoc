import { RequestQueryService } from './requestQueryService.mjs';
export class HistoryAndNotificationQueryService {
  constructor(store) { this.store = store; this.requests = new RequestQueryService(store); }
  getNotifications() {
    const actor = this.store.getActor();
    const state = this.store.getSnapshot();
    return state.notifications.filter(item => item.recipientActorId === actor.id).map(item => {
      const request = state.requests.find(row => row.id === item.relatedRequestId);
      const work = state.workItems.find(row => row.id === item.relatedWorkItemId);
      return { ...item, relatedRequestId: request?.requestNumber, relatedWorkItemId: work?.workNumber };
    }).reverse();
  }
  getHistory(requestNumber) {
    const actor = this.store.getActor();
    const state = this.store.getSnapshot();
    const request = state.requests.find(item => item.requestNumber === requestNumber);
    if (!request || !this.requests.visible(request, state)) return [];
    const allowedWorks = state.workItems.filter(work => work.requestId === request.id && (actor.role !== 'team' || work.teamId === actor.teamId)).map(work => work.id);
    return state.history.filter(entry => entry.targetId === request.id || allowedWorks.includes(entry.targetId))
      .filter(entry => actor.role !== 'requester' || (entry.targetId === request.id && ['등록','상태','detail','location','contact','scheduledAt','documentRef','attachments'].includes(entry.field)))
      .filter(entry => actor.role !== 'team' || !(entry.field === 'contact' || entry.field === '반환 사유'))
      .map(entry => ({
        at: entry.at, actorLabel: actor.role === 'requester' && entry.actorId !== actor.id ? '담당자' : stateActorLabel(this.store.accounts, entry.actorId),
        field: entry.field,
        summary: entry.before == null
          ? `${entry.field}: ${String(entry.after ?? '없음')}`
          : `${entry.field}: ${String(entry.before)} → ${String(entry.after ?? '없음')}`
      })).reverse();
  }
}
const stateActorLabel = (accounts, id) => accounts.find(actor => actor.id === id)?.displayName ?? '담당자';
