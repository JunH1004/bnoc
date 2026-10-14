import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';
import * as dateTime from './dateTime.mjs';
import * as formFeedback from './formFeedback.mjs';

// Execute actual TSX handlers; retained hook state models a same-user re-render.
function screen(file,name,resource,api={}) {
  const state=[],commands=[];let cursor=0;
  const react={ useState(initial) { const index=cursor++;if(!(index in state)) state[index]=typeof initial==='function' ? initial() : initial;return [state[index],value=>{ state[index]=typeof value==='function' ? value(state[index]) : value; }]; }, useRef(initial) { const index=cursor++;state[index] ??= { current:initial };return state[index]; }, useEffect() {} };
  const imports={ react,'react/jsx-runtime':jsxRuntime,'../app/useResource':{ useResource:()=>({ data:resource.current,loading:false,error:null,reload:()=>{} }),errorMessage:error=>error?.message ?? '' },'../app/useSubmission':{ useSubmission:()=>({ saving:false,submit:async(...args)=>{ commands.push(args);return { ok:false,errorCode:'CONFLICT',message:'다른 변경이 반영됐습니다.' }; } }) },'../app/useUnsavedChanges':{ useUnsavedChanges:()=>{} },'../app/dateTime.mjs':dateTime,'../app/formFeedback.mjs':formFeedback,'../types':{ priorityLabel:value=>value==='urgent' ? '긴급' : value==='general' ? '일반' : '미분류' } };
  const source=readFileSync(new URL('../screens/'+file,import.meta.url),'utf8');
  const output=ts.transpileModule(source,{ compilerOptions:{ module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX } }).outputText;
  const module={ exports:{} };
  new Function('require','exports','module',output)(path=>imports[path] ?? new Proxy({}, { get:(_,name)=>()=>null }),module.exports,module);
  return { commands,render(props) { cursor=0;return module.exports[name]({ api,...props }); } };
}
function nodes(node) { if(!node || typeof node!=='object') return [];return [node,...[node.props?.children].flat(Infinity).flatMap(nodes)]; }
function text(node) { if(typeof node==='string') return node;if(!node || typeof node!=='object') return '';return [node.props?.children].flat(Infinity).map(text).join(''); }
function find(node,predicate) { const found=nodes(node).find(predicate);assert.ok(found,'Expected rendered control');return found; }
function labelControl(node,label,type='input') { const wrapper=find(node,item=>item.type==='label' && text(item).includes(label));return find(wrapper,item=>item.type===type); }
const actor={ id:'service-bnoc',role:'bnoc',displayName:'BNOC',department:'BNOC' };
const detail=(revision,works=[])=>({ requestNumber:'101',requesterDisplayText:'요청 부서',category:'장비/체계',status:works.length ? '배정' : '대기',priority:works.length ? 'general' : null,detail:'요청 내용',location:'요청 위치',subcategories:{},registeredAt:'2026-10-13T00:00:00Z',revision,workItems:works,attachments:[] });

test('notice text draft keeps its edit revision through reauthentication refresh; explicit reload replaces both',async()=>{
  const original={ noticeRef:'notice-ref',title:'기존 제목',body:'기존 본문',attachments:[],revision:1 };
  const latest={ ...original,body:'다른 BNOC 저장',revision:2 };
  const ui=screen('NoticeViews.tsx','NoticeEditor',{ current:null },{ getNotice:async()=>latest });
  let tree=ui.render({ notice:original,run:()=>{},onSaved:()=>{},onBack:()=>{} });
  labelControl(tree,'내용','textarea').props.onChange({ target:{ value:'편집 중 본문' } });
  tree=ui.render({ notice:latest,run:()=>{},onSaved:()=>{},onBack:()=>{} });
  await find(tree,item=>item.type==='form').props.onSubmit({ preventDefault(){} });
  assert.equal(ui.commands[0][3],1,'NOTICE_DRAFT_REVISION_MUST_NOT_ADVANCE_ON_REFRESH');
  assert.equal(ui.commands[0][1].body,'편집 중 본문');
  tree=ui.render({ notice:latest,run:()=>{},onSaved:()=>{},onBack:()=>{} });
  assert.equal(labelControl(tree,'내용','textarea').props.value,'편집 중 본문','NOTICE_CONFLICT_MUST_KEEP_DRAFT');
  await find(tree,item=>item.type==='button' && text(item)==='최신 내용 다시 불러오기').props.onClick();
  tree=ui.render({ notice:latest,run:()=>{},onSaved:()=>{},onBack:()=>{} });
  assert.equal(labelControl(tree,'내용','textarea').props.value,'다른 BNOC 저장');
  await find(tree,item=>item.type==='form').props.onSubmit({ preventDefault(){} });
  assert.equal(ui.commands[1][3],2,'NOTICE_EXPLICIT_RELOAD_MUST_USE_NEW_REVISION');
});

test('BNOC assignment selection keeps the original request revision across automatic refresh',async()=>{
  const resource={ current:detail(1) },ui=screen('RequestDetailWorkspace.tsx','RequestDetailWorkspace',resource);
  const props={ actor,requestNumber:'101',teams:['무선반','유선반'],run:()=>{},upload:()=>{},onBack:()=>{} };
  let tree=ui.render(props);labelControl(tree,'무선반').props.onChange();
  tree=ui.render(props);labelControl(tree,'일반·긴급','select').props.onChange({ target:{ value:'urgent' } });
  resource.current=detail(2);tree=ui.render(props);
  await find(tree,item=>item.type==='form' && text(item).includes('작업반 배정')).props.onSubmit({ preventDefault(){} });
  assert.equal(ui.commands[0][3],1,'BNOC_ASSIGNMENT_SELECTION_REVISION_MUST_STAY_FIXED');
  resource.current=detail(3,[{ workNumber:'101-1',teamId:'무선반',status:'배정',revision:1,resolved:false,editable:false }]);tree=ui.render(props);
  await find(tree,item=>item.type==='form' && text(item).includes('일반·긴급 정정')).props.onSubmit({ preventDefault(){} });
  assert.equal(ui.commands[1][3],1,'BNOC_PRIORITY_DRAFT_MUST_KEEP_REVISION_WHEN_ASSIGNMENT_VIEW_CHANGES');
});

test('BNOC classification and returned-work selection keep their own original target revisions',async()=>{
  const work={ workNumber:'101-1',teamId:'무선반',status:'반환',revision:7,resolved:false,editable:false,returnReason:'담당 부서 변경' };
  const resource={ current:detail(1,[work]) },ui=screen('RequestDetailWorkspace.tsx','RequestDetailWorkspace',resource);
  const props={ actor,requestNumber:'101',teams:['무선반','유선반'],run:()=>{},upload:()=>{},onBack:()=>{} };
  let tree=ui.render(props);labelControl(tree,'일반·긴급','select').props.onChange({ target:{ value:'urgent' } });
  tree=ui.render(props);labelControl(tree,'유선반').props.onChange();
  resource.current=detail(2,[{ ...work,revision:8 }]);tree=ui.render(props);
  await find(tree,item=>item.type==='form' && text(item).includes('일반·긴급 정정')).props.onSubmit({ preventDefault(){} });
  await find(tree,item=>item.type==='form' && text(item).includes('반환 재배정')).props.onSubmit({ preventDefault(){} });
  assert.equal(ui.commands[0][3],1,'BNOC_PRIORITY_SELECTION_REVISION_MUST_STAY_FIXED');
  assert.equal(ui.commands[1][3],7,'BNOC_REASSIGNMENT_SELECTION_REVISION_MUST_STAY_FIXED');
});
