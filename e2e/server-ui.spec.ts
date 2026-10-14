import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.BNOC_TEST_URL ?? 'http://127.0.0.1:8083';
const provider = process.env.BNOC_TEST_PROVIDER_URL ?? 'http://127.0.0.1:8082';
const evidence = process.env.BNOC_TEST_EVIDENCE_DIR ?? 'runtime/evidence/backend-implementation-20261013';
const wire = '무선반';
const scriptErrors = new WeakMap<Page, string[]>();
type ApiSurface = Pick<Page, 'request'>;

async function apiRead(page: ApiSurface, resource: string) {
  const response = await page.request.get(resource);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body).toHaveProperty('data');
  expect(Number.isFinite(Date.parse(body.queriedAt))).toBeTruthy();
  return body;
}
async function apiLogin(page: ApiSurface, subject: string) {
  const start = await page.request.get('/api/auth/start');
  expect(start.status()).toBe(200);
  const started = await start.json();
  expect(Number.isFinite(Date.parse(started.queriedAt))).toBeTruthy();
  const challenge = started.data;
  const navigation = new URL(challenge.providerUrl);
  const ticket = await page.request.post(new URL('/identity/issue', provider).toString(), { data: { subject, loginAttempt: challenge.loginAttempt, browserBinding: navigation.searchParams.get('browserBinding') } });
  expect(ticket.status()).toBe(200);
  const complete = await page.request.post('/api/auth/complete', { headers: { Origin: new URL(base).origin, 'X-CSRF-Token': challenge.csrfToken }, data: { ticket: (await ticket.json()).ticket, loginAttempt: challenge.loginAttempt } });
  expect(complete.status()).toBe(200);
  return (await apiRead(page, '/api/session')).data;
}
async function command(page: ApiSurface, type: string, payload: Record<string, unknown>, target: Record<string, unknown> = {}) {
  const session = (await apiRead(page, '/api/session')).data;
  const response = await page.request.post('/api/commands', { headers: { Origin: new URL(base).origin, 'X-CSRF-Token': session.csrfToken }, data: { type, payload, ...target, operationId: randomUUID() } });
  expect(response.status(), `${type} must commit`).toBe(200);
  const result = await response.json();
  expect(result.ok).toBeTruthy();
  return result;
}
function requestPayload(detail: string) {
  return { category: '장비/체계', subcategories: { systemType: '인트라넷', resourceType: 'PC', workType: '지원' }, detail, location: '요청 위치', contact: '000-0000', attachments: [] };
}
async function seed(page: Page, text: string, teamIds?: string[]) {
  await apiLogin(page, 'requester');
  const result = await command(page, 'createRequest', requestPayload(text));
  if (teamIds) {
    await apiLogin(page, 'bnoc');
    const detail = (await apiRead(page, `/api/requests/${result.requestNumber}`)).data;
    await command(page, 'assignTeams', { teamIds, priority: 'general' }, { requestNumber: detail.requestNumber, expectedRevision: detail.revision });
  }
  return result.requestNumber as string;
}
async function departmentRecord(page: Page, kind: 'personnel' | 'night-duty', department: string, date: string) {
  return (await apiRead(page, `/api/${kind}?date=${date}&department=${encodeURIComponent(department)}`)).data.departments.find((item: { department: string }) => item.department === department);
}
async function unenteredPastDates(page: Page, department: string) {
  const selected: string[] = [];
  const start = Date.now() - (30 + parseInt(randomUUID().slice(0, 8), 16) % 3650) * 86400000;
  for (let offset = 0; offset < 64 && selected.length < 2; offset++) {
    const date = new Date(start - offset * 86400000).toISOString().slice(0, 10);
    const records = await Promise.all(['personnel', 'night-duty'].map(kind => departmentRecord(page, kind as 'personnel' | 'night-duty', department, date)));
    if (records.every(record => record?.submitted === false)) selected.push(date);
  }
  expect(selected, 'choose isolated past records without removing existing data').toHaveLength(2);
  return selected;
}
type PublicPerson = { personRef: string; displayName: string; active?: boolean };
async function dailyPersonControl(page: Page, department: string, entries: PublicPerson[], personRef: string) {
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: department, exact: true }) });
  const controls = section.getByRole('combobox');
  await expect(controls).toHaveCount(entries.length);
  const index = entries.findIndex(person => person.personRef === personRef);
  expect(index, 'the selected department date contains the exact public person reference').toBeGreaterThanOrEqual(0);
  const control = controls.nth(index);
  await expect(control).toHaveAccessibleName(`${entries[index].displayName} 현황`);
  return control;
}
async function nightPersonControl(page: Page, department: string, roster: PublicPerson[], retained: PublicPerson[], personRef: string) {
  const active = roster.filter(person => person.active !== false);
  const people = [...active, ...retained.filter(person => !active.some(entry => entry.personRef === person.personRef))];
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: department, exact: true }) });
  const controls = section.getByRole('group', { name: '근무자', exact: true }).getByRole('checkbox');
  await expect(controls).toHaveCount(people.length);
  const index = people.findIndex(person => person.personRef === personRef);
  expect(index, 'active roster and retained historical choices contain the exact public person reference').toBeGreaterThanOrEqual(0);
  const control = controls.nth(index);
  await expect(control).toHaveAccessibleName(people[index].displayName + (people[index].active === false ? ' · 비활성' : ''));
  return control;
}
async function loginWithPopup(page: Page, subject: string) {
  await expect(page.getByRole('button', { name: /SSO.*로그인/ })).toBeVisible();
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: /SSO.*로그인/ }).click();
  const popup = await opened;
  await expect(popup.getByRole('combobox')).toBeVisible();
  await popup.getByRole('combobox').selectOption(subject);
  await popup.getByRole('button', { name: /인증|로그인/ }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  await expect(page.getByLabel('사용자 전환')).toHaveCount(0);
}
async function switchWithPopup(page: Page, subject: string) {
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await loginWithPopup(page, subject);
}
async function fields(page: Page, text: string) {
  await page.getByRole('combobox', { name: '체계 종류', exact: true }).selectOption('인트라넷');
  await page.getByRole('combobox', { name: '자원 유형', exact: true }).selectOption('PC');
  await page.getByRole('combobox', { name: '작업 유형', exact: true }).selectOption('지원');
  await page.getByRole('textbox', { name: /^요청 내용·증상(?:\s|$)/ }).fill(text);
  await page.getByLabel('작업 위치', { exact: true }).fill('요청 위치');
  await page.getByLabel('요청자 군내전화번호', { exact: true }).fill('000-0000');
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'PC_DOCUMENT_MUST_NOT_OVERFLOW').toBeTruthy();
}
async function humanHistory(page: Page, prioritySummary: string, assignedAt: string) {
  const history = page.locator('section.history');
  await expect(history.getByRole('heading', { name: '처리 이력', exact: true })).toBeVisible();
  const priority = history.getByRole('listitem').filter({ hasText: /일반·긴급:/ }).first().locator('strong');
  await expect(priority).toHaveText(prioritySummary);
  const assignment = history.getByRole('listitem').filter({ hasText: /배정 시각\(접수 시간\):/ }).first().locator('strong');
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(assignedAt));
  const part = (type: string) => parts.find(item => item.type === type)!.value;
  const month = Number(part('month')), day = Number(part('day'));
  const hour = part('hour') === '00' ? '(?:00|24)' : part('hour');
  const localTime = new RegExp(`^배정 시각\\(접수 시간\\):\\s*${part('year')}\\D+${month < 10 ? '0?' : ''}${month}\\D+${day < 10 ? '0?' : ''}${day}\\D+${hour}:${part('minute')}\\s*$`);
  await expect(assignment).toHaveText(localTime);
  await expect(history).not.toContainText(/\b(?:urgent|general)\b|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/);
}
async function screenshot(page: Page, info: TestInfo, label: string) {
  const file = path.resolve(evidence, `server-${info.project.name}-${label}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await info.attach(label, { path: file, contentType: 'image/png' });
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  scriptErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
});

test.afterEach(async ({ page }, info) => {
  const errors = scriptErrors.get(page) ?? [];
  await info.attach('browser-script-errors', { body: JSON.stringify(errors), contentType: 'application/json' });
  expect(errors, 'browser scripts must not throw unhandled errors').toEqual([]);
});

test('PC completeness: missing type choices show server group errors and focus the first invalid choice', async ({ page }, info) => {
  await apiLogin(page, 'requester');
  await page.goto('/new');
  await page.getByRole('combobox', { name: '요청 유형', exact: true }).selectOption('장비/체계');
  await page.getByRole('textbox', { name: /^요청 내용·증상(?:\s|$)/ }).fill('유형 선택 오류 안내 확인');
  await page.getByLabel('작업 위치', { exact: true }).fill('요청 위치');
  await page.getByLabel('요청자 군내전화번호', { exact: true }).fill('000-0000');
  const rejected = page.waitForResponse(response => new URL(response.url()).pathname === '/api/commands' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '신청 등록', exact: true }).click();
  const rejectedResponse = await rejected;
  expect(rejectedResponse.status()).toBe(400);
  expect((await rejectedResponse.json()).fieldErrors.subcategories).toBeTruthy();
  const firstType = page.getByRole('combobox', { name: /^체계 종류(?:\s|$)/ });
  await expect(firstType, 'SUBCATEGORY_ERROR_MUST_REACH_MISSING_CHOICE').toHaveAttribute('aria-invalid','true');
  await expect(firstType, 'FIRST_MISSING_CHOICE_MUST_RECEIVE_FOCUS').toBeFocused();
  await expect(page.getByRole('textbox', { name: /^요청 내용·증상(?:\s|$)/ })).toHaveValue('유형 선택 오류 안내 확인');
  await screenshot(page, info, 'type-errors');
  // macOS native option menus do not commit ArrowDown through headless automation.
  // Keep native choice values and server assertions; verify focus, Tab and Enter separately.
  await firstType.selectOption('인트라넷');
  await expect(firstType).toHaveValue('인트라넷');
  await page.keyboard.press('Tab');
  const resource = page.getByRole('combobox', { name: /^자원 유형(?:\s|$)/ });
  await expect(resource).toBeFocused();
  await resource.selectOption('PC');
  await expect(resource).toHaveValue('PC');
  await page.keyboard.press('Tab');
  const workType = page.getByRole('combobox', { name: /^작업 유형(?:\s|$)/ });
  await expect(workType).toBeFocused();
  await workType.selectOption('지원');
  await expect(workType).toHaveValue('지원');
  const submit = page.getByRole('button', { name: '신청 등록', exact: true });
  for (let i = 0; i < 12 && !await submit.evaluate(button => button === document.activeElement); i++) await page.keyboard.press('Tab');
  await expect(submit).toBeFocused();
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/commands' && response.request().method() === 'POST');
  await page.keyboard.press('Enter');
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole('heading', { name: '신청 상세', exact: true })).toBeVisible();
  const number = new URL(page.url()).pathname.split('/').at(-1)!;
  expect((await apiRead(page, `/api/requests/${number}`)).data.detail).toBe('유형 선택 오류 안내 확인');
  await expect(page.getByRole('status').filter({ hasText: `요청 ${number}을 등록했습니다.` })).toBeVisible();
  await page.getByRole('button', { name: '내용 수정', exact: true }).click();
  await page.getByRole('textbox', { name: '내용', exact: true }).fill('유형 선택 후 수정 중');
  await expect(page.getByRole('status').filter({ hasText: `요청 ${number}을 등록했습니다.` })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '저장하지 않은 변경' })).toBeVisible();
});

test('PC completeness: edited and failed searches preserve the actual successful conditions and result', async ({ page }, info) => {
  const number = await seed(page, `조회 맥락 ${info.project.name}`);
  await apiLogin(page, 'requester');
  await page.goto('/requests');
  await page.getByLabel('요청 번호', { exact: true }).fill(number);
  await page.getByText('상세 조회 조건', { exact: true }).click();
  await page.getByLabel('위치', { exact: true }).fill('요청 위치');
  await page.getByText('상세 조회 조건', { exact: true }).click();
  await page.getByRole('button', { name: '검색', exact: true }).click();
  const context = page.locator('.query-context');
  await expect(context).toContainText(`요청 번호: ${number}`);
  await expect(context).toContainText('위치: 요청 위치');
  await expect(context).toContainText('확인 시각:');
  await expect(page.getByRole('button', { name: number, exact: true })).toBeVisible();
  const successful = await context.innerText();
  const requests: string[] = [];
  page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/requests') requests.push(request.url()); });
  await page.getByText('상세 조회 조건', { exact: true }).click();
  await expect(page.getByLabel('위치', { exact: true })).toHaveValue('요청 위치');
  await page.getByText('상세 조회 조건', { exact: true }).click();
  await page.getByLabel('요청 번호', { exact: true }).fill('999999999');
  await expect(context).toContainText('조건 편집 중');
  expect(requests).toHaveLength(0);
  await page.route('**/api/requests?**', route => new URL(route.request().url()).searchParams.get('requestNumber') === '999999999'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'SAVE_FAILED', message: '새 조건 조회에 실패했습니다.' }) }) : route.continue());
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('새 조건 조회에 실패했습니다.');
  await expect(context).toContainText('마지막 성공 결과');
  await expect(context).toContainText(successful.replace('조회 결과','마지막 성공 결과'));
  await expect(context).not.toContainText('999999999');
  await expect(page.getByRole('button', { name: number, exact: true })).toBeVisible();
  await expect(page.getByText('요청 1건', { exact: true })).toBeVisible();
  await screenshot(page, info, 'preserved-query-context');
  await page.unroute('**/api/requests?**');
  await page.getByRole('button', { name: '다시 조회', exact: true }).click();
  await expect(context).toContainText('요청 번호: 999999999');
  await expect(context).not.toContainText('마지막 성공 결과');
  await expect(page.getByText('요청 0건', { exact: true })).toBeVisible();
  await page.getByText('상세 조회 조건', { exact: true }).click();
  const longLocation = 'W'.repeat(200);
  await page.getByLabel('위치', { exact: true }).fill(longLocation);
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await expect(context).toContainText(`위치: ${longLocation}`);
  await noOverflow(page);
  await apiLogin(page, 'bnoc');
  await page.goto('/overview');
  await expect(page.getByRole('heading', { name: '요청 현황(BNOC)', exact: true })).toBeVisible();
  const applied = page.waitForResponse(response => new URL(response.url()).pathname === '/api/overview' && new URL(response.url()).searchParams.get('teamId') === wire);
  await page.getByRole('combobox', { name: '작업반', exact: true }).selectOption(wire);
  expect((await applied).status()).toBe(200);
  await expect(context).toContainText(`작업반: ${wire}`);
  await expect(page.getByRole('button', { name: '검색', exact: true })).toHaveCount(0);
});

test('SR-BE-001,004,005,006,010,011,012,013,015,019,028,031,033,034: real login, registration, classification, work save, refresh and file download', async ({ page }, info) => {
  await page.goto('/requests');
  await expect(page.getByText(/모의 인증|모의 정보|대회용/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /회원가입|계정 생성/ })).toHaveCount(0);
  await loginWithPopup(page, 'requester');
  await page.goto('/new');
  await expect(page.getByRole('heading', { name: '작업 신청', exact: true })).toBeVisible();
  await fields(page, `브라우저 지원 ${info.project.name}`);
  await page.getByText('선택 정보', { exact: true }).click();
  await page.getByLabel('희망 일정', { exact: true }).fill('2026-10-20T10:00');
  await page.getByLabel('첨부파일', { exact: true }).setInputFiles({ name: '저장자료.txt', mimeType: 'text/plain', buffer: Buffer.from('브라우저 파일 저장 확인') });
  await page.getByRole('button', { name: '신청 등록', exact: true }).click();
  await expect(page.getByRole('heading', { name: '신청 상세', exact: true })).toBeVisible();
  const number = new URL(page.url()).pathname.split('/').at(-1)!;
  expect(number).toMatch(/^\d{3,}$/);
  await switchWithPopup(page, 'bnoc');
  await page.goto(`/requests/${number}`);
  await expect(page.getByRole('heading', { name: '신청 상세' })).toBeVisible();
  await expect(page.getByLabel(/반장|작업 예정일/)).toHaveCount(0);
  await page.getByLabel(wire, { exact: true }).check();
  await page.getByRole('button', { name: '선택 작업반 배정', exact: true }).click();
  await expect(page.getByText(/일반.*긴급.*선택/).last()).toBeVisible();
  expect((await apiRead(page, `/api/requests/${number}`)).data.workItems).toHaveLength(0);
  await page.getByRole('combobox', { name: /^일반·긴급(?:\s|$)/ }).selectOption('urgent');
  await page.getByRole('button', { name: '선택 작업반 배정', exact: true }).click();
  await expect.poll(async () => (await apiRead(page, `/api/requests/${number}`)).data.workItems.length).toBe(1);
  const assigned = (await apiRead(page, `/api/requests/${number}`)).data;
  expect(assigned.priority).toBe('urgent');
  expect(assigned.workItems[0].schedule ?? null).toBeNull();
  await expect(page.getByText(/배정 시각|접수 시간/).first()).toBeVisible();
  const publicHistory = (await apiRead(page, `/api/requests/${number}/history`)).data.items;
  const priorityHistory = publicHistory.find((entry: { field: string }) => entry.field === '일반·긴급');
  const assignmentHistory = publicHistory.find((entry: { field: string }) => entry.field === '배정 시각(접수 시간)');
  expect(priorityHistory.field).toBe('일반·긴급'); expect(assignmentHistory.field).toBe('배정 시각(접수 시간)');
  for (const entry of [priorityHistory, assignmentHistory]) {
    expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
    expect(Number.isFinite(Date.parse(entry.at))).toBe(true);
  }
  await humanHistory(page, '일반·긴급: 긴급', assigned.assignedAt);
  await screenshot(page, info, 'assignment');
  await switchWithPopup(page, 'team-wireless');
  await page.goto(`/requests/${number}`);
  await page.getByRole('combobox', { name: '작업 상태', exact: true }).selectOption('완료');
  expect((await apiRead(page, `/api/requests/${number}`)).data.workItems[0].status).toBe('배정');
  await page.getByRole('button', { name: '상태 저장', exact: true }).click();
  await expect.poll(async () => (await apiRead(page, `/api/requests/${number}`)).data.status).toBe('완료');
  await page.getByRole('combobox', { name: '작업 상태', exact: true }).selectOption('배정');
  await page.getByRole('button', { name: '상태 저장', exact: true }).click();
  await expect.poll(async () => (await apiRead(page, `/api/requests/${number}`)).data.workItems[0].status).toBe('배정');
  await page.getByRole('combobox', { name: '작업 상태', exact: true }).selectOption('완료');
  await page.getByRole('button', { name: '상태 저장', exact: true }).click();
  await expect.poll(async () => (await apiRead(page, `/api/requests/${number}`)).data.status).toBe('완료');
  await switchWithPopup(page, 'requester');
  await page.goto(`/requests/${number}`);
  await page.reload();
  await expect(page.getByText('완료', { exact: true }).first()).toBeVisible();
  const savedDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: /저장자료\.txt/ }).click();
  const download = await savedDownload;
  const destination = info.outputPath('stored-attachment.txt');
  await download.saveAs(destination);
  expect(await readFile(destination, 'utf8')).toBe('브라우저 파일 저장 확인');
  await noOverflow(page);
  await screenshot(page, info, 'completed-request');
});

test('SR-BE-017,018,022,023,031,032,033: explicit search, safe shared list and direct-route privacy', async ({ page }, info) => {
  const number = await seed(page, `검색 입력 ${info.project.name}`);
  await apiLogin(page, 'requester');
  await page.goto('/requests');
  await expect(page.getByRole('button', { name: number, exact: true })).toBeVisible();
  const lookups: string[] = [];
  page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/requests') lookups.push(request.url()); });
  await page.getByLabel('요청 번호', { exact: true }).fill('999999999');
  await page.waitForTimeout(350);
  expect(lookups).toHaveLength(0);
  await expect(page.getByRole('button', { name: number, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await expect(page.getByText(/조건에 맞는 신청.*없|조회된 항목 없음/).first()).toBeVisible();
  expect(lookups).toHaveLength(1);
  await page.getByLabel('요청 번호', { exact: true }).fill(number);
  await page.getByLabel('요청 번호', { exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: number, exact: true })).toBeVisible();
  expect(lookups).toHaveLength(2);
  await page.getByRole('button', { name: '초기화', exact: true }).click();
  await expect.poll(() => lookups.length).toBe(3);
  await page.waitForTimeout(300);
  expect(lookups).toHaveLength(3);
  await apiLogin(page, 'bnoc');
  const request = (await apiRead(page, `/api/requests/${number}`)).data;
  await command(page, 'assignTeams', { teamIds: [wire], priority: 'general' }, { requestNumber: number, expectedRevision: request.revision });
  await apiLogin(page, 'requester-secondary');
  await page.goto('/operations');
  await expect(page.getByRole('heading', { name: '부서별 작업 현황', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '부서', exact: true }).selectOption(wire);
  await page.getByText('상세 조회 조건', { exact: true }).click();
  await page.getByRole('combobox', { name: '작업 유형', exact: true }).selectOption('지원');
  const filteredResponse = (index: number) => page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/work-overview' && response.request().method() === 'GET' && response.status() === 200 && url.searchParams.get('teamId') === wire && url.searchParams.get('workType') === '지원' && url.searchParams.get('page') === String(index);
  });
  const row = (publicNumber: string) => page.getByRole('row', { name: new RegExp(`(?:^|\\s)${publicNumber}(?:\\s|$)`) });
  const renderedPage = async (result: { page: number; data: { items: { workNumber?: string; requestNumber: string }[] } }) => {
    await expect(page.getByText(`${result.page + 1}페이지`, { exact: true })).toBeVisible();
    expect(result.data.items.length).toBeGreaterThan(0);
    await expect(row(result.data.items[0].workNumber ?? result.data.items[0].requestNumber)).toBeVisible();
  };
  const searched = filteredResponse(0);
  await page.getByRole('button', { name: '검색', exact: true }).click();
  const firstPage = await (await searched).json();
  expect(firstPage.total).toBeGreaterThan(0);
  await renderedPage(firstPage);
  const targetRow = row(`${number}-1`);
  for (let index = 1; index < Math.ceil(firstPage.total / firstPage.size) && await targetRow.count() === 0; index++) {
    await expect(page.getByRole('button', { name: '다음 페이지', exact: true })).toBeEnabled();
    const nextPage = filteredResponse(index);
    await page.getByRole('button', { name: '다음 페이지', exact: true }).click();
    const next = await (await nextPage).json();
    expect(next.page).toBe(index);
    await renderedPage(next);
  }
  await expect(targetRow).toBeVisible();
  await expect(page.getByText(`검색 입력 ${info.project.name}`, { exact: true })).toHaveCount(0);
  await expect(page.getByText('000-0000', { exact: true })).toHaveCount(0);
  await page.goto(`/requests/${number}`);
  await expect(page.getByRole('heading', { name: '신청 상세', exact: true })).toHaveCount(0);
  await expect(page.getByText(/접근.*없|찾을 수 없/).first()).toBeVisible();
  await page.goto('/operations');
  await noOverflow(page);
  await screenshot(page, info, 'shared-work');
});

test('SR-BE-012,014,015,021,030: real day/week/month calendar and returned-work reassignment', async ({ page }, info) => {
  const number = await seed(page, `일정 확인 ${info.project.name}`, [wire]);
  await apiLogin(page, 'team-wireless');
  let current = (await apiRead(page, `/api/requests/${number}`)).data;
  await command(page, 'updateWork', { nextStatus: '배정', schedule: '2026-10-20T01:00:00Z' }, { requestNumber: number, workNumber: current.workItems[0].workNumber, expectedRevision: current.workItems[0].revision });
  await page.goto('/schedule');
  await expect(page.getByRole('heading', { name: '우리 반 일정', exact: true })).toBeVisible();
  for (const view of ['일', '주', '월']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await expect(page.getByRole('button', { name: view, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await noOverflow(page);
  }
  await page.getByLabel(/기준 날짜|조회 날짜/).fill('2026-10-20');
  await expect(page.getByRole('button', { name: new RegExp(`${number}-1`) }).first()).toBeVisible();
  await screenshot(page, info, 'calendar');
  await page.getByRole('button', { name: new RegExp(`${number}-1`) }).first().click();
  await expect(page.getByRole('heading', { name: '신청 상세' })).toBeVisible();
  await page.getByRole('combobox', { name: '작업 상태', exact: true }).selectOption('반환');
  await page.getByRole('button', { name: '상태 저장', exact: true }).click();
  await expect(page.getByText(/반환 사유.*입력/).first()).toBeVisible();
  await page.getByRole('textbox', { name: /^반환 사유(?:\s|$)/ }).fill('다른 작업반 담당');
  await page.getByRole('button', { name: '상태 저장', exact: true }).click();
  await expect.poll(async () => (await apiRead(page, `/api/requests/${number}`)).data.workItems[0].status).toBe('반환');
  await apiLogin(page, 'bnoc');
  await page.goto(`/requests/${number}`);
  await page.getByLabel('유선반', { exact: true }).check();
  await page.getByRole('button', { name: '재배정', exact: true }).click();
  await expect.poll(async () => (await apiRead(page, `/api/requests/${number}`)).data.workItems.length).toBe(2);
  current = (await apiRead(page, `/api/requests/${number}`)).data;
  expect(current.priority).toBe('general');
  expect(current.workItems.find((item: { teamId: string }) => item.teamId === wire).editable).toBe(false);
});

test('SR-BE-016,024,025,027,033: completed after-action report, department records and BNOC notice attachment', async ({ page }, info) => {
  await apiLogin(page, 'team-wireless');
  await page.goto('/after-action');
  await page.getByLabel('실제 요청자', { exact: true }).fill('요청 부서');
  await fields(page, `완료 후보고 ${info.project.name}`);
  await page.getByRole('button', { name: '후보고 등록', exact: true }).click();
  await expect(page.getByText(/작업을 완료한 뒤 보고/).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^요청 내용·증상(?:\s|$)/ })).toHaveValue(`완료 후보고 ${info.project.name}`);
  await page.getByLabel('실제 시작 시각', { exact: true }).fill('2026-10-12T10:00');
  await page.getByLabel('실제 완료 시각', { exact: true }).fill('2026-10-12T11:00');
  await page.getByRole('textbox', { name: '선조치 사유', exact: true }).fill('직접 요청 완료');
  await page.getByLabel('작업 완료 확인', { exact: true }).check();
  await page.getByRole('button', { name: '후보고 등록', exact: true }).click();
  await expect(page.getByRole('heading', { name: '신청 상세' })).toBeVisible();
  await expect(page.getByText('미분류', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('완료', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '상태 저장' })).toHaveCount(0);
  const manager = await apiLogin(page, 'department-manager');
  const department = manager.actor.department;
  const recordDate = '2026-10-01';
  const rosterBefore = (await apiRead(page, `/api/personnel-roster?department=${encodeURIComponent(department)}`)).data;
  await page.goto('/roster');
  await page.getByRole('button', { name: '인원 추가', exact: true }).click();
  await page.getByLabel('인원 표시명', { exact: true }).last().fill('담당 인원');
  const rosterSaved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/commands' && response.request().method() === 'POST' && response.request().postDataJSON().type === 'savePersonnelRoster' && response.status() === 200);
  await page.getByRole('button', { name: '명부 저장', exact: true }).click();
  await rosterSaved;
  await expect(page.getByText(/저장.*완료|저장했습니다/).first()).toBeVisible();
  const rosterAfter = (await apiRead(page, `/api/personnel-roster?department=${encodeURIComponent(department)}`)).data;
  const introduced = rosterAfter.entries.filter((person: { personRef: string }) => !rosterBefore.entries.some((existing: { personRef: string }) => existing.personRef === person.personRef));
  expect(introduced, 'the displayed role is reused; the server public reference identifies the new person').toHaveLength(1);
  const added = introduced[0];
  expect(added.displayName).toBe('담당 인원'); expect(added.active).toBe(true); expect(added.personRef).toBeTruthy();
  const dateQuery = (kind: 'personnel' | 'night-duty') => page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === `/api/${kind}` && response.request().method() === 'GET' && response.status() === 200 && url.searchParams.get('date') === recordDate;
  });
  const dailyQuery = dateQuery('personnel');
  await page.goto('/personnel');
  await page.getByLabel(/기준 날짜|조회 날짜/).fill(recordDate);
  const daily = (await (await dailyQuery).json()).data;
  const ownDay = daily.departments.find((item: { department: string }) => item.department === department);
  expect(daily.date).toBe(recordDate);
  await expect(page.getByText(`표시 기준일: ${recordDate}`, { exact: true })).toBeVisible();
  const dayControl = await dailyPersonControl(page, department, ownDay.entries, added.personRef);
  await expect(dayControl).toBeEnabled(); await expect(dayControl).toHaveValue('');
  await dayControl.selectOption('leave');
  const dailySaved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/commands' && response.request().method() === 'POST' && response.request().postDataJSON().type === 'saveDailyPersonnel' && response.status() === 200);
  await page.getByRole('button', { name: '현황 저장', exact: true }).click();
  const committedDay = await dailySaved;
  const dailyPayload = committedDay.request().postDataJSON().payload;
  expect(dailyPayload.department).toBe(department); expect(dailyPayload.date).toBe(recordDate);
  expect(dailyPayload.entries.find((person: { personRef: string }) => person.personRef === added.personRef).status).toBe('leave');
  await expect(page.getByText(/저장.*완료|저장했습니다/).first()).toBeVisible();
  const storedDay = await departmentRecord(page, 'personnel', department, recordDate);
  expect(storedDay.entries.find((person: { personRef: string }) => person.personRef === added.personRef).status).toBe('leave');
  await noOverflow(page);
  await screenshot(page, info, 'daily-personnel');
  const nightRosterQuery = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/personnel-roster' && response.request().method() === 'GET' && response.status() === 200 && url.searchParams.get('department') === department;
  });
  const nightQuery = dateQuery('night-duty');
  await page.goto('/night-duty');
  const nightRoster = (await (await nightRosterQuery).json()).data;
  await page.getByLabel('근무 시작일', { exact: true }).fill(recordDate);
  const night = (await (await nightQuery).json()).data;
  expect(night.date).toBe(recordDate); expect(nightRoster.department).toBe(department);
  const ownNight = night.departments.find((item: { department: string }) => item.department === department);
  await expect(page.getByText(`표시 기준일: ${recordDate}`, { exact: true })).toBeVisible();
  const nightControl = await nightPersonControl(page, department, nightRoster.entries, ownNight.entries, added.personRef);
  await expect(nightControl).toBeEnabled(); await expect(nightControl).not.toBeChecked();
  await nightControl.check();
  await expect(nightControl).toBeChecked();
  const nightSaved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/commands' && response.request().method() === 'POST' && response.request().postDataJSON().type === 'saveNightDuty' && response.status() === 200);
  await page.getByRole('button', { name: '야간 근무 저장', exact: true }).click();
  const committedNight = await nightSaved;
  const nightPayload = committedNight.request().postDataJSON().payload;
  const expectedNightRefs = [...ownNight.entries.map((person: { personRef: string }) => person.personRef), added.personRef].sort();
  expect(nightPayload.department).toBe(department); expect(nightPayload.date).toBe(recordDate);
  expect([...nightPayload.personRefs].sort()).toEqual(expectedNightRefs);
  await expect(page.getByText(/저장.*완료|저장했습니다/).first()).toBeVisible();
  const storedNight = await departmentRecord(page, 'night-duty', department, recordDate);
  expect(storedNight.submitted).toBe(true);
  expect(storedNight.entries.map((person: { personRef: string }) => person.personRef).sort()).toEqual(expectedNightRefs);
  expect(storedNight.entries.find((person: { personRef: string }) => person.personRef === added.personRef).displayName).toBe('담당 인원');
  await info.attach('operational-person-reference', { body: JSON.stringify({ department, date: recordDate, addedPersonRef: added.personRef, displayName: added.displayName, previousNightPersonRefs: ownNight.entries.map((person: { personRef: string }) => person.personRef), submittedNightPersonRefs: nightPayload.personRefs, savedNightPersonRefs: storedNight.entries.map((person: { personRef: string }) => person.personRef) }), contentType: 'application/json' });
  await apiLogin(page, 'bnoc');
  await page.goto('/notices/new');
  await page.getByLabel('제목', { exact: true }).fill(`업무 안내 ${info.project.name}`);
  await page.getByRole('textbox', { name: '내용', exact: true }).fill('공지게시판 업무 전달');
  await page.getByLabel('첨부파일', { exact: true }).setInputFiles({ name: '공지문서.txt', mimeType: 'text/plain', buffer: Buffer.from('공지 첨부') });
  await page.getByRole('button', { name: '공지 게시', exact: true }).click();
  await expect(page.getByRole('heading', { name: `업무 안내 ${info.project.name}` })).toBeVisible();
  const noticeRoute = new URL(page.url()).pathname;
  await apiLogin(page, 'bnoc-secondary');
  await page.goto(noticeRoute);
  await page.getByRole('button', { name: '공지 수정', exact: true }).click();
  await page.getByRole('textbox', { name: '내용', exact: true }).fill('다른 BNOC 수정 내용');
  await page.getByRole('button', { name: '수정 저장', exact: true }).click();
  await expect(page.getByText('다른 BNOC 수정 내용', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /공지문서\.txt/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /게시 종료|읽음 확인|숨기기/ })).toHaveCount(0);
  await screenshot(page, info, 'notice');
});

test('SR-BE-024,025,030,032: partial personnel input preserves unentered people and failed date or department queries cannot save old data', async ({ page }) => {
  const session = await apiLogin(page, 'department-manager');
  const department = session.actor.department;
  let roster = (await apiRead(page, `/api/personnel-roster?department=${encodeURIComponent(department)}`)).data;
  const beforeRefs = roster.entries.map((entry: { personRef: string }) => entry.personRef);
  await command(page, 'savePersonnelRoster', { department, entries: [...roster.entries, { displayName: '담당 인원', active: true }, { displayName: '담당 인원', active: true }] }, { expectedRevision: roster.revision });
  roster = (await apiRead(page, `/api/personnel-roster?department=${encodeURIComponent(department)}`)).data;
  const introduced = roster.entries.filter((entry: { personRef: string }) => !beforeRefs.includes(entry.personRef));
  expect(introduced).toHaveLength(2);
  expect(introduced.map((entry: { displayName: string }) => entry.displayName)).toEqual(['담당 인원', '담당 인원']);
  expect(introduced.every((entry: { active: boolean }) => entry.active === true)).toBe(true);
  const [chosen, omitted] = introduced;
  expect(chosen?.personRef).toBeTruthy(); expect(omitted?.personRef).toBeTruthy();
  expect(chosen.personRef).not.toBe(omitted.personRef);
  const [sourceDate, destinationDate] = await unenteredPastDates(page, department);
  const sourceBefore = await departmentRecord(page, 'personnel', department, sourceDate);
  const destination = await departmentRecord(page, 'personnel', department, destinationDate);
  await command(page, 'saveDailyPersonnel', { department, date: destinationDate, entries: [{ personRef: omitted.personRef, status: 'trip' }] }, { expectedRevision: destination.revision });
  const savedDestination = await departmentRecord(page, 'personnel', department, destinationDate);
  const writes: { type: string; payload: { date?: string; entries?: { personRef: string; status: string }[] } }[] = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/commands') writes.push(request.postDataJSON()); });
  await page.goto('/personnel');
  await page.getByLabel('기준 날짜', { exact: true }).fill(sourceDate);
  await expect(page.getByText(`표시 기준일: ${sourceDate}`, { exact: true })).toBeVisible();
  const chosenControl = await dailyPersonControl(page, department, sourceBefore.entries, chosen.personRef);
  const omittedControl = await dailyPersonControl(page, department, sourceBefore.entries, omitted.personRef);
  await expect(omittedControl).toHaveValue(''); await expect(chosenControl).toBeEnabled();
  await chosenControl.selectOption('leave');
  await page.getByRole('button', { name: '현황 저장', exact: true }).click();
  await expect(page.getByText(`${department} · ${sourceDate} 병력 현황을 저장했습니다.`, { exact: true })).toBeVisible();
  const savedSource = await departmentRecord(page, 'personnel', department, sourceDate);
  expect(savedSource.entries.find((entry: { personRef: string }) => entry.personRef === chosen.personRef).status).toBe('leave');
  expect(savedSource.entries.find((entry: { personRef: string }) => entry.personRef === omitted.personRef).status).toBeNull();
  expect(writes.filter(item => item.type === 'saveDailyPersonnel')).toHaveLength(1);
  expect(writes[0].payload.entries).toEqual([{ personRef: chosen.personRef, status: 'leave' }]);
  expect(savedSource.revision, 'equal versions make a wrong-date save possible unless the UI checks its displayed context').toBe(savedDestination.revision);
  await expect(await dailyPersonControl(page, department, savedSource.entries, chosen.personRef)).toHaveValue('leave');

  await page.route('**/api/personnel?**', route => new URL(route.request().url()).searchParams.get('date') === destinationDate
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'SAVE_FAILED', message: '선택한 날짜 조회에 실패했습니다.' }) }) : route.continue());
  await page.getByLabel('기준 날짜', { exact: true }).fill(destinationDate);
  await expect(page.getByText('선택한 날짜 조회에 실패했습니다.', { exact: false })).toBeVisible();
  await expect(page.getByText(new RegExp(`표시 기준일: ${sourceDate}.*마지막 성공 조회`))).toBeVisible();
  await expect(page.getByRole('button', { name: '현황 저장', exact: true })).toBeDisabled();
  await expect(await dailyPersonControl(page, department, savedSource.entries, chosen.personRef)).toBeDisabled();
  expect(writes.filter(item => item.type === 'saveDailyPersonnel')).toHaveLength(1);
  expect(await departmentRecord(page, 'personnel', department, destinationDate)).toEqual(savedDestination);
  await page.unroute('**/api/personnel?**');
  await page.getByRole('button', { name: '다시 조회', exact: true }).click();
  await expect(page.getByText(`표시 기준일: ${destinationDate}`, { exact: true })).toBeVisible();
  await expect(await dailyPersonControl(page, department, savedDestination.entries, omitted.personRef)).toHaveValue('trip');
  await expect(page.getByRole('button', { name: '현황 저장', exact: true })).toBeEnabled();
  await page.getByLabel('기준 날짜', { exact: true }).fill(sourceDate);
  await expect(page.getByText(`표시 기준일: ${sourceDate}`, { exact: true })).toBeVisible();
  const clearingControl = await dailyPersonControl(page, department, savedSource.entries, chosen.personRef);
  await expect(clearingControl).toHaveValue('leave');
  await clearingControl.selectOption('');
  await page.getByRole('button', { name: '현황 저장', exact: true }).click();
  await expect.poll(async () => (await departmentRecord(page, 'personnel', department, sourceDate)).entries.find((entry: { personRef: string }) => entry.personRef === chosen.personRef).status).toBeNull();
  await expect(page.getByRole('button', { name: '현황 저장', exact: true })).toBeEnabled();

  for (const [date, personRef] of [[sourceDate, chosen.personRef], [destinationDate, omitted.personRef]]) {
    const record = await departmentRecord(page, 'night-duty', department, date);
    await command(page, 'saveNightDuty', { department, date, personRefs: [personRef] }, { expectedRevision: record.revision });
  }
  const sourceNight = await departmentRecord(page, 'night-duty', department, sourceDate);
  const destinationNight = await departmentRecord(page, 'night-duty', department, destinationDate);
  await page.goto('/night-duty');
  await page.getByLabel('근무 시작일', { exact: true }).fill(sourceDate);
  await expect(page.getByText(`표시 기준일: ${sourceDate}`, { exact: true })).toBeVisible();
  await expect(await nightPersonControl(page, department, roster.entries, sourceNight.entries, chosen.personRef)).toBeChecked();
  await page.route('**/api/night-duty?**', route => new URL(route.request().url()).searchParams.get('date') === destinationDate
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'SAVE_FAILED', message: '선택한 근무일 조회에 실패했습니다.' }) }) : route.continue());
  await page.getByLabel('근무 시작일', { exact: true }).fill(destinationDate);
  await expect(page.getByText('선택한 근무일 조회에 실패했습니다.', { exact: false })).toBeVisible();
  await expect(page.getByText(new RegExp(`표시 기준일: ${sourceDate}.*마지막 성공 조회`))).toBeVisible();
  await expect(await nightPersonControl(page, department, roster.entries, sourceNight.entries, chosen.personRef)).toBeDisabled();
  await expect(page.getByRole('button', { name: '야간 근무 저장', exact: true })).toBeDisabled();
  expect(writes.filter(item => item.type === 'saveNightDuty')).toHaveLength(0);
  expect(await departmentRecord(page, 'night-duty', department, destinationDate)).toEqual(destinationNight);
  await page.unroute('**/api/night-duty?**');
  await page.getByRole('button', { name: '다시 조회', exact: true }).click();
  await expect(page.getByText(`표시 기준일: ${destinationDate}`, { exact: true })).toBeVisible();
  await expect(await nightPersonControl(page, department, roster.entries, destinationNight.entries, omitted.personRef)).toBeChecked();
  await expect(page.getByRole('button', { name: '야간 근무 저장', exact: true })).toBeEnabled();

  await page.goto('/roster');
  await expect(page.getByRole('heading', { name: department, exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '부서', exact: true }).selectOption(wire);
  await expect(page.getByRole('heading', { name: wire, exact: true })).toBeVisible();
  await page.route('**/api/personnel-roster?**', route => new URL(route.request().url()).searchParams.get('department') === department
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'SAVE_FAILED', message: '선택한 부서 조회에 실패했습니다.' }) }) : route.continue());
  await page.getByRole('combobox', { name: '부서', exact: true }).selectOption(department);
  await expect(page.getByText('선택한 부서 조회에 실패했습니다.', { exact: false })).toBeVisible();
  await expect(page.getByText(new RegExp(`마지막 성공 조회: ${wire}`))).toBeVisible();
  await expect(page.getByRole('button', { name: '명부 저장', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '인원 추가', exact: true })).toHaveCount(0);
  expect(writes.filter(item => item.type === 'savePersonnelRoster')).toHaveLength(0);
  expect((await apiRead(page, `/api/personnel-roster?department=${encodeURIComponent(department)}`)).data).toEqual(roster);
  await page.unroute('**/api/personnel-roster?**');
  await page.getByRole('button', { name: '다시 조회', exact: true }).click();
  await expect(page.getByRole('button', { name: '명부 저장', exact: true })).toBeEnabled();
  await noOverflow(page);
});

test('SR-BE-006,027,032: delayed uploads preserve current fields and mixed upload failures require retry or explicit exclusion', async ({ page }) => {
  await apiLogin(page, 'requester');
  await page.goto('/new');
  await fields(page, '첨부 전 요청 내용');
  let releaseUpload!: () => void, uploadStarted!: () => void;
  const waiting = new Promise<void>(resolve => { releaseUpload = resolve; });
  const started = new Promise<void>(resolve => { uploadStarted = resolve; });
  await page.route('**/api/attachments?**', async route => { uploadStarted(); await waiting; await route.continue(); });
  await page.getByLabel('첨부파일', { exact: true }).setInputFiles({ name: '지연문서.txt', mimeType: 'text/plain', buffer: Buffer.from('지연 업로드 내용') });
  await started;
  await expect(page.getByRole('button', { name: '신청 등록', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: /^요청 내용·증상(?:\s|$)/ }).fill('첨부 중 바꾼 요청 내용');
  await page.getByLabel('작업 위치', { exact: true }).fill('첨부 중 바꾼 위치');
  await page.getByLabel('요청자 군내전화번호', { exact: true }).fill('000-1111');
  releaseUpload();
  await expect(page.getByRole('button', { name: '지연문서.txt 첨부 제외', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^요청 내용·증상(?:\s|$)/ })).toHaveValue('첨부 중 바꾼 요청 내용');
  await expect(page.getByLabel('작업 위치', { exact: true })).toHaveValue('첨부 중 바꾼 위치');
  await expect(page.getByLabel('요청자 군내전화번호', { exact: true })).toHaveValue('000-1111');
  await page.unroute('**/api/attachments?**');
  await page.getByRole('button', { name: '신청 등록', exact: true }).click();
  await expect(page.getByRole('heading', { name: '신청 상세', exact: true })).toBeVisible();
  const savedNumber = new URL(page.url()).pathname.split('/').at(-1)!;
  const saved = (await apiRead(page, `/api/requests/${savedNumber}`)).data;
  expect(saved.detail).toBe('첨부 중 바꾼 요청 내용'); expect(saved.location).toBe('첨부 중 바꾼 위치'); expect(saved.contact).toBe('000-1111');
  expect(saved.attachments.map((file: { fileName: string }) => file.fileName)).toEqual(['지연문서.txt']);

  await page.goto('/new');
  await fields(page, '실패 첨부 처리 후 제출');
  let retryAllowed = false;
  await page.route('**/api/attachments?**', route => {
    const body = route.request().postDataBuffer()?.toString() ?? '';
    if (body.includes('제외문서.txt') || (body.includes('재시도문서.txt') && !retryAllowed)) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'SAVE_FAILED', message: '첨부 저장에 실패했습니다.' }) });
    return route.continue();
  });
  await page.getByLabel('첨부파일', { exact: true }).setInputFiles([
    { name: '재시도문서.txt', mimeType: 'text/plain', buffer: Buffer.from('재시도 보존 내용') },
    { name: '완료문서.txt', mimeType: 'text/plain', buffer: Buffer.from('다른 파일은 성공') },
  ]);
  await expect(page.getByRole('button', { name: '재시도문서.txt 업로드 다시 시도', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '완료문서.txt 첨부 제외', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '신청 등록', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: /^요청 내용·증상(?:\s|$)/ })).toHaveValue('실패 첨부 처리 후 제출');
  await page.getByRole('button', { name: '재시도문서.txt 업로드 다시 시도', exact: true }).click();
  await expect(page.getByText(/파일을 올리는 중/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '재시도문서.txt 업로드 다시 시도', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '신청 등록', exact: true })).toBeDisabled();
  retryAllowed = true;
  await page.getByRole('button', { name: '재시도문서.txt 업로드 다시 시도', exact: true }).click();
  await expect(page.getByRole('button', { name: '재시도문서.txt 첨부 제외', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '신청 등록', exact: true })).toBeEnabled();
  await page.getByLabel('첨부파일', { exact: true }).setInputFiles({ name: '제외문서.txt', mimeType: 'text/plain', buffer: Buffer.from('사용자가 제외') });
  await expect(page.getByRole('button', { name: '제외문서.txt 실패 첨부 제외', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '신청 등록', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '제외문서.txt 실패 첨부 제외', exact: true }).click();
  await expect(page.getByRole('button', { name: '신청 등록', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '신청 등록', exact: true }).click();
  await expect(page.getByRole('heading', { name: '신청 상세', exact: true })).toBeVisible();
  const number = new URL(page.url()).pathname.split('/').at(-1)!;
  const completed = (await apiRead(page, `/api/requests/${number}`)).data;
  expect(completed.attachments.map((file: { fileName: string }) => file.fileName).sort()).toEqual(['완료문서.txt', '재시도문서.txt']);
  expect(completed.detail).toBe('실패 첨부 처리 후 제출');
  await page.unroute('**/api/attachments?**');
  await apiLogin(page, 'bnoc');
  await page.goto('/notices/new');
  await page.getByLabel('제목', { exact: true }).fill('첨부 전 공지 제목');
  await page.getByRole('textbox', { name: '내용', exact: true }).fill('첨부 전 공지 내용');
  let releaseNoticeUpload!: () => void;
  const noticeWaiting = new Promise<void>(resolve => { releaseNoticeUpload = resolve; });
  await page.route('**/api/attachments?**', async route => { await noticeWaiting; await route.continue(); });
  await page.getByLabel('첨부파일', { exact: true }).setInputFiles({ name: '공지지연문서.txt', mimeType: 'text/plain', buffer: Buffer.from('공지 지연 업로드') });
  await expect(page.getByText(/파일을 올리는 중/)).toBeVisible();
  await expect(page.getByRole('button', { name: '공지 게시', exact: true })).toBeDisabled();
  await page.getByLabel('제목', { exact: true }).fill('첨부 중 바꾼 공지 제목');
  await page.getByRole('textbox', { name: '내용', exact: true }).fill('첨부 중 바꾼 공지 내용');
  releaseNoticeUpload();
  await expect(page.getByRole('button', { name: '공지지연문서.txt 첨부 제외', exact: true })).toBeVisible();
  await expect(page.getByLabel('제목', { exact: true })).toHaveValue('첨부 중 바꾼 공지 제목');
  await expect(page.getByRole('textbox', { name: '내용', exact: true })).toHaveValue('첨부 중 바꾼 공지 내용');
  await page.unroute('**/api/attachments?**');
  await page.getByRole('button', { name: '공지 게시', exact: true }).click();
  await expect(page.getByRole('heading', { name: '첨부 중 바꾼 공지 제목', exact: true })).toBeVisible();
  await expect(page.getByText('첨부 중 바꾼 공지 내용', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '공지지연문서.txt', exact: true })).toBeVisible();
  await noOverflow(page);
});

test('SR-BE-007,029,030,032: failed, lost, stale and expired saves retain input and require explicit recovery', async ({ page }) => {
  await apiLogin(page, 'requester');
  await page.goto('/new');
  await page.getByRole('button', { name: '신청 등록', exact: true }).click();
  await expect(page.locator('[aria-invalid="true"]').first()).toBeFocused();
  await fields(page, '저장 입력 보존');
  const submissions: { operationId: string; detail: string }[] = [];
  let intercepted = false;
  let committedNumber = '';
  await page.route('**/api/commands', async route => {
    const payload = route.request().postDataJSON();
    submissions.push({ operationId: payload.operationId, detail: payload.payload.detail });
    if (!intercepted) {
      intercepted = true;
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      committedNumber = (await committed.json()).requestNumber;
      await route.abort('failed');
    }
    else await route.continue();
  });
  await page.getByRole('button', { name: '신청 등록', exact: true }).click();
  await expect(page.getByText(/저장 결과를 확인하지 못했습니다/).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^요청 내용·증상(?:\s|$)/ })).toHaveValue('저장 입력 보존');
  await page.getByRole('button', { name: '신청 등록', exact: true }).click();
  await expect(page.getByRole('heading', { name: '신청 상세' })).toBeVisible();
  expect(submissions.length).toBe(2);
  expect(submissions[1].operationId).toBe(submissions[0].operationId);
  await page.unroute('**/api/commands');
  const number = new URL(page.url()).pathname.split('/').at(-1)!;
  expect(number).toBe(committedNumber);
  expect((await apiRead(page, `/api/requests?requestNumber=${number}`)).total).toBe(1);
  await page.getByRole('button', { name: '내용 수정', exact: true }).click();
  await page.getByRole('textbox', { name: '내용', exact: true }).fill('사용자 편집 중 입력');
  const snapshot = (await apiRead(page, `/api/requests/${number}`)).data;
  await command(page, 'updateRequest', { detail: '서버의 먼저 저장된 내용' }, { requestNumber: number, expectedRevision: snapshot.revision });
  await page.getByRole('button', { name: '수정 저장', exact: true }).click();
  await expect(page.getByText(/다른 변경.*저장|다른 변경.*반영|다른 담당자.*수정/).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: '내용', exact: true })).toHaveValue('사용자 편집 중 입력');
  await page.getByRole('button', { name: '최신 내용 다시 불러오기', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '내용', exact: true })).toHaveValue('서버의 먼저 저장된 내용');
  await page.getByRole('textbox', { name: '내용', exact: true }).fill('세션 만료 뒤 유지');
  const session = (await apiRead(page, '/api/session')).data;
  expect((await page.request.post('/api/auth/logout', { headers: { Origin: new URL(base).origin, 'X-CSRF-Token': session.csrfToken }, data: {} })).status()).toBe(200);
  await page.getByRole('button', { name: '수정 저장', exact: true }).click();
  await expect(page.getByText(/만료|다시 로그인/).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: '내용', exact: true })).toHaveValue('세션 만료 뒤 유지');
  const before = await page.evaluate(() => Object.keys(localStorage));
  expect(before).toHaveLength(0);
  await loginWithPopup(page, 'requester');
  await expect(page.getByRole('textbox', { name: '내용', exact: true })).toHaveValue('세션 만료 뒤 유지');
  await page.getByRole('button', { name: '수정 저장', exact: true }).click();
  await expect.poll(async () => (await apiRead(page, `/api/requests/${number}`)).data.detail).toBe('세션 만료 뒤 유지');
});

test('SR-BE-010,011,019,027,030,032: BNOC drafts retain their starting versions through reauthentication, notice updates, and assignment-to-classification changes', async ({ page, request: otherRequest }, info) => {
  const other = { request: otherRequest };
  const primarySession = await apiLogin(page, 'bnoc');
  const otherSession = await apiLogin(other, 'bnoc-secondary');
  expect(otherSession.actor.id).not.toBe(primarySession.actor.id);
  expect((await apiRead(page, '/api/session')).data.actor.id).toBe(primarySession.actor.id);
  const expire = async () => {
    const session = (await apiRead(page, '/api/session')).data;
    const response = await page.request.post('/api/auth/logout', { headers: { Origin: new URL(base).origin, 'X-CSRF-Token': session.csrfToken }, data: {} });
    expect(response.status()).toBe(200);
  };
  const responseFor = (type: string, status: number) => page.waitForResponse(response => new URL(response.url()).pathname === '/api/commands' && response.request().method() === 'POST' && response.request().postDataJSON().type === type && response.status() === status);
  const refreshFor = (resource: string) => page.waitForResponse(response => new URL(response.url()).pathname === resource && response.request().method() === 'GET' && response.status() === 200);
  const noticeSaved = await command(page, 'createDirective', { title: `재인증 공지 ${info.project.name}`, body: '처음 저장한 공지 내용', attachmentRefs: [] });
  const noticeRef = noticeSaved.publicRef;
  const noticeBefore = (await apiRead(page, `/api/notices/${noticeRef}`)).data;
  await page.goto(`/notices/${noticeRef}`);
  await page.getByRole('button', { name: '공지 수정', exact: true }).click();
  await page.getByLabel('제목', { exact: true }).fill('아직 저장하지 않은 공지 제목');
  await page.getByRole('textbox', { name: '내용', exact: true }).fill('아직 저장하지 않은 공지 내용');
  await command(other, 'updateDirective', { noticeRef, title: '다른 BNOC가 저장한 공지 제목', body: '다른 BNOC가 저장한 공지 내용', attachmentRefs: [] }, { expectedRevision: noticeBefore.revision });
  const noticeLatest = (await apiRead(other, `/api/notices/${noticeRef}`)).data;
  expect(noticeLatest.revision).toBeGreaterThan(noticeBefore.revision);
  await expire();
  const expiredNotice = responseFor('updateDirective', 401);
  await page.getByRole('button', { name: '수정 저장', exact: true }).click();
  expect((await expiredNotice).request().postDataJSON().expectedRevision).toBe(noticeBefore.revision);
  await expect(page.getByRole('dialog', { name: '로그인 만료', exact: true })).toBeVisible();
  const refreshedNotice = refreshFor(`/api/notices/${noticeRef}`);
  await loginWithPopup(page, 'bnoc');
  expect((await (await refreshedNotice).json()).data.revision).toBe(noticeLatest.revision);
  await expect(page.getByRole('dialog', { name: '로그인 만료', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('제목', { exact: true })).toHaveValue('아직 저장하지 않은 공지 제목');
  await expect(page.getByRole('textbox', { name: '내용', exact: true })).toHaveValue('아직 저장하지 않은 공지 내용');
  const noticeConflict = responseFor('updateDirective', 409);
  await page.getByRole('button', { name: '수정 저장', exact: true }).click();
  const conflictedNotice = await noticeConflict;
  expect((await conflictedNotice.json()).code).toBe('CONFLICT');
  expect(conflictedNotice.request().postDataJSON().expectedRevision).toBe(noticeBefore.revision);
  await expect(page.getByRole('textbox', { name: '내용', exact: true })).toHaveValue('아직 저장하지 않은 공지 내용');
  expect((await apiRead(other, `/api/notices/${noticeRef}`)).data).toEqual(noticeLatest);
  await page.getByRole('button', { name: '최신 내용 다시 불러오기', exact: true }).click();
  await expect(page.getByLabel('제목', { exact: true })).toHaveValue('다른 BNOC가 저장한 공지 제목');
  await expect(page.getByRole('textbox', { name: '내용', exact: true })).toHaveValue('다른 BNOC가 저장한 공지 내용');
  await page.getByRole('textbox', { name: '내용', exact: true }).fill('최신 내용 확인 후 다시 작성한 공지');
  const noticeCommitted = responseFor('updateDirective', 200);
  await page.getByRole('button', { name: '수정 저장', exact: true }).click();
  expect((await noticeCommitted).request().postDataJSON().expectedRevision).toBe(noticeLatest.revision);
  await expect(page.getByRole('heading', { name: noticeLatest.title, exact: true })).toBeVisible();
  expect((await apiRead(other, `/api/notices/${noticeRef}`)).data.body).toBe('최신 내용 확인 후 다시 작성한 공지');

  const number = await seed(page, `재인증 배정 확인 ${info.project.name}`);
  await apiLogin(page, 'bnoc');
  const requestBefore = (await apiRead(page, `/api/requests/${number}`)).data;
  await page.goto(`/requests/${number}`);
  await page.getByRole('combobox', { name: /^일반·긴급(?:\s|$)/ }).selectOption('urgent');
  await page.getByLabel(wire, { exact: true }).check();
  await command(other, 'assignTeams', { teamIds: [wire], priority: 'general' }, { requestNumber: number, expectedRevision: requestBefore.revision });
  const requestLatest = (await apiRead(other, `/api/requests/${number}`)).data;
  expect(requestLatest.workItems).toHaveLength(1); expect(requestLatest.priority).toBe('general');
  await expire();
  const expiredAssignment = responseFor('assignTeams', 401);
  await page.getByRole('button', { name: '선택 작업반 배정', exact: true }).click();
  expect((await expiredAssignment).request().postDataJSON().expectedRevision).toBe(requestBefore.revision);
  await expect(page.getByRole('dialog', { name: '로그인 만료', exact: true })).toBeVisible();
  const refreshedRequest = refreshFor(`/api/requests/${number}`);
  await loginWithPopup(page, 'bnoc');
  expect((await (await refreshedRequest).json()).data.revision).toBe(requestLatest.revision);
  await expect(page.getByRole('dialog', { name: '로그인 만료', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '선택 작업반 배정', exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: /^일반·긴급(?:\s|$)/ })).toHaveValue('urgent');
  const classificationConflict = responseFor('changePriority', 409);
  await page.getByRole('button', { name: '분류 저장', exact: true }).click();
  const conflictedClassification = await classificationConflict;
  expect((await conflictedClassification.json()).code).toBe('CONFLICT');
  expect(conflictedClassification.request().postDataJSON().expectedRevision).toBe(requestBefore.revision);
  await expect(page.getByRole('combobox', { name: /^일반·긴급(?:\s|$)/ })).toHaveValue('urgent');
  const untouched = (await apiRead(other, `/api/requests/${number}`)).data;
  expect(untouched.priority).toBe('general'); expect(untouched.workItems).toEqual(requestLatest.workItems); expect(untouched.revision).toBe(requestLatest.revision);
  await page.getByRole('button', { name: '최신 내용 다시 불러오기', exact: true }).click();
  await expect(page.getByRole('combobox', { name: /^일반·긴급(?:\s|$)/ })).toHaveValue('');
  await expect(page.getByRole('button', { name: '분류 저장', exact: true })).toBeEnabled();
  await page.getByRole('combobox', { name: /^일반·긴급(?:\s|$)/ }).selectOption('urgent');
  const classificationCommitted = responseFor('changePriority', 200);
  await page.getByRole('button', { name: '분류 저장', exact: true }).click();
  expect((await classificationCommitted).request().postDataJSON().expectedRevision).toBe(requestLatest.revision);
  await expect.poll(async () => (await apiRead(other, `/api/requests/${number}`)).data.priority).toBe('urgent');
  expect((await apiRead(other, `/api/requests/${number}`)).data.workItems).toEqual(requestLatest.workItems);
  const publicHistory = (await apiRead(other, `/api/requests/${number}/history`)).data.items;
  const priorityHistory = publicHistory.find((entry: { field: string }) => entry.field === '일반·긴급');
  expect(priorityHistory.field).toBe('일반·긴급');
  expect(priorityHistory.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
  expect(Number.isFinite(Date.parse(priorityHistory.at))).toBe(true);
  await humanHistory(page, '일반·긴급: 일반 → 긴급', requestLatest.assignedAt);
  await noOverflow(page);
});

test('SR-BE-026,032,033,035: situation provenance, query failure distinct from empty, keyboard and PC layout', async ({ page }, info) => {
  await apiLogin(page, 'requester');
  await page.goto('/situation');
  await expect(page.getByRole('heading', { name: /정보통신 상황|GPS.*CPCON/ })).toBeVisible();
  await expect(page.getByText('GPS 정보원', { exact: true })).toBeVisible();
  await expect(page.getByText('CPCON 정보원', { exact: true })).toBeVisible();
  await expect(page.getByText(/모의 인증|모의 정보|대회용/)).toHaveCount(0);
  await expect(page.getByText(/CPCON[ⅠⅡⅢⅣⅤ]급/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /단계.*변경|단계.*설정/ })).toHaveCount(0);
  await expect(page.getByText(/원본 기준시각|정보 기준시각/).first()).toBeVisible();
  await noOverflow(page);
  await screenshot(page, info, 'situation');
  await page.goto('/requests');
  await expect(page.getByRole('heading', { name: '신청 목록' })).toBeVisible();
  await page.route('**/api/requests?**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'SAVE_FAILED', message: '일시적으로 조회할 수 없습니다.' }) }));
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await expect(page.getByText(/조회.*실패|조회.*못|조회할 수 없습니다/).first()).toBeVisible();
  await expect(page.getByText(/조건에 맞는 신청이 없습니다|조회된 항목 없음/)).toHaveCount(0);
  await page.unroute('**/api/requests?**');
  const restoredRequests = page.waitForResponse(response => new URL(response.url()).pathname === '/api/requests' && response.request().method() === 'GET' && response.status() === 200);
  await page.reload();
  await restoredRequests;
  await expect(page.getByRole('heading', { name: '신청 목록', exact: true })).toBeVisible();
  await expect(page.getByText('불러오는 중…', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '검색', exact: true })).toBeEnabled();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '본문으로 건너뛰기', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
  await noOverflow(page);
  expect(await page.locator('body').innerText()).not.toMatch(/윤하린|배지안|ID-260901|시험 단계\s*[ABab]/);
});
