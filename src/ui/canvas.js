// SVG 画布：渲染 + 指针交互。拖动中只更新 transform/几何属性，保证 60fps。
import { LIGHT_TYPES } from '../core/model.js';
import { clamp, rotatePoint } from '../core/geometry.js';

const SVGNS = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  if (parent) parent.appendChild(node);
  return node;
}

export class StudioCanvas {
  constructor(svg, store, callbacks) {
    this.svg = svg;
    this.store = store;
    this.cb = callbacks; // { validateNow, onSelect, onCommit, toast }
    this.selectedId = null;
    this.view = { scale: 60, ox: 40, oy: 30 };
    this.drag = null;
    this.vm = null;
    this._buildStatic();
    this._bindPointer();
  }

  setSelected(id) { this.selectedId = id; this.render(); }
  selectEntity(id) { this.selectedId = id; this.render(); }

  // ---- 坐标 ----
  toWorld(evt) {
    const rect = this.svg.getBoundingClientRect();
    const x = (evt.clientX - rect.left - this.view.ox) / this.view.scale;
    const y = (evt.clientY - rect.top - this.view.oy) / this.view.scale;
    return { x, y };
  }
  sx(x) { return this.view.ox + x * this.view.scale; }
  sy(y) { return this.view.oy + y * this.view.scale; }

  _buildStatic() {
    const defs = el('defs', {}, this.svg);
    this.clip = el('clipPath', { id: 'room-clip' }, defs);
    this.clipRect = el('rect', {}, this.clip);
    const g = el('g', { id: 'layers' }, this.svg);
    this.gGrid = el('g', { class: 'l-grid' }, g);
    this.gCone = el('g', { class: 'l-cone', 'clip-path': 'url(#room-clip)' }, g);
    this.gPath = el('g', { class: 'l-path' }, g);
    this.gCable = el('g', { class: 'l-cable' }, g);
    this.gArea = el('g', { class: 'l-area' }, g);
    this.gEnt = el('g', { class: 'l-ent' }, g);
    this.gHandle = el('g', { class: 'l-handle' }, g);
  }

  // ---- 全量渲染 ----
  render(vm = this.cb.getViewModel()) {
    if (!vm || !vm.plan) return;
    this.vm = vm;
    const plan = vm.plan;
    this._fit(plan.room.w, plan.room.h);
    this.clipRect.setAttribute('x', this.sx(0));
    this.clipRect.setAttribute('y', this.sy(0));
    this.clipRect.setAttribute('width', plan.room.w * this.view.scale);
    this.clipRect.setAttribute('height', plan.room.h * this.view.scale);
    this._renderGrid(plan);
    this._renderCones(plan, vm.entityStatus);
    this._renderRoute(vm.route);
    this._renderCables(plan, vm.entityStatus);
    this._renderArea(plan, vm.entityStatus['area']);
    this._renderEntities(plan, vm.entityStatus);
    this._renderHandles(plan);
  }

  _fit(roomW, roomH) {
    const rect = this.svg.getBoundingClientRect();
    const padX = 70, padY = 60;
    const scale = Math.max(20, Math.min((rect.width - padX) / roomW, (rect.height - padY) / roomH));
    this.view.scale = Number.isFinite(scale) ? scale : this.view.scale;
    this.view.ox = (rect.width - roomW * this.view.scale) / 2;
    this.view.oy = (rect.height - roomH * this.view.scale) / 2;
  }

  _clear(g) { while (g.firstChild) g.removeChild(g.firstChild); }

