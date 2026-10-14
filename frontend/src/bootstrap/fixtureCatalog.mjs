const teams = ['무선반', '유선반', '전장반(전산장비)', '정체반', '암호반'];
const accounts = [
  { id: 'requester-1', role: 'requester', displayName: '한서준', department: '정보지원과', rank: '주무관', contactId: 'ID-260901' },
  { id: 'bnoc-1', role: 'bnoc', displayName: '윤하린', department: '운영지원실', rank: '주무관', contactId: 'ID-260902' },
  { id: 'team-1', role: 'team', displayName: '서지후', department: '무선반', rank: '주무관', contactId: 'ID-260903', teamId: '무선반' },
  { id: 'team-2', role: 'team', displayName: '오가은', department: '유선반', rank: '주무관', contactId: 'ID-260904', teamId: '유선반' },
  { id: 'team-3', role: 'team', displayName: '임도윤', department: '전장반(전산장비)', rank: '주무관', contactId: 'ID-260905', teamId: '전장반(전산장비)' },
  { id: 'team-4', role: 'team', displayName: '정수아', department: '정체반', rank: '주무관', contactId: 'ID-260906', teamId: '정체반' },
  { id: 'team-5', role: 'team', displayName: '차민재', department: '암호반', rank: '주무관', contactId: 'ID-260907', teamId: '암호반' }
];
const time = '2026-09-18T09:00:00+09:00';
const common = {
  registeredBy: 'requester-1', requesterActorId: 'requester-1',
  requesterDisplayText: '주무관 한서준 · 정보지원과', category: '장비/체계',
  subcategories: { systemType: '인트라넷', resourceType: 'PC', workType: '고장' },
  location: '새빛센터 2층', contact: '912-4101', attachments: [], registeredAt: time, revision: 1
};
const descriptions = [
  ['REQ-101', '대기', '업무용 PC 화면 출력 불량', '별관 2층'],
  ['REQ-102', '문서 대기', '회의실 전화 회선 점검', '새빛센터 3층'],
  ['REQ-103', '배정', '자료실 장비 설치', '자료실 1층'],
  ['REQ-104', '작업 중', '네트워크 연결 점검', '별관 4층'],
  ['REQ-105', '완료', '접속 환경 정비', '새빛센터 1층'],
  ['REQ-106', '취소', '전화기 교체 요청', '별관 1층'],
  ['REQ-107', '배정', '회의실 연결 장비 재점검', '새빛센터 5층'],
  ['REQ-108', '완료', '현장 선조치 결과 보고', '자료실 3층']
];
const requests = descriptions.map(([id, status, detail, location]) => ({
  ...common, id, requestNumber: id.replace('REQ-', ''), status, detail, location,
  ...(id === 'REQ-103' ? { attachments: [{ id: 'ATT-1', fileName: '장비점검표.pdf', size: 2048, type: 'application/pdf' }] } : {}),
  ...(id === 'REQ-108' ? { registeredBy: 'team-1', requesterActorId: undefined, requesterDisplayText: '주무관 배지안 · 기획지원실' } : {})
}));
const workCounts = new Map();
const workItems = [
  ['WORK-103-A','REQ-103','무선반','배정'], ['WORK-103-B','REQ-103','유선반','배정'],
  ['WORK-104','REQ-104','무선반','작업 중'], ['WORK-105','REQ-105','유선반','완료'],
  ['WORK-107-OLD','REQ-107','전장반(전산장비)','반환'],
  ['WORK-107-NEW','REQ-107','정체반','배정'],
  ['WORK-108','REQ-108','무선반','완료']
].map(([id, requestId, teamId, status]) => {
  const sequence = (workCounts.get(requestId) ?? 0) + 1;
  workCounts.set(requestId, sequence);
  return {
    id, requestId, workNumber: `${requestId.replace('REQ-', '')}-${sequence}`,
    teamId, status, origin: requestId === 'REQ-108' ? 'after-action' : 'assigned', revision: 1, resolvedByWorkItemIds: [],
    ...(id === 'WORK-103-A' ? { schedule: '2026-09-23T10:00' } : {}),
    ...(id === 'WORK-107-OLD' ? { returnReason: '담당 작업반 변경 필요', resolvedByWorkItemIds: ['WORK-107-NEW'] } : {}),
    ...(id === 'WORK-107-NEW' ? { replacesWorkItemId: 'WORK-107-OLD' } : {}),
    ...(status === '완료' ? { completion: { completedBy: teamId === '무선반' ? 'team-1' : 'team-2', completedAt: time } } : {})
  };
});
const history = requests.map(request => ({ targetId: request.id, actorId: request.registeredBy, at: time, field: '상태', before: null, after: request.status }));
const notifications = [
  { recipientActorId: 'bnoc-1', event: '요청 등록', relatedRequestId: 'REQ-101', at: time, read: false },
  { recipientActorId: 'team-1', event: '작업 배정', relatedRequestId: 'REQ-103', relatedWorkItemId: 'WORK-103-A', at: time, read: false },
  { recipientActorId: 'bnoc-1', event: '작업 반환', relatedRequestId: 'REQ-107', relatedWorkItemId: 'WORK-107-OLD', at: time, read: false },
  { recipientActorId: 'requester-1', event: '문서 대기', relatedRequestId: 'REQ-102', at: time, read: false },
  { recipientActorId: 'requester-1', event: '배정', relatedRequestId: 'REQ-103', at: time, read: false },
  { recipientActorId: 'requester-1', event: '작업 중', relatedRequestId: 'REQ-104', at: time, read: false },
  { recipientActorId: 'requester-1', event: '완료', relatedRequestId: 'REQ-105', at: time, read: false },
  { recipientActorId: 'requester-1', event: '취소', relatedRequestId: 'REQ-106', at: time, read: false },
  { recipientActorId: 'bnoc-1', event: '선조치 후보고', relatedRequestId: 'REQ-108', relatedWorkItemId: 'WORK-108', at: time, read: false }
];
export class FixtureCatalog {
  static load(version = '1') {
    return structuredClone({ version, teams, accounts, requests, workItems, history, notifications });
  }
}
