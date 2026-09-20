// 几何工具：矩形碰撞、线段相交、锥形光域、栅格 BFS 寻路。纯函数无 DOM。

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// 将绕 cx,cy 旋转 a 度的局部点(lx,ly)转到世界坐标（角度顺时针、y 向下）
export function rotatePoint(cx, cy, lx, ly, a) {
  const r = (a * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return { x: cx + lx * c - ly * s, y: cy + lx * s + ly * c };
}

// 轴对齐矩形（x,y 为中心）
export function rectCenter(x, y, w, h) { return { x, y, w, h }; }
export function rectsOverlap(a, b) {
  return Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;
}
export function pointInRect(px, py, r, pad = 0) {
  return Math.abs(px - r.x) <= r.w / 2 + pad && Math.abs(py - r.y) <= r.h / 2 + pad;
}

// 旋转矩形与轴对齐矩形是否相交：SAT
export function rotatedRectAABBOverlap(cx, cy, w, h, a, b) {
  const corners = [
    rotatePoint(cx, cy, -w / 2, -h / 2, a),
    rotatePoint(cx, cy,  w / 2, -h / 2, a),
    rotatePoint(cx, cy,  w / 2,  h / 2, a),
    rotatePoint(cx, cy, -w / 2,  h / 2, a),
  ];
  const axes = [
    { x: 1, y: 0 }, { x: 0, y: 1 },
    { x: Math.cos((a * Math.PI) / 180), y: Math.sin((a * Math.PI) / 180) },
    { x: -Math.sin((a * Math.PI) / 180), y: Math.cos((a * Math.PI) / 180) },
  ];
  for (const ax of axes) {
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (const p of corners) {
      const d = p.x * ax.x + p.y * ax.y;
      minA = Math.min(minA, d); maxA = Math.max(maxA, d);
    }
    const verts = [
      { x: b.x - b.w / 2, y: b.y - b.h / 2 }, { x: b.x + b.w / 2, y: b.y - b.h / 2 },
      { x: b.x + b.w / 2, y: b.y + b.h / 2 }, { x: b.x - b.w / 2, y: b.y + b.h / 2 },
    ];
    for (const p of verts) {
      const d = p.x * ax.x + p.y * ax.y;
      minB = Math.min(minB, d); maxB = Math.max(maxB, d);
    }
    if (maxA <= minB || maxB <= minA) return false;
  }
  return true;
}

// 实体占地（返回 AABB；背景板旋转时仍按其外接 AABB 粗判）
export function entityFootprint(ent) {
  if (ent.kind === 'area' || ent.kind === 'subject') {
    return { x: ent.x, y: ent.y, w: ent.w, h: ent.h };
  }
  if (ent.kind === 'background') {
    const a = ((ent.angle || 0) * Math.PI) / 180;
    const w = Math.abs(ent.w * Math.cos(a)) + Math.abs(ent.h * Math.sin(a));
    const h = Math.abs(ent.w * Math.sin(a)) + Math.abs(ent.h * Math.cos(a));
    return { x: ent.x, y: ent.y, w, h };
  }
  const sz = ent.size || 0.5;
  return { x: ent.x, y: ent.y, w: sz, h: sz };
}

export function collectObstacles(plan, opts = {}) {
  const obs = [];
  const pad = opts.pad ?? 0.1;
  for (const o of plan.objects) {
    if (o.kind === 'outlet') continue; // 墙上插座不挡路
    const f = entityFootprint(o);
    obs.push({ id: o.id, kind: o.kind, name: o.name, rect: { ...f, w: f.w + pad * 2, h: f.h + pad * 2 } });
  }
  return obs;
}

// 线段相交（不含共端点）
export function segmentsCross(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  if (t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98) {
    return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
  }
  return null;
}

// 灯到插座的直线
export function cablePath(light, outlet) {
  return { from: { x: light.x, y: light.y }, to: { x: outlet.x, y: outlet.y } };
}
export function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

// 锥形光域多边形（apex 为灯位）
export function conePolygon(light, spec) {
  const half = (spec.cone / 2) * Math.PI / 180;
  const base = light.angle * Math.PI / 180;
  const steps = 14;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = base - half + (2 * half * i) / steps;
    pts.push({ x: light.x + Math.cos(a) * spec.reach, y: light.y + Math.sin(a) * spec.reach });
  }
  return [{ x: light.x, y: light.y }, ...pts];
}

