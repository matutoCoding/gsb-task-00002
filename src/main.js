import { StudioStore } from './core/store.js';
import { validate } from './core/validation.js';
import { coordinationSuggestions, suggestionState, keyBaseline } from './core/coordination.js';
import { keyLight as keyLightOf } from './core/validation.js';
import { StudioCanvas } from './ui/canvas.js';
import { renderPlanTabs, renderSummary, renderInspector, renderIssueList } from './ui/panels.js';
import {
  makeLight, makeStand, makeBackground, makeOutlet, mutate, removeEntity, addEntity, LIGHT_TYPES,
} from './core/model.js';

const $ = (s) => document.querySelector(s);
const store = new StudioStore();

let lastResult = null;     // validate() 结果
let catalog = [];         // 合并了用户状态的问题台账
let suggestions = [];
let entityStatus = {};
let validateTimer = 0;
let selectedId = null;

const checkingEl = $('#checking');
const toastEl = $('#toast');
function toast(msg, ms = 2200) {
  toastEl.textContent = msg; toastEl.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => toastEl.classList.add('hidden'), ms);
}

// ---------- 校验调度 ----------
function scheduleValidation(immediate = false) {
  checkingEl.classList.remove('hidden');
  clearTimeout(validateTimer);
  validateTimer = setTimeout(runValidation, immediate ? 30 : 180);
}

function runValidation() {
  const plan = store.currentPlan();
  lastResult = validate(plan);
  reconcileCatalog(plan.id, lastResult.issues);
  const overrides = store.overridesFor();
  const currentKeys = new Set(lastResult.issues.map((i) => i.key));

  catalog = [];
  entityStatus = {};
  const mark = (id, sev, status) => {
    if (!id) return;
    const prev = entityStatus[id];
    // error 优先于 warning；resolved/waived 保留
    if (!prev || (status === undefined && (prev.status === undefined || sevRank(sev) > sevRank(prev.sev)))) {
      entityStatus[id] = { sev, status };
    }
  };
  function sevRank(s) { return s === 'error' ? 2 : s === 'warning' ? 1 : 0; }

  for (const issue of lastResult.issues) {
    const ov = overrides[issue.key];
    let status = null;
    if (ov === 'resolved') status = 'reopened'; // 标记过已处理但问题仍在：明确提示“又出现了”
    else if (ov === 'waived') status = 'waived';
    catalog.push({ ...issue, status });
    mark(issue.entityId, issue.sev, status);
    const es = entityStatus[issue.entityId];
    if (es) {
      es.cableShort = es.cableShort || issue.type === 'cable-short';
      es.cableCross = es.cableCross || issue.type === 'cable-cross';
    }
  }
  // 已处理但问题已消失的，归入已处理统计
  for (const [key, rec] of Object.entries(overrides.__recs || {})) {
    if (!currentKeys.has(key) && rec.status === 'resolved') {
      catalog.push({ key, sev: rec.sev || 'warning', title: rec.title || key, detail: '问题已不再出现。',
        entityId: rec.entityId, status: 'resolved' });
    }
  }

  // 联动建议
  const baseline = store.baseline(plan.id);
  const rawSug = coordinationSuggestions(plan, baseline);
  const sugOverride = overrides.__sugs || {};
  suggestions = rawSug.map((s) => ({ ...s, state: sugOverride[s.key] || suggestionState(s, plan) }));

  renderAll();
  checkingEl.classList.add('hidden');
}

// 把每次校验出的问题存进 override 记录（保留标题/sev，便于问题消失后仍可展示“已处理”）
function reconcileCatalog(planId, issues) {
  const ov = store.overridesFor(planId);
  let dirty = false;
  if (!ov.__recs) { ov.__recs = {}; dirty = true; }
  for (const i of issues) {
    if (!ov.__recs[i.key]) { ov.__recs[i.key] = { sev: i.sev, title: i.title, entityId: i.entityId }; dirty = true; }
  }
  if (dirty) localStorage.setItem('gsb.studio.overrides.v1', JSON.stringify(store.issueOverrides));
}

// ---------- 视图模型 ----------
function viewModel() {
  const plan = store.currentPlan();
  const counts = { open: 0, waived: 0, resolved: 0 };
  for (const c of catalog) {
    if (c.status === 'waived') counts.waived++;
    else if (c.status === 'resolved') counts.resolved++;
    else if (c.status === 'reopened') counts.open++;
    else counts.open++;
  }
  return {
    plan, catalog, suggestions, entityStatus,
    route: lastResult?.route || null,
    keyLight: lastResult?.keyLight || null,
    counts,
  };
}

