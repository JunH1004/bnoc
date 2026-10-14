import { FixtureCatalog } from '../bootstrap/fixtureCatalog.mjs';
import { RequestQueryService } from './requestQueryService.mjs';
export class OpsQueryService {
  constructor(store) { this.store = store; this.requests = new RequestQueryService(store); }
  getTeamSchedule(range = {}) {
    const actor = this.store.getActor();
    if (actor.role !== 'team') return [];
    const state = this.store.getSnapshot();
    return state.workItems.filter(work => work.teamId === actor.teamId && (!range.from || !work.schedule || work.schedule.slice(0,10) >= range.from) && (!range.to || !work.schedule || work.schedule.slice(0,10) <= range.to))
      .map(work => ({ workNumber: work.workNumber, teamId: work.teamId, request: this.requests.summary(state.requests.find(request => request.id === work.requestId), state), scheduledAt: work.schedule, status: work.status }))
      .sort((a,b) => (a.scheduledAt ?? '9999').localeCompare(b.scheduledAt ?? '9999'));
  }
  getBnocOverview(filter = {}) {
    const statuses = ['대기','문서 대기','배정','작업 중','완료','취소'];
    if (this.store.getActor()?.role !== 'bnoc') return { total: 0, byStatus: Object.fromEntries(statuses.map(status => [status, 0])), list: [], teams: FixtureCatalog.load().teams };
    const list = this.requests.searchRequests(filter);
    const byStatus = Object.fromEntries(statuses.map(status => [status, list.filter(item => item.status === status).length]));
    return { total: list.length, byStatus, list, teams: FixtureCatalog.load().teams };
  }
}
