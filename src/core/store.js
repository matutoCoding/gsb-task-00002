// 存储层：localStorage 持久化 + BroadcastChannel 实时同步 + 实体级乐观锁冲突。
import { makePlan, clone, uid } from './model.js';

const KEY_DOC = 'gsb.studio.doc.v1';
const KEY_UI = 'gsb.studio.ui.v1';
const KEY_ISSUE_OVERRIDES = 'gsb.studio.overrides.v1';
const CHANNEL = 'gsb-studio-sync';
const TAB_ID = uid('tab');

function loadJSON(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch { return fallback; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { console.warn('保存失败', e); }
}

export class StudioStore extends EventTarget {
  constructor() {
    super();
    this.tabId = TAB_ID;
    const doc = loadJSON(KEY_DOC, null);
    if (doc && doc.plans && doc.plans.length) {
      this.doc = doc;
    } else {
      const first = makePlan('方案 A');
      this.doc = {
        version: 1,
        plans: [first],
        currentPlanId: first.id,
        baselines: { [first.id]: { key: null, at: Date.now() } },
      };
      this._persist(true);
    }
    this.ui = loadJSON(KEY_UI, { currentPlanId: this.doc.currentPlanId, snap: true, issueTab: 'open' });
    if (!this.doc.baselines) this.doc.baselines = {};
    if (!this.doc.plans.find((p) => p.id === this.ui.currentPlanId)) {
      this.ui.currentPlanId = this.doc.plans[0].id;
    }
    this.issueOverrides = loadJSON(KEY_ISSUE_OVERRIDES, {}); // { [planId]: { [issueKey]: 'resolved'|'waived' } }
    this.conflictQueue = [];
    this.syncRevs = {};   // { planId: { entityId: 上次从对端同步/对端所见的 rev } }
    this.presencePeers = {}; // tabId -> ts
    this._saveTimer = 0;

    this.channel = null;
    try { this.channel = new BroadcastChannel(CHANNEL); } catch { /* old browsers */ }
    this.channel?.addEventListener('message', (e) => this._onRemote(e.data));
    window.addEventListener('storage', (e) => {
      if (e.key === KEY_DOC) this._onRemoteDoc(loadJSON(KEY_DOC, null));
    });
    window.addEventListener('beforeunload', () => {
      this._persist(true);
      this._post({ type: 'leave', tab: TAB_ID });
    });
    this._presenceTimer = setInterval(() => this._heartbeat(), 4000);
    setTimeout(() => this._heartbeat(), 300);
  }

  // EventTarget(Node 风格别名)：this.emit('change', detail)
  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  currentPlan() {
    return this.doc.plans.find((p) => p.id === this.ui.currentPlanId) || this.doc.plans[0];
  }

  switchPlan(id) {
    if (!this.doc.plans.find((p) => p.id === id)) return;
    this.ui.currentPlanId = id;
    this.doc.currentPlanId = id;
    saveJSON(KEY_UI, this.ui);
    this._persist(true);
    this.emit('change', { reason: 'switch' });
  }

  addPlan(name) {
    const p = makePlan(name || `方案 ${String.fromCharCode(65 + this.doc.plans.length)}`);
    this.doc.plans.push(p);
    this.doc.baselines[p.id] = { key: null, at: Date.now() };
    this.switchPlan(p.id);
    return p;
  }

  duplicatePlan(id) {
    const src = this.doc.plans.find((p) => p.id === id) || this.currentPlan();
    const copy = clone(src);
    copy.id = uid('plan');
    copy.name = src.name + ' 副本';
    copy.createdAt = Date.now();
    this.doc.plans.push(copy);
    this.doc.baselines[copy.id] = clone(this.doc.baselines[src.id] || { key: null, at: Date.now() });
    this.switchPlan(copy.id);
  }

  renamePlan(id, name) {
    const p = this.doc.plans.find((x) => x.id === id);
    if (p && name.trim()) { p.name = name.trim(); this._persist(); this.emit('change'); }
  }

  deletePlan(id) {
    if (this.doc.plans.length <= 1) return;
    this.doc.plans = this.doc.plans.filter((p) => p.id !== id);
    delete this.issueOverrides[id];
    if (this.ui.currentPlanId === id) this.switchPlan(this.doc.plans[0].id);
    else { this._persist(); this.emit('change'); }
  }

  // 本地修改：以 updater(plan) 形式提交；同时附带 baseRevs（修改前读到的实体版本）用于冲突检测
  commit(mutator, meta = {}) {
    const plan = this.currentPlan();
    // baseRevs = 本标签页上次与其他标签页同步时各实体的 rev（三方合并的“共同祖先”）
    const before = {};
    const synced = this.syncRevs[plan.id] || {};
    // 从未收到过对端消息时：基线给当前 rev-1（对端首次收到后内容相同即不报冲突）
    for (const k of ['area', 'subject']) before[k] = Object.prototype.hasOwnProperty.call(synced, k) ? synced[k] : (plan[k].rev || 1) - 1;
    for (const o of plan.objects) before[o.id] = Object.prototype.hasOwnProperty.call(synced, o.id) ? synced[o.id] : (o.rev || 1) - 1;
    mutator(plan);
    this._persist();
    this._post({ type: 'edit', tab: TAB_ID, planId: plan.id, plan: clone(plan),
      baseRevs: before, meta });
    this.emit('change', { reason: meta.reason || 'edit' });
  }

  setSnap(on) { this.ui.snap = on; saveJSON(KEY_UI, this.ui); this.emit('ui'); }
  setIssueTab(t) { this.ui.issueTab = t; saveJSON(KEY_UI, this.ui); this.emit('ui'); }

  // ---- 问题状态 ----
  overridesFor(planId = this.ui.currentPlanId) { return this.issueOverrides[planId] || {}; }
  setIssueStatus(planId, key, status) {
    if (!this.issueOverrides[planId]) this.issueOverrides[planId] = {};
    if (status === null) delete this.issueOverrides[planId][key];
    else this.issueOverrides[planId][key] = status;
    saveJSON(KEY_ISSUE_OVERRIDES, this.issueOverrides);
    this._post({ type: 'overrides', tab: TAB_ID, planId, map: this.issueOverrides[planId] });
    this.emit('change', { reason: 'override' });
  }

  // ---- 主灯基线（记住“上一版”主灯位置，用于联动建议）----
  baseline(planId) { return this.doc.baselines[planId]?.key || null; }
  setBaseline(planId, key) {
    this.doc.baselines[planId] = { key, at: Date.now() };
    this._persist();
  }

  // ---- 导出 ----
  exportJSON() {
    return JSON.stringify({ doc: this.doc, overrides: this.issueOverrides }, null, 2);
  }

  // ============ 内部 ============
  _snapshotRevs(plan) {
    const revs = { area: plan.area.rev || 1, subject: plan.subject.rev || 1 };
    for (const o of plan.objects) revs[o.id] = o.rev || 1;
    return revs;
  }

  _persist(immediate = false) {
    saveJSON(KEY_UI, this.ui);
    clearTimeout(this._saveTimer);
    if (immediate) { saveJSON(KEY_DOC, this.doc); return; }
    this._saveTimer = setTimeout(() => saveJSON(KEY_DOC, this.doc), 250);
  }

  _post(msg) {
    try { this.channel?.postMessage(msg); } catch {}
  }

  _heartbeat() {
    this._prunePeers();
    this._post({ type: 'ping', tab: TAB_ID });
  }
  _prunePeers() {
    const now = Date.now();
    let changed = false;
    for (const [id, ts] of Object.entries(this.presencePeers)) {
      if (id === TAB_ID) continue;
      if (now - ts > 9000) { delete this.presencePeers[id]; changed = true; }
    }
    if (changed) this.emit('presence');
  }

  _onRemote(msg) {
    if (!msg || msg.tab === TAB_ID) return;
    this.presencePeers[msg.tab] = Date.now();
    if (msg.type === 'leave') { delete this.presencePeers[msg.tab]; this.emit('presence'); return; }
    if (msg.type === 'ping') { this.emit('presence'); return; }
    if (msg.type === 'overrides') {
      this.issueOverrides[msg.planId] = msg.map;
      saveJSON(KEY_ISSUE_OVERRIDES, this.issueOverrides);
      if (msg.planId === this.ui.currentPlanId) this.emit('change', { reason: 'override' });
      return;
    }
    if (msg.type === 'edit') this._mergeRemotePlan(msg.planId, msg.plan, msg.baseRevs || {}, msg.tab);
  }

  // storage 事件兜底（无 BroadcastChannel 的跨页情况）：整文档合并，仅在当前方案不同时触发
  _onRemoteDoc(remoteDoc) {
    if (!remoteDoc || remoteDoc.version !== this.doc.version) return;
    // 以整文档为准同步新增/删除方案与改名；当前方案的实体冲突仍由队列逻辑处理
    const localMap = new Map(this.doc.plans.map((p) => [p.id, p]));
    let touched = false;
    for (const rp of remoteDoc.plans) {
      if (!localMap.has(rp.id)) { this.doc.plans.push(rp); touched = true; }
    }
    this.doc.plans = this.doc.plans.filter((p) => remoteDoc.plans.some((r) => r.id === p.id));
    if (touched || this.doc.plans.length !== remoteDoc.plans.length) this.emit('change');
  }

  // 内容指纹：去掉 rev，避免同内容重复报冲突
  _fingerprint(ent) {
    if (!ent) return null;
    const { rev, ...rest } = ent;
    try { return JSON.stringify(rest); } catch { return String(Math.random()); }
  }

  // 三方合并：
  //  - 远端相对共同祖先(remoteBaseRevs)有改动，且本地相对同一祖先也有改动、且两边结果不同 → 冲突
  //  - 只有一边改动 → 直接采纳
  //  - 共同祖先未知（首条消息）→ 以高 rev 为准并记录基线，不报冲突
  _mergeRemotePlan(planId, remotePlan, remoteBaseRevs, fromTab) {
    const local = this.doc.plans.find((p) => p.id === planId);
    if (!local) { this.doc.plans.push(remotePlan); this._rememberRemote(planId, remotePlan); this.emit('change'); return; }
    if (remotePlan.name !== local.name) local.name = remotePlan.name;
    if (!this.syncRevs[planId]) this.syncRevs[planId] = {};
    const synced = this.syncRevs[planId];
    const firstSeen = Object.keys(synced).length === 0;

    const remoteById = new Map(remotePlan.objects.map((o) => [o.id, o]));
    const known = (id) => Object.prototype.hasOwnProperty.call(synced, id);

    for (const ro of remotePlan.objects) {
      const lo = local.objects.find((x) => x.id === ro.id);
      if (!lo) { local.objects.push(clone(ro)); synced[ro.id] = ro.rev || 1; continue; }
      const baseRev = remoteBaseRevs[ro.id];
      if (!known(ro.id)) {
        // 第一次收到该实体：只记录共同基线。内容相同则静默；内容不同说明双方都在“有通信前”改了它
        if (this._fingerprint(lo) !== this._fingerprint(ro)) {
          this._enqueueConflict({ planId, entityId: ro.id, local: clone(lo), remote: clone(ro), fromTab });
        }
        synced[ro.id] = Math.min(lo.rev || 1, ro.rev || 1) - 1 < 0 ? 0 : Math.min(lo.rev || 1, ro.rev || 1) - 1;
        // 用远端 rev 作为“对方当前值”，基线设为 min-1；再正常走一次变更判定
      }
      const remoteChanged = (ro.rev || 1) > (baseRev ?? synced[ro.id] ?? 0);
      const localChanged = (lo.rev || 1) > (baseRev ?? synced[ro.id] ?? 0);
      if (!remoteChanged) { synced[ro.id] = Math.max(synced[ro.id] ?? 0, ro.rev || 1, lo.rev || 1); continue; }
      if (localChanged && this._fingerprint(lo) !== this._fingerprint(ro)) {
        this._enqueueConflict({ planId, entityId: ro.id, local: clone(lo), remote: clone(ro), fromTab });
      } else {
        Object.assign(lo, clone(ro));
      }
      synced[ro.id] = Math.max(ro.rev || 1, lo.rev || 1);
    }

    // 对方删除的实体：本地若相对共同祖先也改过 → 冲突（保留本地）；否则同步删除
    local.objects = local.objects.filter((lo) => {
      if (remoteById.has(lo.id)) return true;
      const baseRev = remoteBaseRevs[lo.id];
      if (baseRev == null) return true;
      if ((lo.rev || 1) > baseRev) {
        this._enqueueConflict({ planId, entityId: lo.id, local: clone(lo), remote: null, fromTab });
        return true;
      }
      delete synced[lo.id];
      return false;
    });

    for (const field of ['area', 'subject']) {
      const rv = remotePlan[field], lv = local[field];
      if (!rv) continue;
      const baseRev = remoteBaseRevs[field];
      if (!known(field)) synced[field] = Math.min(lv.rev || 1, rv.rev || 1) - 1;
      const remoteChanged = (rv.rev || 1) > (baseRev ?? synced[field] ?? 0);
      const localChanged = (lv.rev || 1) > (baseRev ?? synced[field] ?? 0);
      if (!remoteChanged) { synced[field] = Math.max(synced[field] ?? 0, rv.rev || 1, lv.rev || 1); continue; }
      if (localChanged && this._fingerprint(lv) !== this._fingerprint(rv)) {
        this._enqueueConflict({ planId, entityId: field, local: clone(lv), remote: clone(rv), fromTab });
      } else {
        Object.assign(lv, clone(rv));
      }
      synced[field] = Math.max(rv.rev || 1, lv.rev || 1);
    }

    if (planId === this.ui.currentPlanId) this.emit('change', { reason: 'remote' });
    this._persist(true);
  }

  _rememberRemote(planId, remotePlan) {
    if (!this.syncRevs[planId]) this.syncRevs[planId] = {};
    for (const o of remotePlan.objects) this.syncRevs[planId][o.id] = o.rev || 1;
    this.syncRevs[planId].area = remotePlan.area.rev || 1;
    this.syncRevs[planId].subject = remotePlan.subject.rev || 1;
  }

  _enqueueConflict(c) {
    if (this.conflictQueue.some((q) => q.entityId === c.entityId && q.planId === c.planId)) return;
    this.conflictQueue.push(c);
    this.emit('conflict');
  }
  nextConflict() { return this.conflictQueue[0] || null; }
  resolveConflict(choice /* 'mine' | 'theirs' */) {
    const c = this.conflictQueue.shift();
    if (!c) return;
    const plan = this.doc.plans.find((p) => p.id === c.planId);
    if (plan) {
      if (c.entityId === 'area' || c.entityId === 'subject') {
        if (choice === 'theirs') Object.assign(plan[c.entityId], c.remote);
        else { plan[c.entityId].rev = (plan[c.entityId].rev || 1) + 1; }
      } else {
        const idx = plan.objects.findIndex((o) => o.id === c.entityId);
        if (choice === 'theirs') { if (idx >= 0) plan.objects[idx] = c.remote; else plan.objects.push(c.remote); }
        else if (idx >= 0) plan.objects[idx].rev = (plan.objects[idx].rev || 1) + 1;
      }
      // 裁决结果成为新的共同基线
      if (!this.syncRevs[c.planId]) this.syncRevs[c.planId] = {};
      const winner = choice === 'theirs' ? c.remote : (c.entityId === 'area' || c.entityId === 'subject'
        ? this.doc.plans.find((p) => p.id === c.planId)?.[c.entityId]
        : this.doc.plans.find((p) => p.id === c.planId)?.objects.find((o) => o.id === c.entityId));
      if (winner) this.syncRevs[c.planId][c.entityId] = winner.rev || 1;
      // 广播裁决结果，避免另一边再次冲突
      this._persist(true);
      this._post({ type: 'edit', tab: TAB_ID, planId: c.planId, plan: clone(plan),
        baseRevs: {}, meta: { reason: 'conflict-resolved' } });
    }
    this.emit('change', { reason: 'conflict' });
    this.emit('conflict');
  }

  peerCount() { return Object.keys(this.presencePeers).length; }
}