  _renderGrid(plan) {
    const g = this.gGrid; this._clear(g);
    const { w, h } = plan.room, door = plan.room.door;
    el('rect', { x: this.sx(0), y: this.sy(0), width: w * this.view.scale, height: h * this.view.scale,
      rx: 8, fill: '#20242e', stroke: '#4a5068', 'stroke-width': 3 }, g);
    for (let x = 1; x < w; x++) el('line', { x1: this.sx(x), y1: this.sy(0), x2: this.sx(x), y2: this.sy(h),
      stroke: '#2a2f3d', 'stroke-width': 1 }, g);
    for (let y = 1; y < h; y++) el('line', { x1: this.sx(0), y1: this.sy(y), x2: this.sx(w), y2: this.sy(y),
      stroke: '#2a2f3d', 'stroke-width': 1 }, g);
    // 门（西墙开口）
    el('rect', { x: this.sx(0) - 5, y: this.sy(door.y), width: 10, height: door.w * this.view.scale,
      fill: '#5b8cff', rx: 3 }, g);
    el('text', { x: this.sx(0) + 6, y: this.sy(door.y + door.w / 2) + 4, fill: '#9db8ff',
      'font-size': 11, text: '门' }, g);
    // 尺寸标注
    el('text', { x: this.sx(w / 2), y: this.sy(h) + 20, 'text-anchor': 'middle',
      fill: '#6b7284', 'font-size': 11, text: `${w} m` }, g);
    el('text', { x: this.sx(w) + 18, y: this.sy(h / 2), 'text-anchor': 'middle',
      fill: '#6b7284', 'font-size': 11,
      transform: `rotate(-90 ${this.sx(w) + 18} ${this.sy(h / 2)})`, text: `${h} m` }, g);
  }

  _sevColor(sev, status) {
    if (status === 'resolved') return '#4ecb71';
    if (status === 'waived') return '#b48cf2';
    if (status === 'reopened') return sev === 'error' ? '#ff5d6c' : '#ffb04d';
    return sev === 'error' ? '#ff5d6c' : sev === 'warning' ? '#ffb04d' : '#54c8e8';
  }

  _renderCones(plan, statusMap) {
    const g = this.gCone; this._clear(g);
    for (const o of plan.objects) {
      if (o.kind !== 'light') continue;
      const spec = LIGHT_TYPES[o.type] || LIGHT_TYPES.other;
      const half = (spec.cone / 2) * Math.PI / 180;
      const base = o.angle * Math.PI / 180;
      const N = 16;
      let d = `M ${this.sx(o.x)} ${this.sy(o.y)}`;
      for (let i = 0; i <= N; i++) {
        const a = base - half + (2 * half * i) / N;
        d += ` L ${this.sx(o.x + Math.cos(a) * spec.reach)} ${this.sy(o.y + Math.sin(a) * spec.reach)}`;
      }
      d += ' Z';
      const st = statusMap[o.id];
      const fill = this.selectedId === o.id ? `${spec.color}26` : `${spec.color}12`;
      const poly = el('path', { d, fill, stroke: spec.color, 'stroke-width': 1, 'stroke-dasharray': '4 4',
        'data-id': o.id, class: 'cone' }, g);
      if (st && st.sev) poly.setAttribute('stroke', this._sevColor(st.sev, st.status));
    }
  }

  _renderRoute(vm) {
    const g = this.gPath; this._clear(g);
    if (vm.route && vm.route.found && vm.route.path) {
      const d = vm.route.path.map((p, i) => `${i ? 'L' : 'M'} ${this.sx(p.x)} ${this.sy(p.y)}`).join(' ');
      el('path', { d, fill: 'none', stroke: '#4ecb71', 'stroke-width': 4, 'stroke-dasharray': '2 8',
        'stroke-linecap': 'round', opacity: 0.75 }, g);
    }
  }

  _renderCables(plan, statusMap) {
    const g = this.gCable; this._clear(g);
    this.cableNodes = new Map();
    const outlets = new Map(plan.objects.filter((o) => o.kind === 'outlet').map((o) => [o.id, o]));
    for (const o of plan.objects) {
      if (o.kind !== 'light' || !o.outletId) continue;
      const oc = outlets.get(o.outletId);
      if (!oc) continue;
      const st = statusMap[o.id] || {};
      const color = (st.status === 'resolved') ? '#4ecb71'
        : (st.status === 'waived') ? '#b48cf2'
        : (st.cableShort || st.cableCross) ? '#ff5d6c' : '#7d8aa8';
      const line = el('line', { x1: this.sx(o.x), y1: this.sy(o.y), x2: this.sx(oc.x), y2: this.sy(oc.y),
        stroke: color, 'stroke-width': 2.5, 'stroke-dasharray': st.cableShort ? '6 4' : 'none', opacity: 0.85,
        'data-cable': o.id }, g);
      const d = Math.hypot(o.x - oc.x, o.y - oc.y);
      const txt = el('text', { x: this.sx((o.x + oc.x) / 2), y: this.sy((o.y + oc.y) / 2) - 3,
        fill: color, 'font-size': 10, 'text-anchor': 'middle', text: `${d.toFixed(1)}/${o.cableLength}m` }, g);
      this.cableNodes.set(o.id, { line, txt });
    }
  }

