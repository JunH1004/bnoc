export class RequestQueryService {
  constructor(store) { this.store = store; }
  visible(request, state) {
    const actor = this.store.getActor();
    if (actor.role === 'bnoc') return true;
    if (actor.role === 'requester') return request.requesterActorId === actor.id;
    return state.workItems.some(work => work.requestId === request.id && work.teamId === actor.teamId);
  }
  summary(request, state) {
    const entries = state.history.filter(item => item.targetId === request.id);
    return {
      requestNumber: request.requestNumber, requesterDisplayText: request.requesterDisplayText,
      category: request.category, status: request.status,
      teamIds: [...new Set(state.workItems.filter(work => work.requestId === request.id).map(work => work.teamId))],
      updatedAt: entries.at(-1)?.at ?? request.registeredAt
    };
  }
  getRequestList(filter = {}) { return this.searchRequests(filter); }
  searchRequests(criteria = {}) {
    const actor = this.store.getActor();
    const state = this.store.getSnapshot();
    return state.requests.filter(request => this.visible(request, state) &&
      (!criteria.period?.from || request.registeredAt.slice(0,10) >= criteria.period.from) &&
      (!criteria.period?.to || request.registeredAt.slice(0,10) <= criteria.period.to) &&
      (!criteria.status?.length || criteria.status.includes(request.status)) &&
      (!criteria.category || request.category === criteria.category) &&
      (!criteria.teamId || state.workItems.some(work => work.requestId === request.id && work.teamId === criteria.teamId)) &&
      (!criteria.location || request.location.includes(criteria.location)) &&
      (!criteria.requestNumber || request.requestNumber.includes(criteria.requestNumber)) &&
      (!criteria.requesterDeptOrName || actor.role !== 'bnoc' || request.requesterDisplayText.includes(criteria.requesterDeptOrName))
    ).map(request => this.summary(request, state)).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  getRequestDetail(requestNumber) {
    const actor = this.store.getActor();
    const state = this.store.getSnapshot(), request = state.requests.find(item => item.requestNumber === requestNumber);
    if (!request || !this.visible(request, state)) return null;
    const summary = this.summary(request, state);
    const workItems = state.workItems.filter(work => work.requestId === request.id).map(work => {
      const common = { workNumber: work.workNumber, teamId: work.teamId, status: work.status, schedule: work.schedule, revision: work.revision, resolved: !!work.resolvedByWorkItemIds.length, editable: work.origin !== 'after-action' && !work.resolvedByWorkItemIds.length };
      return (
      actor.role === 'requester'
        ? common
        : actor.role === 'team' && work.teamId !== actor.teamId
          ? common
          : { ...common, memo: work.memo, returnReason: work.returnReason, completion: structuredClone(work.completion) }
      );
    });
    return {
      ...summary, detail: request.detail, location: request.location, contact: actor.role === 'requester' || actor.role === 'bnoc' ? request.contact : undefined,
      subcategories: structuredClone(request.subcategories), equipmentId: request.equipmentId,
      maintenanceTarget: actor.role === 'bnoc' ? structuredClone(request.maintenanceTarget) : undefined,
      documentRef: request.documentRef, scheduledAt: request.scheduledAt,
      registeredBy: request.registeredBy, registeredAt: request.registeredAt, revision: request.revision,
      workItems, attachments: structuredClone(request.attachments),
      history: []
    };
  }
}
