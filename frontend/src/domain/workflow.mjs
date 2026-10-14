export const STATUS = Object.freeze({
  REVIEW: 'BNOC 검토', DOCUMENT: '문서 확인 대기', ACCEPTANCE: '작업반 접수 대기',
  PLANNED: '작업 예정', IN_PROGRESS: '작업 중', COMPLETED: '완료', REJECTED: '기각'
});

export function stepWork(work, action, actor) {
  const allowed = { accept: ['ACCEPTANCE', 'PLANNED'], return: ['ACCEPTANCE', 'REVIEW'], start: ['PLANNED', 'IN_PROGRESS'], complete: ['IN_PROGRESS', 'COMPLETED'] };
  const transition = allowed[action];
  if (!transition || actor.role !== 'WORK_DEPT' || actor.departmentId !== work.departmentId || work.status !== transition[0]) {
    throw new Error('현재 상태 또는 권한으로 처리할 수 없습니다.');
  }
  return transition[1];
}

export function requestSummary(request, works) {
  const departments = new Map();
  works.forEach((work, index) => { const key = work.departmentId || index; departments.set(key, [...(departments.get(key) || []), work]); });
  const total = departments.size;
  const done = [...departments.values()].filter(group => group.every(work => work.status === 'COMPLETED')).length;
  const completed = total > 0 && total === done;
  if (request.status === 'REJECTED') return { label: STATUS.REJECTED, total, done, completed: false };
  if (!total) return { label: STATUS[request.status] || STATUS.REVIEW, total, done, completed: false };
  const distinct = [...new Set(works.map(work => work.status))];
  return { label: completed ? '전체 완료' : distinct.length === 1 ? STATUS[distinct[0]] : `${done}/${total}개 작업반 완료`, total, done, completed };
}