  _renderArea(plan, areaStatus) {
    const g = this.gArea; this._clear(g);
    const a = plan.area;
    const color = areaStatus?.status === 'resolved' ? '#4ecb71'
      : areaStatus?.status === 'waived' ? '#b48cf2'
      : areaStatus?.sev === 'error' ? '#ff5d6c' : areaStatus?.sev === 'warning' ? '#ffb04d' : '#5b8cff';
    el('rect', { x: this.sx(a.x - a.w / 2), y: this.sy(a.y - a.h / 2),
      width: a.w * this.view.scale, height: a.h * this.view.scale,
      fill: '#5b8cff12', stroke: color, 'stroke-width': 2, 'stroke-dasharray': '8 5',
      'data-id': 'area', class: 'movable', rx: 4 }, g);
    el('text', { x: this.sx(a.x), y: this.sy(a.y - a.h / 2) - 6, 'text-anchor': 'middle',
      fill: color, 'font-size': 11, text: '拍摄区域' }, g);
    // 缩放手柄（右下角）
    el('rect', { x: this.sx(a.x + a.w / 2) - 7, y: this.sy(a.y + a.h / 2) - 7, width: 14, height: 14,
      fill: color, 'data-id': 'area-resize', class: 'resize-handle', rx: 2 }, g);
    this._renderSubject(plan, color);
  }

  _renderSubject(plan, areaColor) {
    const s = plan.subject;
    const g = this.gArea;
    const grp = el('g', { 'data-id': 'subject', class: 'movable' }, g);
    const st = this.vm.entityStatus['subject'];
    const color = st?.status === 'resolved' ? '#4ecb71' : st?.sev ? this._sevColor(st.sev, st.status) : '#9fb2d8';
    el('circle', { cx: this.sx(s.x), cy: this.sy(s.y), r: s.size / 2 * this.view.scale,
      fill: '#9fb2d822', stroke: color, 'stroke-width': 2 }, grp);
    const nose = rotatePoint(0, 0, s.size / 2, 0, s.angle || 0);
    el('line', { x1: this.sx(s.x), y1: this.sy(s.y), x2: this.sx(s.x + nose.x), y2: this.sy(s.y + nose.y),
      stroke: color, 'stroke-width': 2.5 }, grp);
    el('text', { x: this.sx(s.x), y: this.sy(s.y) - 16, 'text-anchor': 'middle',
      fill: '#9fb2d8', 'font-size': 10, text: '人物' }, grp);
  }

