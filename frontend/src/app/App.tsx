import { useCallback, useEffect, useRef, useState } from 'react';
import type { ErrorCode, ServerSession, ViewCommandResult } from '../types';
import { ApiClient, ApiError } from '../api/apiClient.mjs';
import { errorMessage } from './useResource';
import { UnsavedChangesContext } from './useUnsavedChanges';
import { RequestRegistrationForm, type RunCommand } from '../screens/RequestRegistrationForm';
import { AfterActionReportForm } from '../screens/AfterActionReportForm';
import { RequestListAndSearch } from '../screens/RequestListAndSearch';
import { RequestDetailWorkspace } from '../screens/RequestDetailWorkspace';
import { TeamScheduleView } from '../screens/TeamScheduleView';
import { BnocOverviewView } from '../screens/BnocOverviewView';
import { NotificationInbox } from '../screens/NotificationInbox';
import { SharedWorkOverview } from '../screens/SharedWorkOverview';
import { PersonnelView, NightDutyView, RosterView } from '../screens/PersonnelViews';
import { SituationView } from '../screens/SituationView';
import { NoticeList, NoticeDetail, NoticeEditor } from '../screens/NoticeViews';
import { AccessManagementView } from '../screens/AccessManagementView';
import { LoginPanel } from '../screens/LoginPanel';
const api = new ApiClient();
const routeFromPath = () => {
  try { const path = decodeURIComponent(window.location.pathname).replace(/^\//,'').replace(/\/$/,''); return !path || path === 'login' ? 'requests' : path; }
  catch { return 'not-found'; }
};
export function App() {
  const [session,setSession] = useState<ServerSession | null>(null), [loading,setLoading] = useState(true), [sessionError,setSessionError] = useState('');
  const [expired,setExpired] = useState(false), [route,setRoute] = useState(routeFromPath), [revision,setRevision] = useState(0), [notice,setNotice] = useState('');
  const [routeReceipt,setRouteReceipt] = useState<{path:string;message:string} | null>(null);
  const sessionRef = useRef<ServerSession | null>(null), expiredRef = useRef(false), dirty = useRef(new Set<string>()), routeRef = useRef(route);
  const expiryDialog = useRef<HTMLDialogElement | null>(null);
  const registerDirty = useCallback((id: string, value: boolean) => { if (value) dirty.current.add(id); else dirty.current.delete(id); }, []);
  const acceptSession = useCallback(async (next: ServerSession) => {
    if (sessionRef.current && next.actor.id !== sessionRef.current.actor.id && dirty.current.size > 0 && !window.confirm('다른 사용자로 로그인했습니다. 저장하지 않은 입력을 버리고 해당 사용자로 전환할까요?')) {
      await api.logout(); setNotice('입력을 유지했습니다. 이전 사용자로 다시 로그인하세요.'); expiredRef.current = true; setExpired(true); return;
    }
    const changedUser = sessionRef.current?.actor.id !== next.actor.id;
    if (changedUser) setRouteReceipt(null);
    sessionRef.current = next; setSession(next); expiredRef.current = false; setExpired(false); setSessionError(''); setLoading(false); setRevision(value => value + 1);
    if (changedUser && routeRef.current === 'after-action' && next.actor.role !== 'team') { window.history.replaceState({},'', '/requests'); routeRef.current = 'requests'; setRoute('requests'); }
  }, []);
  const loadSession = useCallback(async () => {
    setLoading(true); setSessionError('');
    try { await acceptSession(await api.session() as ServerSession); }
    catch (error) { if (!(error instanceof ApiError && error.status === 401)) setSessionError(errorMessage(error instanceof Error ? error : new Error('서버 상태를 확인하지 못했습니다.'))); }
    finally { setLoading(false); }
  }, [acceptSession]);
  useEffect(() => {
    api.onUnauthenticated = () => { if (sessionRef.current) { expiredRef.current = true; setExpired(true); } };
    void loadSession();
    return () => { api.onUnauthenticated = null; };
  }, [loadSession]);
  useEffect(() => {
    const pop = () => {
      const next = routeFromPath();
      if (dirty.current.size > 0 && !window.confirm('저장하지 않은 입력이 있습니다. 페이지를 이동할까요?')) { window.history.pushState({},'', '/' + routeRef.current); return; }
      routeRef.current = next; setRoute(next); setNotice(''); setRouteReceipt(null);
    };
    const leave = (event: BeforeUnloadEvent) => { if (dirty.current.size > 0) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('popstate',pop); window.addEventListener('beforeunload',leave);
    return () => { window.removeEventListener('popstate',pop); window.removeEventListener('beforeunload',leave); };
  }, []);
  useEffect(() => { if (expired && expiryDialog.current && !expiryDialog.current.open) expiryDialog.current.showModal(); else if (!expired) expiryDialog.current?.close(); }, [expired]);
  const go = useCallback((path: string, saved = false) => {
    if (path === routeRef.current) return;
    if (!saved && dirty.current.size > 0 && !window.confirm('저장하지 않은 입력이 있습니다. 페이지를 이동할까요?')) return;
    window.history.pushState({},'', '/' + path); routeRef.current = path; setRoute(path); setNotice(''); setRouteReceipt(null); window.scrollTo(0,0);
  }, []);
  const openSaved = (path:string,message?:string) => { go(path,true); setRouteReceipt(message ? {path,message} : null); };
  const run: RunCommand = useCallback(async (type,payload,target,expectedRevision,operationId) => {
    if (expiredRef.current || !sessionRef.current) return { ok:false,errorCode:'UNAUTHENTICATED',message:'다시 로그인한 뒤 저장을 눌러주세요. 입력은 유지됩니다.' };
    try {
      const response = await api.dispatch({ type,payload,requestNumber:target?.requestNumber,workNumber:target?.workNumber,expectedRevision,operationId:operationId ?? crypto.randomUUID() }) as ViewCommandResult;
      if (!response.ok) return response;
      setRevision(value => value + 1); setNotice(''); return response;
    } catch (error) {
      if (error instanceof ApiError) return { ok:false,errorCode:error.code as ErrorCode,message:error.message,fieldErrors:error.fieldErrors,refreshRequired:error.refreshRequired };
      return { ok:false,errorCode:'SAVE_FAILED',message:'저장 결과를 확인하지 못했습니다. 입력을 유지하고 같은 제출로 다시 시도하세요.' };
    }
  }, []);
  const logout = async () => {
    if (dirty.current.size > 0 && !window.confirm('저장하지 않은 입력이 있습니다. 로그아웃할까요?')) return;
    try { await api.logout(); sessionRef.current = null; setSession(null); expiredRef.current = false; setExpired(false); dirty.current.clear(); setNotice(''); setRouteReceipt(null); setRoute('requests'); routeRef.current = 'requests'; window.history.replaceState({},'', '/requests'); }
    catch (error) { setNotice(errorMessage(error instanceof Error ? error : new Error('로그아웃하지 못했습니다.'))); }
  };
  if (loading && !session) return <main><p role="status">서비스 상태를 확인하는 중…</p></main>;
  if (!session) return <main>{sessionError ? <section className="card"><h1>서비스에 연결하지 못했습니다</h1><p className="error" role="alert">{sessionError}</p><button onClick={() => void loadSession()}>다시 연결</button></section> : <LoginPanel api={api} onAuthenticated={acceptSession} />}</main>;
  const actor = session.actor;
  const departmentAccess = actor.role === 'bnoc' || actor.role === 'team' || actor.role === 'admin' || actor.departmentManager;
  const menu = [
    ...(['requester','bnoc','team'].includes(actor.role) ? [['requests',actor.role === 'requester' ? '내 신청' : actor.role === 'bnoc' ? '신청 관리' : '관련 신청']] : []),
    ...(actor.role === 'requester' || actor.role === 'bnoc' ? [['new',actor.role === 'bnoc' ? '대리 등록' : '작업 신청']] : []),
    ...(actor.role === 'bnoc' ? [['overview','요청 현황(BNOC)']] : []),
    ...(actor.role === 'team' ? [['after-action','선조치 후보고']] : []),
    ['operations','부서별 작업 현황'],
    ...(actor.role === 'bnoc' || actor.role === 'team' ? [['schedule',actor.role === 'bnoc' ? '정비 일정' : '우리 반 일정']] : []),
    ...(departmentAccess ? [['personnel','병력 현황'],['night-duty','야간 근무'],['roster','부서 명부']] : []),
    ['situation','GPS·CPCON'],['notices','공지게시판'],['notifications','알림함'],
    ...(actor.accessAdmin || actor.role === 'admin' ? [['access','권한 관리']] : [])
  ];
  const upload = (file: File) => api.uploadAttachment(file,'request');
  const onOpen = (number: string) => go('requests/' + encodeURIComponent(number));
  const forbidden = <section className="card"><h1>접근 권한이 없습니다</h1><p>현재 사용자의 허용 범위를 확인하세요.</p><button onClick={() => go('operations')}>부서별 작업 현황</button></section>;
  let content;
  if (route.startsWith('requests/')) content = <RequestDetailWorkspace key={route} actor={actor} requestNumber={route.slice('requests/'.length)} api={api} teams={session.teams} run={run} upload={upload} revision={revision} onBack={() => go('requests')} initialMessage={routeReceipt?.path === route ? routeReceipt.message : undefined} />;
  else if (route === 'new') content = actor.role === 'requester' || actor.role === 'bnoc' ? <RequestRegistrationForm actor={actor} run={run} upload={upload} onSaved={(number,message) => openSaved('requests/' + encodeURIComponent(number),message)} /> : forbidden;
  else if (route === 'after-action') content = actor.role === 'team' ? <AfterActionReportForm actor={actor} run={run} upload={upload} onSaved={(number,message) => openSaved('requests/' + encodeURIComponent(number),message)} /> : forbidden;
  else if (route === 'schedule') content = actor.role === 'bnoc' || actor.role === 'team' ? <TeamScheduleView actor={actor} query={api} revision={revision} onOpen={onOpen} /> : forbidden;
  else if (route === 'overview') content = actor.role === 'bnoc' ? <BnocOverviewView query={api} teams={session.teams} revision={revision} onOpen={onOpen} /> : forbidden;
  else if (route === 'operations') content = <SharedWorkOverview api={api} teams={session.teams} revision={revision} onOpen={onOpen} />;
  else if (route === 'personnel') content = departmentAccess ? <PersonnelView actor={actor} api={api} run={run} revision={revision} /> : forbidden;
  else if (route === 'night-duty') content = departmentAccess ? <NightDutyView actor={actor} api={api} run={run} revision={revision} /> : forbidden;
  else if (route === 'roster') content = departmentAccess ? <RosterView actor={actor} api={api} run={run} departments={session.departments} revision={revision} /> : forbidden;
  else if (route === 'situation') content = <SituationView api={api} />;
  else if (route === 'notices') content = <NoticeList actor={actor} api={api} revision={revision} onOpen={ref => go('notices/' + ref)} onNew={() => go('notices/new')} />;
  else if (route === 'notices/new') content = actor.role === 'bnoc' ? <NoticeEditor api={api} run={run} onSaved={(ref,message) => openSaved(ref ? 'notices/' + ref : 'notices',message)} onBack={() => go('notices')} /> : forbidden;
  else if (route.startsWith('notices/')) content = <NoticeDetail key={route} actor={actor} api={api} run={run} refNumber={route.slice('notices/'.length)} revision={revision} onBack={() => go('notices')} initialMessage={routeReceipt?.path === route ? routeReceipt.message : undefined} />;
  else if (route === 'notifications') content = <NotificationInbox actor={actor} query={api} revision={revision} onOpen={onOpen} />;
  else if (route === 'access') content = actor.accessAdmin || actor.role === 'admin' ? <AccessManagementView actor={actor} api={api} run={run} teams={session.teams} departments={session.departments} revision={revision} /> : forbidden;
  else if (route === 'requests') content = actor.role === 'admin' ? <SharedWorkOverview api={api} teams={session.teams} revision={revision} onOpen={onOpen} /> : <RequestListAndSearch actor={actor} query={api} teams={session.teams} revision={revision} onOpen={onOpen} onNew={() => go('new')} />;
  else content = <section className="card"><h1>페이지를 찾을 수 없습니다</h1><button onClick={() => go('requests')}>신청 목록</button></section>;
  return <UnsavedChangesContext.Provider value={registerDirty}>
    <div inert={expired}><a className="skip" href="#main">본문으로 건너뛰기</a><header><div className="header-main"><button className="brand" onClick={() => go('requests')}>BNOC <span>업무 관리</span></button><div className="header-actions"><div className="identity"><strong>{actor.displayName}</strong><small>{actor.department}</small></div><button onClick={() => void logout()}>로그아웃</button></div></div><nav aria-label="주 메뉴">{menu.map(([path,label]) => <button key={path} aria-current={route === path || (path === 'notices' && route.startsWith('notices/')) ? 'page' : undefined} onClick={() => go(path)}>{label}</button>)}</nav></header>
      <main id="main" tabIndex={-1}>{notice && <p className="error" role="alert">{notice}</p>}<div key={actor.id}>{content}</div></main>
    </div>
    {expired && <dialog ref={expiryDialog} className="reauth-dialog" aria-label="로그인 만료" onCancel={event => event.preventDefault()}>{notice && <p className="notice">{notice}</p>}<LoginPanel api={api} expired onAuthenticated={acceptSession} /></dialog>}
  </UnsavedChangesContext.Provider>;
}
