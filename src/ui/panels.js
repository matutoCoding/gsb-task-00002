// DOM 面板：方案页签、属性检查器、问题清单。纯渲染 + 事件回调。
import { LIGHT_TYPES } from '../core/model.js';

function esc(v) { return String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

export function renderPlanTabs(container, store, on) {
  container.innerHTML = '';
  for (const p of store.doc.plans) {
    const active = p.id === store.ui.currentPlanId;
    const tab = document.createElement('div');
    tab.className = 'plan-tab' + (active ? ' active' : '');
    const input = document.createElement('input');
    input.className = 'rename'; input.value = p.name;
    input.addEventListener('change', () => on.rename(p.id, input.value));
    const pinCount = Object.keys(p.confirmed).length;
    const pin = document.createElement('span');
    pin.className = 'pin'; pin.textContent = pinCount ? `✓${pinCount}` : '';
    pin.title = `${pinCount} 个对象已确认`;
    tab.append(input, pin);
    tab.addEventListener('click', (e) => { if (e.target === tab || e.target === pin) on.switch(p.id); });
    if (store.doc.plans.length > 1) {
      const del = document.createElement('button');
      del.className = 'del'; del.textContent = '×'; del.title = '删除方案';
      del.addEventListener('click', (e) => { e.stopPropagation(); if (confirm(`删除方案「${p.name}」？已确认内容只在本方案内。`)) on.del(p.id); });
      tab.appendChild(del);
    }
    container.appendChild(tab);
  }
}

export function renderSummary(el, counts) {
  el.innerHTML = `
    <div class="cell"><div class="num n-err">${counts.open}</div><div class="lbl">未处理</div></div>
    <div class="cell"><div class="num n-waive">${counts.waived}</div><div class="lbl">暂时绕开</div></div>
    <div class="cell"><div class="num n-ok">${counts.resolved}</div><div class="lbl">已处理</div></div>`;
}

export function renderInspector(el, plan, selectedId, on) {
  if (!selectedId) { el.innerHTML = '<p class="muted">未选中</p>'; return; }
  const ent = selectedId === 'area' ? { ...plan.area, kind: 'area' }
    : selectedId === 'subject' ? { ...plan.subject, kind: 'subject' }
    : plan.objects.find((o) => o.id === selectedId);
  if (!ent) { el.innerHTML = '<p class="muted">未选中</p>'; return; }
  const locked = !!plan.confirmed[selectedId];
  const outlets = plan.objects.filter((o) => o.kind === 'outlet');
  let html = '';

  if (ent.kind === 'light') {
    html += field('名称', `<input data-k="name" value="${esc(ent.name)}">`);
    html += field('类型', select('type', Object.entries(LIGHT_TYPES).map(([k, v]) => [k, v.label]), ent.type, locked));
    html += field('方向（度）', `<input type="number" data-k="angle" value="${ent.angle}" ${locked ? 'disabled' : ''}>`);
    html += field('线长（米）', `<input type="number" step="0.5" min="0.5" data-k="cableLength" value="${ent.cableLength}" ${locked ? 'disabled' : ''}>`);
    html += field('插座', select('outletId', [['', '— 未接 —'], ...outlets.map((o) => [o.id, o.name])], ent.outletId || '', locked));
    const spec = LIGHT_TYPES[ent.type] || LIGHT_TYPES.other;
    html += `<p class="muted">灯锥 ${spec.cone}°，有效距离 ${spec.reach} m，功率 ${spec.power} W</p>`;
  } else if (ent.kind === 'outlet') {
    html += field('名称', `<input data-k="name" value="${esc(ent.name)}" ${locked ? 'disabled' : ''}>`);
    html += field('容量（W）', `<input type="number" step="50" data-k="capacity" value="${ent.capacity}" ${locked ? 'disabled' : ''}>`);
  } else if (ent.kind === 'stand' || ent.kind === 'background') {
    html += field('名称', `<input data-k="name" value="${esc(ent.name)}" ${locked ? 'disabled' : ''}>`);
  } else if (ent.kind === 'subject') {
    html += field('朝向（度）', `<input type="number" data-k="angle" value="${Math.round(ent.angle)}">`);
    html += '<p class="muted">也可以直接在画布上拖动人物；朝向短线表示人物面向。</p>';
  } else if (ent.kind === 'area') {
    html += field('宽度（米）', `<input type="number" step="0.1" min="1" data-k="w" value="${ent.w}">`);
    html += field('深度（米）', `<input type="number" step="0.1" min="1" data-k="h" value="${ent.h}">`);
  }

  html += `<div class="row"><label style="flex:1"><input type="checkbox" id="lock-chk" ${locked ? 'checked' : ''}> 已确认（锁定）</label></div>`;
  html += `<button class="confirm-btn" id="lock-btn">${locked ? '取消确认，允许再改' : '确认此对象不再改动'}</button>`;
  if (!['area', 'subject'].includes(ent.kind)) {
    html += '<button class="danger" id="del-btn">删除此对象</button>';
  }
  el.innerHTML = html;

  el.querySelectorAll('[data-k]').forEach((input) => {
    input.addEventListener('change', () => {
      let v = input.value;
      if (input.type === 'number') v = parseFloat(v);
      on.patch(ent.id, { [input.dataset.k]: v });
    });
  });
  el.querySelector('#lock-btn').addEventListener('click', () => on.toggleLock(ent.id));
  el.querySelector('#del-btn')?.addEventListener('click', () => {
    if (confirm(`删除「${ent.name}」？`)) on.remove(ent.id);
  });
}

function field(label, inner) { return `<label>${label}</label>${inner}`; }
function select(key, opts, val, locked) {
  return `<select data-k="${key}" ${locked ? 'disabled' : ''}>` +
    opts.map(([v, t]) => `<option value="${esc(v)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('') + '</select>';
}

export function renderIssueList(el, vm, tab, on) {
  const items = tab === 'suggest'
    ? vm.suggestions.filter((x) => x.state !== 'dismissed')
    : tab === 'resolved'
      ? vm.catalog.filter((c) => c.status === 'resolved' || c.status === 'reopened')
      : tab === 'waived'
        ? vm.catalog.filter((c) => c.status === 'waived')
        : vm.catalog.filter((c) => !c.status);
  el.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = tab === 'suggest' ? '主灯没有新的变动，暂无联动建议。'
      : tab === 'resolved' ? '还没有标记为“已处理”的问题。'
      : tab === 'waived' ? '没有暂时绕开的问题。'
      : '当前没有未处理的问题。';
    el.appendChild(empty);
    return;
  }
  for (const item of items) items.length && el.appendChild(issueRow(item, tab, on));
}

function issueRow(item, tab, on) {
  const li = document.createElement('li');
  const isSug = tab === 'suggest';
  li.className = 'issue ' + (isSug ? 'sev-info' : `sev-${item.sev}`) +
    (tab === 'waived' || item.status === 'waived' ? ' waived' : '') +
    (tab === 'resolved' || item.status === 'resolved' ? ' resolved' : '');
  const msg = document.createElement('div'); msg.className = 'msg';
  msg.textContent = (isSug ? item.msg : item.title) + (!isSug && item.status === 'reopened' ? '（又出现了）' : '');
  const meta = document.createElement('div'); meta.className = 'meta';
  meta.textContent = isSug ? (item.state === 'applied' ? '检测到已按建议调整 ✓' : '等待调整')
    : item.status === 'resolved' ? '已处理，当前检查未再发现该问题。' : item.detail;
  li.append(msg, meta);

  const actions = document.createElement('div'); actions.className = 'row-actions';
  if (isSug) {
    if (item.state !== 'applied') {
      const apply = document.createElement('button'); apply.textContent = '按建议摆放';
      apply.addEventListener('click', () => on.applySuggestion(item));
      const dismiss = document.createElement('button'); dismiss.textContent = '暂时绕开';
      dismiss.addEventListener('click', () => on.dismissSuggestion(item));
      actions.append(apply, dismiss);
    } else {
      const undismiss = document.createElement('button'); undismiss.textContent = '撤销处理';
      undismiss.addEventListener('click', () => on.dismissSuggestion(item, null));
      actions.append(undismiss);
    }
  } else if (item.status === 'resolved' || item.status === 'reopened') {
    const reopen = document.createElement('button'); reopen.textContent = '重新标记为未处理';
    reopen.addEventListener('click', () => on.setStatus(item.key, null));
    actions.appendChild(reopen);
    if (item.status === 'reopened') {
      const fix = document.createElement('button'); fix.textContent = '确认已修好';
      fix.addEventListener('click', () => on.setStatus(item.key, 'resolved'));
      actions.appendChild(fix);
    }
  } else if (item.status === 'waived') {
    const back = document.createElement('button'); back.textContent = '恢复为未处理';
    back.addEventListener('click', () => on.setStatus(item.key, null));
    const done = document.createElement('button'); done.textContent = '标记已处理';
    done.addEventListener('click', () => on.setStatus(item.key, 'resolved'));
    actions.append(back, done);
  } else {
    const done = document.createElement('button'); done.textContent = '已处理';
    done.addEventListener('click', () => on.setStatus(item.key, 'resolved'));
    const waive = document.createElement('button'); waive.textContent = '暂时绕开';
    waive.addEventListener('click', () => on.setStatus(item.key, 'waived'));
    actions.append(done, waive);
  }
  li.appendChild(actions);
  li.addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON') on.focusEntity(item.entityId); });
  return li;
}