  _renderEntities(plan, statusMap) {
    const g = this.gEnt; this._clear(g);
    this.entityNodes = new Map();
    for (const o of plan.objects) {
      const grp = el('g', { 'data-id': o.id, class: 'movable' }, g);
      const st = statusMap[o.id] || {};
      const stroke = st.sev ? this._sevColor(st.sev, st.status) : '#8b91a3';
      if (this.selectedId === o.id) grp.setAttribute('class', 'movable selected');
      if (plan.confirmed[o.id]) grp.setAttribute('opacity', '0.95');

      if (o.kind === 'background') {
        const w = o.w * this.view.scale, h = o.h * this.view.scale;
        el('rect', { x: this.sx(o.x) - w / 2, y: this.sy(o.y) - h / 2, width: w, height: h,
          fill: '#3c4356', stroke, 'stroke-width': 2, rx: 2 }, grp);
        for (let i = -1; i <= 1; i++) el('line', { x1: this.sx(o.x) + i * w / 4, y1: this.sy(o.y) - h / 2,
          x2: this.sx(o.x) + i * w / 4, y2: this.sy(o.y) + h / 2, stroke: '#555e75' }, grp);
      } else if (o.kind === 'outlet') {
        const r = o.size / 2 * this.view.scale;
        el('rect', { x: this.sx(o.x) - r, y: this.sy(o.y) - r, width: r * 2, height: r * 2,
          fill: '#2c3142', stroke, 'stroke-width': 2, rx: 3 }, grp);
        el('circle', { cx: this.sx(o.x) - 3, cy: this.sy(o.y), r: 1.8, fill: stroke }, grp);
        el('circle', { cx: this.sx(o.x) + 3, cy: this.sy(o.y), r: 1.8, fill: stroke }, grp);
      } else if (o.kind === 'stand') {
        const r = o.size / 2 * this.view.scale;
        const cx = this.sx(o.x), cy = this.sy(o.y);
        el('circle', { cx, cy, r: r * 0.7, fill: '#2c3142', stroke, 'stroke-width': 2 }, grp);
        el('line', { x1: cx - r * 0.7, y1: cy, x2: cx + r * 0.7, y2: cy, stroke, 'stroke-width': 1.5 }, grp);
        el('line', { x1: cx, y1: cy - r * 0.7, x2: cx, y2: cy + r * 0.7, stroke, 'stroke-width': 1.5 }, grp);
      } else if (o.kind === 'light') {
        const spec = LIGHT_TYPES[o.type] || LIGHT_TYPES.other;
        const r = o.size / 2 * this.view.scale;
        el('circle', { cx: this.sx(o.x), cy: this.sy(o.y), r, fill: spec.color, stroke, 'stroke-width': 2.5 }, grp);
        el('circle', { cx: this.sx(o.x), cy: this.sy(o.y), r: r * 0.32, fill: '#20242e' }, grp);
        const tip = rotatePoint(0, 0, o.size / 2 + 0.12, 0, o.angle);
        el('line', { x1: this.sx(o.x), y1: this.sy(o.y), x2: this.sx(o.x + tip.x), y2: this.sy(o.y + tip.y),
          stroke: spec.color, 'stroke-width': 3 }, grp);
      }
      el('text', { x: this.sx(o.x), y: this.sy(o.y) - o.size / 2 * this.view.scale - 5,
        'text-anchor': 'middle', fill: '#cdd3e4', 'font-size': 10, text: o.name }, grp);
      if (plan.confirmed[o.id]) {
        el('text', { x: this.sx(o.x) + 10, y: this.sy(o.y) - 10, fill: '#4ecb71', 'font-size': 12, text: '✓' }, grp);
      }
      this.entityNodes.set(o.id, grp);
    }
  }

  _renderHandles() {
    // 选中灯时显示旋转手柄
    const g = this.gHandle; this._clear(g);
    const plan = this.vm.plan;
    const ent = this.selectedId && plan.objects.find((o) => o.id === this.selectedId);
    if (ent && ent.kind === 'light') {
      const hp = rotatePoint(ent.x, ent.y, ent.size / 2 + 0.55, 0, ent.angle);
      el('circle', { cx: this.sx(hp.x), cy: this.sy(hp.y), r: 8, fill: '#5b8cff',
        stroke: '#e6e8ef', 'stroke-width': 1.5, 'data-id': 'rotate-handle', class: 'rotate-handle' }, g);
    }
  }

  // ---- 拖动中的局部刷新（不重建 DOM）----
  _applyLiveTransform() {
    const d = this.drag;
    if (!d) return;
    const node = d.type === 'move' && d.id !== 'area' && d.id !== 'subject'
      ? this.entityNodes.get(d.id) : null;
    if (node && d.liveMode === 'translate') {
      node.setAttribute('transform', `translate(${(d.x - d.start.x) * this.view.scale} ${(d.y - d.start.y) * this.view.scale})`);
      this._updateCableLive(d.id, d.x, d.y);
      this._updateConeLive(d.id, d.x, d.y, null);
      return;
    }
    // 其他情况（旋转/缩放/区域/人物）退化为实时局部重绘相关层
    this._renderCones(this.vm.plan, this.vm.entityStatus);
    this._renderCables(this.vm.plan, this.vm.entityStatus);
    if (d.id === 'area' || d.type === 'resize') this._renderArea(this.vm.plan, this.vm.entityStatus['area']);
    if (d.id === 'subject') this._renderArea(this.vm.plan, this.vm.entityStatus['area']);
    if (d.type === 'rotate') this._renderHandles();
    const entNode = this.entityNodes.get(d.id);
    if (entNode) {
      entNode.removeAttribute('transform');
      const fresh = this.vm.plan.objects.find((o) => o.id === d.id);
      if (fresh) {
        entNode.querySelectorAll('text, circle, line, rect').forEach(() => {});
      }
    }
  }

