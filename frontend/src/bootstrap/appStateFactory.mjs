import { FixtureCatalog } from './fixtureCatalog.mjs';

export class AppStateFactory {
  static createInitialState(bundle) {
    const ids = new Set();
    for (const entity of [...bundle.accounts, ...bundle.requests, ...bundle.workItems]) {
      if (ids.has(entity.id)) throw new Error('중복 식별값');
      ids.add(entity.id);
    }
    const requestNumbers = new Set();
    for (const request of bundle.requests) {
      if (!/^\d{3,}$/.test(request.requestNumber) || requestNumbers.has(request.requestNumber)) throw new Error('요청 번호 오류');
      requestNumbers.add(request.requestNumber);
      if (!ids.has(request.registeredBy) || (request.requesterActorId && !ids.has(request.requesterActorId))) throw new Error('요청 참조 오류');
    }
    const workNumbers = new Set();
    for (const work of bundle.workItems) {
      if (!/^\d{3,}-\d+$/.test(work.workNumber) || workNumbers.has(work.workNumber)) throw new Error('작업 번호 오류');
      workNumbers.add(work.workNumber);
      if (!ids.has(work.requestId) || !bundle.teams.includes(work.teamId)) throw new Error('작업 참조 오류');
    }
    return structuredClone({ baselineVersion: bundle.version, requests: bundle.requests, workItems: bundle.workItems, history: bundle.history, notifications: bundle.notifications, receipts: {} });
  }
  static restoreBaseline() { return this.createInitialState(FixtureCatalog.load()); }
}
