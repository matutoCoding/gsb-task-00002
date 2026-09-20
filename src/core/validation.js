// 规则校验引擎：只生成问题列表，绝不自动修改摆法。
// issue: { key, sev: 'error'|'warning'|'info', title, detail, entityId, type }
import { LIGHT_TYPES, getEntity } from './model.js';
import {
  entityFootprint, rectsOverlap, pointInRect,
  segmentsCross, cablePath, dist, pointInCone, findEntrancePath,
} from './geometry.js';

const EPS = 0.03;

function inRoom(ent, room) {
  const f = entityFootprint(ent);
  return f.x - f.w / 2 >= -EPS && f.y - f.h / 2 >= -EPS &&
         f.x + f.w / 2 <= room.w + EPS && f.y + f.h / 2 <= room.h + EPS;
}

export function keyLight(plan) {
  const keys = plan.objects.filter((o) => o.kind === 'light' && o.type === 'key');
  return keys[0] || plan.objects.find((o) => o.kind === 'light') || null;
}

function overlapName(o) { return o.name || o.kind; }

export function validate(plan) {
  const issues = [];
  const push = (i) => issues.push(i);
  const room = plan.room;
  const solid = plan.objects.filter((o) => o.kind !== 'outlet');
  const lights = plan.objects.filter((o) => o.kind === 'light');
  const outlets = plan.objects.filter((o) => o.kind === 'outlet');
  const area = { id: 'area', ...plan.area };
  const subject = { id: 'subject', ...plan.subject, w: plan.subject.size, h: plan.subject.size };
  const bg = plan.objects.find((o) => o.kind === 'background');

  // 1. 越墙
  for (const o of plan.objects) {
    if (!inRoom(o, room)) {
      push({ key: `bounds:${o.id}`, type: 'bounds', sev: 'error', entityId: o.id,
        title: `${overlapName(o)} 被拖到墙外`,
        detail: `当前位置 (${o.x.toFixed(1)}, ${o.y.toFixed(1)}) 超出棚范围 ${room.w}×${room.h} m，请拖回墙内。` });
    }
  }
  for (const [name, ent] of [['拍摄区域', area], ['人物站位', subject]]) {
    const f = entityFootprint(ent);
    if (f.x - f.w / 2 < -EPS || f.y - f.h / 2 < -EPS || f.x + f.w / 2 > room.w + EPS || f.y + f.h / 2 > room.h + EPS) {
      push({ key: `bounds:${ent.id}`, type: 'bounds', sev: 'error', entityId: ent.id,
        title: `${name}越出棚外`, detail: `${name}有一部分在墙外，请调整位置或大小。` });
    }
  }

  // 2. 设备互相重叠（占地冲突）
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i], b = solid[j];
      if (a.kind === 'background' || b.kind === 'background') continue; // 背景板允许灯靠近其前方
      const fa = entityFootprint(a), fb = entityFootprint(b);
      if (rectsOverlap(fa, fb)) {
        push({ key: `overlap:${a.id}:${b.id}`, type: 'overlap', sev: 'error', entityId: a.id,
          title: `${overlapName(a)} 与 ${overlapName(b)} 位置冲突`,
          detail: `两者占地重叠，现场无法同时摆在这里。` });
      }
    }
  }
  // 人物与设备
  for (const o of solid) {
    if (rectsOverlap(entityFootprint(o), entityFootprint(subject))) {
      push({ key: `overlap:subject:${o.id}`, type: 'overlap', sev: 'error', entityId: o.id,
        title: `人物站位与 ${overlapName(o)} 冲突`, detail: '人物站位上放着设备，人站不进去。' });
    }
  }

  // 3. 线缆：未接插座 / 过长
  for (const l of lights) {
    const oc = l.outletId ? outlets.find((o) => o.id === l.outletId) : null;
    if (!oc) {
      push({ key: `cable-noconn:${l.id}`, type: 'cable-noconn', sev: 'warning', entityId: l.id,
        title: `${l.name} 没有接插座`, detail: '在右侧属性里为该灯选择插座，否则现场无法供电。' });
      continue;
    }
    const d = dist(l.x, l.y, oc.x, oc.y);
    if (d > l.cableLength + EPS) {
      push({ key: `cable-short:${l.id}`, type: 'cable-short', sev: 'error', entityId: l.id,
        title: `${l.name} 的线不够长`,
        detail: `到 ${oc.name} 直线距离 ${d.toFixed(1)} m，线长只有 ${l.cableLength} m，差 ${(d - l.cableLength).toFixed(1)} m。` });
    }
  }

  // 4. 插座过载
  for (const oc of outlets) {
    const used = lights.filter((l) => l.outletId === oc.id);
    const watts = used.reduce((s, l) => s + (LIGHT_TYPES[l.type]?.power || 0), 0);
    if (watts > oc.capacity + 0.01) {
      push({ key: `overload:${oc.id}`, type: 'overload', sev: 'error', entityId: oc.id,
        title: `${oc.name} 接得太多`,
        detail: `${used.map((l) => `${l.name} ${LIGHT_TYPES[l.type]?.power || 0}W`).join('＋')} 共 ${watts}W，超过插座容量 ${oc.capacity}W。` });
    }
  }

  // 5. 线缆互相交叉
  const connected = lights
    .map((l) => ({ light: l, outlet: outlets.find((o) => o.id === l.outletId) }))
    .filter((c) => c.outlet);
  for (let i = 0; i < connected.length; i++) {
    for (let j = i + 1; j < connected.length; j++) {
      const a = cablePath(connected[i].light, connected[i].outlet);
      const b = cablePath(connected[j].light, connected[j].outlet);
      const hit = segmentsCross(a.from, a.to, b.from, b.to);
      if (hit) {
        push({ key: `cable-cross:${connected[i].light.id}:${connected[j].light.id}`,
          type: 'cable-cross', sev: 'warning',
          entityId: connected[i].light.id,
          title: `${connected[i].light.name} 与 ${connected[j].light.name} 的线互相穿过`,
          detail: `交点约在 (${hit.x.toFixed(1)}, ${hit.y.toFixed(1)})，走线会缠在一起或绊倒人。` });
      }
    }
  }

  // 6. 入口可达
  const route = findEntrancePath(plan);
  if (!route.found) {
    if (route.reason === 'door-blocked') {
      push({ key: 'entry:door', type: 'entry', sev: 'error', entityId: null,
        title: '拍摄区域没有可走的入口', detail: '门洞本身被设备堵住了，请把门口的设备移开。' });
    } else {
      const blockers = blockingEntrance(plan);
      push({ key: 'entry:route', type: 'entry', sev: 'error',
        entityId: blockers[0]?.id || null,
        title: '拍摄区域没有可走的入口',
        detail: blockers.length
          ? `从门到拍摄区的通道被 ${blockers.slice(0, 3).map((b) => b.name).join('、')} 堵死，请让出一条路。`
          : '从门到拍摄区走不通，请检查拍摄区四周是否被设备或背景板围死。' });
    }
  }

  // 7. 设备占进拍摄区
  for (const o of solid) {
    if (o.kind === 'background') continue;
    if (rectsOverlap(entityFootprint(o), entityFootprint(area))) {
      push({ key: `inarea:${o.id}`, type: 'inarea', sev: 'warning', entityId: o.id,
        title: `${overlapName(o)} 占进了拍摄区域`, detail: '拍摄区域是留给人物和机位的空间，设备建议放在区域外。' });
    }
  }

  // 8. 主灯光路被挡 / 照不到人物
  const key = keyLight(plan);
  if (!key) {
    push({ key: 'key:none', type: 'key-missing', sev: 'warning', entityId: null,
      title: '还没有指定主灯', detail: '把一盏灯的类型设为“主灯”，系统才能给出联动建议。' });
  } else {
    const spec = LIGHT_TYPES[key.type] || LIGHT_TYPES.other;
    if (!pointInCone(key, spec, subject.x, subject.y)) {
      push({ key: 'key:cover', type: 'key-cover', sev: 'error', entityId: key.id,
        title: `${key.name} 照不到人物站位`, detail: '人物不在主灯光锥内，移动主灯或调整它的方向。' });
    } else {
      const blocker = coneBlocked(plan, key, spec, subject);
      if (blocker) {
        push({ key: `key:block:${blocker.id}`, type: 'key-blocked', sev: 'warning', entityId: blocker.id,
          title: `${key.name} 到人物之间被 ${overlapName(blocker)} 挡住`,
          detail: '光路上有设备或支架会在人物身上投下明显阴影，请挪开遮挡物或调整灯位。' });
      }
    }
  }

  // 9. 背景板离拍摄区过远
  if (bg) {
    const near = dist(bg.x, bg.y, area.x, area.y + area.h / 2);
    if (near > 1.6) {
      push({ key: 'bg:far', type: 'bg-far', sev: 'info', entityId: bg.id,
        title: '背景板离拍摄区域较远', detail: `距离约 ${near.toFixed(1)} m，背景可能不在画面里，建议贴近拍摄区布置。` });
    }
  }

  return { issues, route, keyLight: key };
}