  _updateCableLive(id, x, y) {
    const rec = this.cableNodes?.get(id);
    if (rec) {
      rec.line.setAttribute('x1', this.sx(x)); rec.line.setAttribute('y1', this.sy(y));
      const oc = this.vm.plan.objects.find((o) => o.id === this.vm.plan.objects.find((l) => l.id === id)?.outletId);
      if (oc) {
        rec.txt.setAttribute('x', this.sx((x + oc.x) / 2));
        rec.txt.setAttribute('y', this.sy((y + oc.y) / 2) - 3);
        rec.txt.textContent = `${Math.hypot(x - oc.x, y - oc.y).toFixed(1)}/${this.drag.entity.cableLength}m`;
      }
    }
  }

  _updateConeLive(id, x, y, angle) {
    const plan = this.vm.plan;
    const light = plan.objects.find((o) => o.id === id);
    if (!light) return;
    const useAngle = angle ?? light.angle;
    const spec = LIGHT_TYPES[light.type] || LIGHT_TYPES.other;
    const half = (spec.cone / 2) * Math.PI / 180;
    const base = useAngle * Math.PI / 180;
    let dd = `M ${this.sx(x)} ${this.sy(y)}`;
    for (let i = 0; i <= 16; i++) {
      const a = base - half + (2 * half * i) / 16;
      dd += ` L ${this.sx(x + Math.cos(a) * spec.reach)} ${this.sy(y + Math.sin(a) * spec.reach)}`;
    }
    dd += ' Z';
    const path = this.gCone.querySelector(`[data-id="${id}"]`);
    if (path) path.setAttribute('d', dd);
  }

  _bindPointer() {
    const downAt = (e) => this.toWorld(e);
    this.svg.addEventListener('pointerdown', (e) => {
      const target = e.target.closest('[data-id]');
      if (!target) return;
      e.preventDefault();
      this.svg.setPointerCapture(e.pointerId);
      const id = target.getAttribute('data-id');
      const w = downAt(e);
      const plan = this.vm.plan;
      const base = { world: w };
      if (id === 'rotate-handle') {
        const ent = plan.objects.find((o) => o.id === this.selectedId);
        if (!ent) return;
        base.type = 'rotate'; base.id = ent.id; base.entity = ent;
        base.angle0 = ent.angle;
        base.rev0 = ent.rev || 1;
      } else if (id === 'area-resize') {
        if (plan.confirmed.area && !this.cb.allowLocked('area')) { this.drag = null; this.cb.onLocked?.('area'); return; }
        base.type = 'resize'; base.id = 'area'; base.rev0 = plan.area.rev || 1;
        base.left0 = plan.area.x - plan.area.w / 2;
        base.top0 = plan.area.y - plan.area.h / 2;
      } else if (id === 'area') {
        this.cb.onSelect('area');
        base.type = 'move'; base.id = 'area'; base.rev0 = plan.area.rev || 1;
        base.x0 = plan.area.x; base.y0 = plan.area.y;
      } else if (id === 'subject') {
        this.cb.onSelect('subject');
        if (plan.confirmed.subject && !this.cb.allowLocked('subject')) { this.drag = null; this.cb.onLocked?.('subject'); return; }
        base.type = 'move'; base.id = 'subject'; base.rev0 = plan.subject.rev || 1;
        base.x0 = plan.subject.x; base.y0 = plan.subject.y;
      } else {
        const ent = plan.objects.find((o) => o.id === id);
        if (!ent) return;
        if (plan.confirmed[id] && !this.cb.allowLocked(id)) { this.cb.onSelect(id); this.cb.onLocked?.(id); return; }
        this.cb.onSelect(id);
        base.type = 'move'; base.id = id; base.entity = ent; base.liveMode = 'translate';
        base.x0 = ent.x; base.y0 = ent.y; base.rev0 = ent.rev || 1;
      }
      this.drag = base;
    });

    this.svg.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) return;
      const w = this.toWorld(e);
      const plan = this.vm.plan;
      const snap = this.store.ui.snap ? 0.1 : 0;
      const sn = (v) => snap ? Math.round(v / snap) * snap : Math.round(v * 100) / 100;

