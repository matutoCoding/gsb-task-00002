// 数据模型：全部纯函数，不依赖 DOM。
// 坐标单位：米。角度：度，0 = 朝东(x+)，顺时针为正（90 = 朝南 y+）。

export const ROOM_W = 10;
export const ROOM_H = 8;
export const GRID = 0.1; // 吸附网格

export const LIGHT_TYPES = {
  key:  { label: '主灯', cone: 55, reach: 6, power: 400, color: '#ffd36b', cable: 6 },
  fill: { label: '补光', cone: 70, reach: 5, power: 200, color: '#b9d4ff' },
  rim:  { label: '轮廓光', cone: 50, reach: 4, power: 150, color: '#c8a8ff' },
  other:{ label: '普通灯', cone: 60, reach: 4, power: 100, color: '#e6e8ef' },
};

// 各类设备占地（米，正方形/矩形）
export const SIZES = {
  light: 0.55,
  stand: 0.6,
  background: { w: 3.0, h: 0.18 },
  outlet: 0.34,
  subject: 0.5,
};

export function uid(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
}

export function makeLight(opts = {}) {
  const type = opts.type || 'other';
  const spec = LIGHT_TYPES[type];
  return {
    id: opts.id || uid('lt'),
    kind: 'light',
    name: opts.name || spec.label,
    type,
    x: opts.x ?? 2, y: opts.y ?? 2,
    angle: opts.angle ?? 90,
    size: SIZES.light,
    cableLength: opts.cableLength ?? spec.cable ?? 5,
    outletId: opts.outletId || null,
    rev: opts.rev ?? 1,
  };
}

export function makeStand(opts = {}) {
  return { id: opts.id || uid('st'), kind: 'stand', name: opts.name || '空支架',
    x: opts.x ?? 1, y: opts.y ?? 1, size: SIZES.stand, holdsLightId: null, rev: opts.rev ?? 1 };
}

export function makeBackground(opts = {}) {
  const s = SIZES.background;
  return { id: opts.id || uid('bg'), kind: 'background', name: opts.name || '背景板',
    x: opts.x ?? ROOM_W / 2, y: opts.y ?? ROOM_H - 0.2, w: s.w, h: s.h,
    angle: opts.angle ?? 0, rev: opts.rev ?? 1 };
}

export function makeOutlet(opts = {}) {
  return { id: opts.id || uid('oc'), kind: 'outlet', name: opts.name || '插座',
    x: opts.x ?? ROOM_W - 0.2, y: opts.y ?? 1, size: SIZES.outlet,
    capacity: opts.capacity ?? 600, rev: opts.rev ?? 1 };
}

export function makePlan(name) {
  // 默认棚：一面背景板、拍摄区、人物、三灯三点、两个插座
  const bg = makeBackground({ id: 'bg_main', x: 5, y: 7.55, angle: 0 });
  const outA = makeOutlet({ id: 'oc_a', name: '插座 A（东墙）', x: 9.8, y: 2.2, capacity: 800 });
  const outB = makeOutlet({ id: 'oc_b', name: '插座 B（西墙）', x: 0.2, y: 3.0, capacity: 500 });
  const key = makeLight({ id: 'lt_key', name: '主灯', type: 'key', x: 3.2, y: 4.2, angle: 65, cableLength: 5, outletId: 'oc_a' });
  const fill = makeLight({ id: 'lt_fill', name: '补光', type: 'fill', x: 6.9, y: 4.6, angle: 115, cableLength: 4, outletId: 'oc_a' });
  const rim = makeLight({ id: 'lt_rim', name: '轮廓光', type: 'rim', x: 5.0, y: 2.0, angle: 175, cableLength: 6, outletId: 'oc_b' });
  return {
    id: uid('plan'),
    name: name || '方案 1',
    room: { w: ROOM_W, h: ROOM_H, door: { x: 0.0, y: 3.2, w: 0.9 } }, // 门洞在西墙
    area: { x: 5.0, y: 5.4, w: 3.0, h: 2.4, rev: 1 },
    subject: { x: 5.0, y: 6.4, angle: 180, size: SIZES.subject, rev: 1 },
    objects: [bg, outA, outB, key, fill, rim, makeStand({ id: 'st_1', x: 1.4, y: 6.2 }), makeStand({ id: 'st_2', x: 8.6, y: 6.4 })],
    confirmed: {}, // entityId -> true
    createdAt: Date.now(),
  };
}

export function makeBlankPlan(name) {
  const p = makePlan(name);
  p.objects = p.objects.filter((o) => o.kind !== 'stand');
  return p;
}

export const ENTITY_KINDS = ['light', 'stand', 'background', 'outlet'];

export function entitiesOf(plan) {
  const list = [...plan.objects];
  return list;
}

export function getEntity(plan, id) {
  if (id === 'area') return { id: 'area', kind: 'area', ...plan.area };
  if (id === 'subject') return { id: 'subject', kind: 'subject', ...plan.subject };
  return plan.objects.find((o) => o.id === id) || null;
}

export function isFixed(plan, id) {
  return !!plan.confirmed[id];
}

export function touch(entity) {
  entity.rev = (entity.rev || 1) + 1;
  return entity;
}

export function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// 对一个实体做可变更新并 bump rev
export function mutate(plan, id, patch) {
  if (id === 'area') { Object.assign(plan.area, patch); touch(plan.area); return plan.area; }
  if (id === 'subject') { Object.assign(plan.subject, patch); touch(plan.subject); return plan.subject; }
  const ent = plan.objects.find((o) => o.id === id);
  if (ent) { Object.assign(ent, patch); touch(ent); }
  return ent;
}

export function removeEntity(plan, id) {
  plan.objects = plan.objects.filter((o) => o.id !== id);
  // 清理引用
  for (const o of plan.objects) {
    if (o.outletId === id) o.outletId = null;
    if (o.holdsLightId === id) o.holdsLightId = null;
  }
  delete plan.confirmed[id];
}

export function addEntity(plan, entity) {
  plan.objects.push(entity);
  return entity;
}