// 点是否被灯锥覆盖
export function pointInCone(light, spec, px, py) {
  const d = dist(light.x, light.y, px, py);
  if (d > spec.reach || d < 0.05) return false;
  let diff = Math.atan2(py - light.y, px - light.x) * 180 / Math.PI - light.angle;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  return Math.abs(diff) <= spec.cone / 2;
}

// 栅格 BFS：从门口走到拍摄区。返回 { found, path, blockers }。
// cell=0.1m。障碍矩形直接栅格化（O(格数)），对 10x8m 房间足够快。
export function findEntrancePath(plan, cell = 0.1) {
  const { w: W, h: H } = plan.room;
  const cols = Math.round(W / cell), rows = Math.round(H / cell);
  const blocked = new Uint8Array(cols * rows);

  const obstacles = collectObstacles(plan, { pad: 0.12 });
  for (const ob of obstacles) {
    const r = ob.rect;
    const x0 = Math.max(0, Math.floor((r.x - r.w / 2) / cell));
    const x1 = Math.min(cols - 1, Math.floor((r.x + r.w / 2) / cell));
    const y0 = Math.max(0, Math.floor((r.y - r.h / 2) / cell));
    const y1 = Math.min(rows - 1, Math.floor((r.y + r.h / 2) / cell));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) blocked[y * cols + x] = 1;
  }

  const area = plan.area;
  // 目标：拍摄区内沿格子
  const ax0 = Math.max(0, Math.ceil((area.x - area.w / 2 + 0.05) / cell));
  const ax1 = Math.min(cols - 1, Math.floor((area.x + area.w / 2 - 0.05) / cell));
  const ay0 = Math.max(0, Math.ceil((area.y - area.h / 2 + 0.05) / cell));
  const ay1 = Math.min(rows - 1, Math.floor((area.y + area.h / 2 - 0.05) / cell));

  const door = plan.room.door;
  // 起点：门洞内 0.25m
  const sx = clamp(0.25 / cell, 0, cols - 1) | 0;
  const sy = clamp((door.y + door.w / 2) / cell, 0, rows - 1) | 0;

  if (blocked[sy * cols + sx]) {
    // 门口被堵：找门洞内最近的空格
    let start = -1;
    const dy0 = Math.max(0, Math.floor(door.y / cell)), dy1 = Math.min(rows - 1, Math.floor((door.y + door.w) / cell));
    for (let y = dy0; y <= dy1 && start < 0; y++)
      for (let x = 0; x < Math.min(cols, 4); x++)
        if (!blocked[y * cols + x]) { start = y * cols + x; break; }
    if (start < 0) return { found: false, path: null, reason: 'door-blocked' };
    return bfs(blocked, cols, rows, start, ax0, ax1, ay0, ay1, cell);
  }
  return bfs(blocked, cols, rows, sy * cols + sx, ax0, ax1, ay0, ay1, cell);
}

function bfs(blocked, cols, rows, start, ax0, ax1, ay0, ay1, cell) {
  const total = cols * rows;
  const prev = new Int32Array(total).fill(-1);
  const seen = new Uint8Array(total);
  const q = new Int32Array(total);
  let qh = 0, qt = 0;
  q[qt++] = start; seen[start] = 1;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  let goal = -1;
  while (qh < qt) {
    const cur = q[qh++];
    const cx = cur % cols, cy = (cur / cols) | 0;
    if (cx >= ax0 && cx <= ax1 && cy >= ay0 && cy <= ay1) { goal = cur; break; }
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const ni = ny * cols + nx;
      if (seen[ni] || blocked[ni]) continue;
      if (dx !== 0 && dy !== 0 && (blocked[cy * cols + nx] || blocked[ny * cols + cx])) continue;
      seen[ni] = 1; prev[ni] = cur; q[qt++] = ni;
    }
  }
  if (goal < 0) return { found: false, path: null, reason: 'no-route' };
  const path = [];
  let n = goal;
  while (n !== -1) {
    path.push({ x: (n % cols) * cell, y: (((n / cols) | 0)) * cell });
    if (n === start) break;
    n = prev[n];
  }
  path.reverse();
  return { found: true, path, reason: null };
}