      if (d.type === 'rotate') {
        d.entity.angle = Math.round(Math.atan2(w.y - d.entity.y, w.x - d.entity.x) * 180 / Math.PI);
        this._redrawDragLayer(d.id, 'rotate');
      } else if (d.type === 'resize') {
        const a = plan.area;
        const nw = clamp(sn(w.x - d.left0), 1, plan.room.w);
        const nh = clamp(sn(w.y - d.top0), 1, plan.room.h);
        const nx = d.left0 + nw / 2, ny = d.top0 + nh / 2;
        if (nx + nw / 2 <= plan.room.w && ny + nh / 2 <= plan.room.h) {
          a.w = nw; a.h = nh; a.x = nx; a.y = ny;
        }
        this._redrawDragLayer('area');
      } else {
        const dx = w.x - d.world.x, dy = w.y - d.world.y;
        if (d.id === 'area') {
          plan.area.x = clamp(sn(d.x0 + dx), plan.area.w / 2, plan.room.w - plan.area.w / 2);
          plan.area.y = clamp(sn(d.y0 + dy), plan.area.h / 2, plan.room.h - plan.area.h / 2);
          this._redrawDragLayer('area');
        } else if (d.id === 'subject') {
          plan.subject.x = clamp(sn(d.x0 + dx), 0.3, plan.room.w - 0.3);
          plan.subject.y = clamp(sn(d.y0 + dy), 0.3, plan.room.h - 0.3);
          this._redrawDragLayer('subject');
        } else {
          d.entity.x = clamp(sn(d.x0 + dx), 0.1, plan.room.w - 0.1);
          d.entity.y = clamp(sn(d.y0 + dy), 0.1, plan.room.h - 0.1);
          const node = this.entityNodes.get(d.id);
          if (node) node.setAttribute('transform', `translate(${(d.entity.x - d.x0) * this.view.scale} ${(d.entity.y - d.y0) * this.view.scale})`);
          this._updateCableLive(d.id, d.entity.x, d.entity.y);
          this._updateConeLive(d.id, d.entity.x, d.entity.y, null);
        }
      }
      this.cb.onTransient();
    });

    const end = () => {
      if (!this.drag) return;
      const d = this.drag;
      this.drag = null;
      this.entityNodes?.forEach((node) => node.removeAttribute('transform'));
      this.cb.onCommit({ id: d.id, type: d.type, rev0: d.rev0 });
    };
    this.svg.addEventListener('pointerup', end);
    this.svg.addEventListener('pointercancel', end);
  }

  // 拖动中对区域/人物/旋转做轻量局部重绘（这些对象数量少）
  _redrawDragLayer(id, mode) {
    if (id === 'area' || id === 'subject') {
      this._renderArea(this.vm.plan, this.vm.entityStatus['area']);
    }
    if (mode === 'rotate' || (this.vm.plan.objects.find((o) => o.id === id)?.kind === 'light')) {
      this._renderCones(this.vm.plan, this.vm.entityStatus);
      this._renderCables(this.vm.plan, this.vm.entityStatus);
      // 重建被转的那盏灯以更新朝向短线
      this._refreshOneEntity(id);
      this._renderHandles();
    }
  }

  _refreshOneEntity(id) {
    // 旋转过程中设备数通常 <100，整体重画该层仍然足够流畅
    this._renderEntities(this.vm.plan, this.vm.entityStatus);
  }

  flash(id) {
    const node = id === 'area' ? this.gArea.querySelector('[data-id="area"]')
      : id === 'subject' ? this.gArea.querySelector('[data-id="subject"]')
      : this.entityNodes.get(id);
    if (!node) return;
    node.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 500, iterations: 2 });
  }
}