// ---------- 渲染 ----------
let canvas;
function renderAll() {
  renderPlanTabs($('#plan-tabs'), store, {
    switch: (id) => store.switchPlan(id),
    rename: (id, name) => store.renamePlan(id, name),
    del: (id) => store.deletePlan(id),
  });
  const vm = viewModel();
  renderSummary($('#summary'), vm.counts);
  canvas?.render(vm);
  renderInspector($('#inspector'), vm.plan, selectedId, inspectorActions);
  renderIssueList($('#issue-list'), vm, store.ui.issueTab, issueActions);
  const peers = store.peerCount();
  $('#presence').textContent = peers > 0 ? `🖧 ${peers} 个标签页正在同步` : '';
}

// ---------- 操作 ----------
const inspectorActions = {
  patch: (id, patch) => {
    const plan = store.currentPlan();
    if (id !== 'area' && id !== 'subject' && plan.confirmed[id]) { toast('该对象已确认，请先取消确认'); return; }
    store.commit((p) => mutate(p, id, patch), { reason: 'patch' });
    scheduleValidation();
  },
  toggleLock: (id) => {
    store.commit((p) => {
      if (p.confirmed[id]) delete p.confirmed[id];
      else {
        p.confirmed[id] = true;
        const k = keyLightOf(p);
        if (k) store.doc.baselines[p.id] = { key: { x: k.x, y: k.y, angle: k.angle }, at: Date.now() };
      }
    }, { reason: 'lock' });
    scheduleValidation();
  },
  remove: (id) => {
    store.commit((p) => removeEntity(p, id), { reason: 'remove' });
    if (selectedId === id) selectedId = null;
    scheduleValidation();
  },
};

function captureKeyBaseline(p) {
  const b = keyBaseline(p);
  store.doc.baselines[p.id] = { key: b, at: Date.now() };
}

const issueActions = {
  setStatus: (key, status) => { store.setIssueStatus(store.ui.currentPlanId, key, status); scheduleValidation(true); },
  focusEntity: (id) => {
    if (!id) return;
    selectedId = id; canvas.setSelected(id); canvas.flash(id);
    renderInspector($('#inspector'), store.currentPlan(), id, inspectorActions);
  },
  applySuggestion: (sug) => {
    const plan = store.currentPlan();
    if (sug.kind === 'cable') { toast('请在属性面板里改插座或线长（不会替你自动改）'); return; }
    if (sug.kind === 'subject') {
      if (plan.confirmed['subject']) { toast('人物站位已确认'); return; }
      store.commit((p) => mutate(p, 'subject', { angle: Math.round(sug.angle) }), { reason: 'suggest' });
    } else {
      if (plan.confirmed[sug.entityId]) { toast('该灯已确认，请先取消确认'); return; }
      store.commit((p) => mutate(p, sug.entityId, { x: sug.x, y: sug.y, angle: Math.round(sug.angle) }), { reason: 'suggest' });
    }
    rememberSuggestion(sug.key, 'applied');
    toast('已按建议摆放，请确认走线和其他冲突');
    scheduleValidation(true);
  },
  dismissSuggestion: (sug, state = 'dismissed') => {
    rememberSuggestion(sug.key, state);
    scheduleValidation(true);
  },
};

function rememberSuggestion(key, state) {
  const planId = store.ui.currentPlanId;
  const ov = store.overridesFor(planId);
  if (!ov.__sugs) ov.__sugs = {};
  if (state === null) delete ov.__sugs[key]; else ov.__sugs[key] = state;
  localStorage.setItem('gsb.studio.overrides.v1', JSON.stringify(store.issueOverrides));
}