// 主光到人物线段是否穿过任何障碍物
function coneBlocked(plan, key, spec, subject) {
  const p1 = { x: key.x, y: key.y }, p2 = { x: subject.x, y: subject.y };
  for (const o of plan.objects) {
    if (o.kind === 'outlet' || o.id === key.id) continue;
    const f = entityFootprint(o);
    const verts = [
      { x: f.x - f.w / 2, y: f.y - f.h / 2 }, { x: f.x + f.w / 2, y: f.y - f.h / 2 },
      { x: f.x + f.w / 2, y: f.y + f.h / 2 }, { x: f.x - f.w / 2, y: f.y + f.h / 2 },
    ];
    const edges = [[verts[0], verts[1]], [verts[1], verts[2]], [verts[2], verts[3]], [verts[3], verts[0]]];
    for (const [a, b] of edges) if (segmentsCross(p1, p2, a, b)) return o;
    if (pointInRect(key.x, key.y, f) === false && pointInRect(subject.x, subject.y, f)) return o;
  }
  return null;
}

// 粗判哪些障碍挡在入口与拍摄区之间：逐个尝试移除（只在已经无路径时运行，
// 且优先试靠近门到拍摄区连线上的对象，最多尝试 14 个以保证大量设备时不卡顿）
function blockingEntrance(plan) {
  const door = plan.room.door, area = plan.area;
  const start = { x: 0.25, y: door.y + door.w / 2 };
  const goal = { x: area.x - area.w / 2, y: area.y };
  const all = plan.objects
    .filter((o) => o.kind !== 'outlet' && o.kind !== 'background')
    .map((o) => ({ o, d: pointSegDist(o.x, o.y, start, goal) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 14);
  const blockers = [];
  for (const { o } of all) {
    const trial = JSON.parse(JSON.stringify(plan));
    trial.objects = trial.objects.filter((x) => x.id !== o.id);
    if (findEntrancePath(trial).found) blockers.push(o);
  }
  return blockers;
}

function pointSegDist(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1;
  let t = ((px - a.x) * dx + (py - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}