// ---------- 画布回调 ----------
function canvasCallbacks() {
  return {
    getViewModel: viewModel,
    onSelect: (id) => { selectedId = id; canvas.setSelected(id); renderInspector($('#inspector'), store.currentPlan(), id, inspectorActions); },
    allowLocked: () => false,
    onLocked: () => toast('该对象已确认锁定，请在右侧取消确认后再拖动'),
    onTransient: () => { checkingEl.classList.remove('hidden'); },
    onCommit: ({ id, type, rev0 }) => {
      // 拖动已直接改了 plan 对象；这里补 rev 递增（冲突检测依赖），再持久化与广播
      store.commit((p) => {
        if (id === 'area' || id === 'subject') {
          if ((p[id].rev || 1) === (rev0 || 1)) p[id].rev = (p[id].rev || 1) + 1;
        } else {
          const ent = p.objects.find((o) => o.id === id);
          if (ent && (ent.rev || 1) === (rev0 || 1)) ent.rev = (ent.rev || 1) + 1;
        }
      }, { reason: type === 'rotate' ? 'rotate' : 'drag' });
      scheduleValidation(true);
    },
  };
}

// ---------- 设备新增 ----------
$('#palette').addEventListener('click', (e) => {
  const kind = e.target.dataset?.add;
  if (!kind) return;
  const plan = store.currentPlan();
  let ent;
  if (kind === 'light') ent = makeLight({ x: 1.5, y: 1.5, type: 'other' });
  if (kind === 'stand') ent = makeStand({ x: 1.5, y: 1.5 });
  if (kind === 'background') ent = makeBackground({ x: plan.room.w / 2, y: plan.room.h - 0.2 });
  if (kind === 'outlet') ent = makeOutlet({ x: plan.room.w - 0.2, y: plan.room.h / 2 });
  store.commit((p) => addEntity(p, ent), { reason: 'add' });
  selectedId = ent.id;
  scheduleValidation(true);
  toast(`已添加${ent.name}，可直接拖动`);
});

$('#btn-add-plan').addEventListener('click', () => { store.addPlan(); scheduleValidation(true); });
$('#snap-toggle').addEventListener('change', (e) => store.setSnap(e.target.checked));
$('.issue-tabs').addEventListener('click', (e) => {
  if (!e.target.dataset.itab) return;
  document.querySelectorAll('.itab').forEach((b) => b.classList.toggle('active', b === e.target));
  store.setIssueTab(e.target.dataset.itab);
});
$('#btn-export').addEventListener('click', () => {
  const blob = new Blob([store.exportJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'studio-plans.json';
  a.click();
});

// ---------- store 事件 ----------
store.addEventListener('change', (ev) => {
  if (ev.detail?.reason === 'remote' || ev.detail?.reason === 'conflict' || ev.detail?.reason === 'override' || ev.detail?.reason === 'switch') {
    scheduleValidation(ev.detail?.reason === 'switch');
  } else {
    renderAll();
  }
});
store.addEventListener('ui', renderAll);
store.addEventListener('presence', renderAll);
store.addEventListener('conflict', () => {
  const c = store.nextConflict();
  if (!c) return;
  const modal = $('#conflict-modal');
  modal.classList.remove('hidden');
  const localName = c.entityId === 'area' ? '拍摄区域' : c.entityId === 'subject' ? '人物站位'
    : (c.local?.name || c.entityId);
  $('#conflict-detail').textContent =
    `「${localName}」在另一个标签页也被改动。本标签页版本 rev.${c.local?.rev ?? 1}，对方版本 rev.${c.remote?.rev ?? 1}。` +
    `请选择保留哪一个，另一边不会被悄悄覆盖。`;
  $('#conflict-keep-mine').onclick = () => { modal.classList.add('hidden'); store.resolveConflict('mine'); };
  $('#conflict-use-theirs').onclick = () => { modal.classList.add('hidden'); store.resolveConflict('theirs'); };
});

// ---------- 启动 ----------
canvas = new StudioCanvas($('#stage'), store, canvasCallbacks());
// 调试/自动化钩子
window.__studio = { store, runValidation, get canvas() { return canvas; } };
$('#snap-toggle').checked = store.ui.snap;
document.querySelectorAll('.itab').forEach((b) => b.classList.toggle('active', b.dataset.itab === store.ui.issueTab));
// 主灯基线：以初始主灯位置为基准；确认主灯会把基准推进到当前位置
{
  const p0 = store.currentPlan();
  const k0 = keyLightOf(p0);
  if (k0 && !store.baseline(p0.id)) store.setBaseline(p0.id, { x: k0.x, y: k0.y, angle: k0.angle });
}
runValidation();
window.addEventListener('resize', () => canvas.render());
console.log('studio ready', store.doc.plans.length, 'plans');
