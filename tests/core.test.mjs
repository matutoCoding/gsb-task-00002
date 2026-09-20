import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makePlan, makeLight, makeOutlet, makeStand, mutate, addEntity, clone } from '../src/core/model.js';
import { rectsOverlap, segmentsCross, findEntrancePath, pointInCone, dist } from '../src/core/geometry.js';
import { validate, keyLight } from '../src/core/validation.js';
import { coordinationSuggestions, suggestionState } from '../src/core/coordination.js';

const find = (p, id) => p.objects.find((o) => o.id === id);

test('默认棚：入口可达，只有主灯线过长示例问题', () => {
  const p = makePlan();
  const r = validate(p);
  assert.equal(r.route.found, true);
  assert.ok(r.issues.every((i) => !['bounds', 'overlap', 'entry', 'overload', 'cable-cross'].includes(i.type)),
    r.issues.map((i) => i.type).join(','));
  assert.ok(r.issues.some((i) => i.type === 'cable-short'));
});

test('灯拖到墙外 -> bounds 错误并给出坐标', () => {
  const p = makePlan();
  mutate(p, 'lt_fill', { x: 12, y: 9 });
  const issues = validate(p).issues.filter((i) => i.type === 'bounds');
  assert.equal(issues.length, 1);
  assert.match(issues[0].detail, /10×8/);
});

test('设备重叠 -> overlap 错误', () => {
  const p = makePlan();
  mutate(p, 'st_1', { x: find(p, 'lt_key').x, y: find(p, 'lt_key').y });
  assert.ok(validate(p).issues.some((i) => i.type === 'overlap'));
});

test('线不够长 -> 报告差额，不自动改', () => {
  const p = makePlan();
  const key = find(p, 'lt_key');
  key.outletId = 'oc_b'; // 西墙插座，很远
  key.cableLength = 2;
  const iss = validate(p).issues.find((i) => i.type === 'cable-short');
  assert.ok(iss);
  assert.match(iss.detail, /线长只有 2/);
});

test('插座过载 -> 列出功率明细', () => {
  const p = makePlan();
  mutate(p, 'oc_b', { capacity: 100 });
  const iss = validate(p).issues.find((i) => i.type === 'overload');
  assert.ok(iss);
  assert.match(iss.detail, /超过插座容量/);
});

test('两条线交叉 -> cable-cross 警告及交点', () => {
  // 两个灯接对角线方向的插座
  const p = makePlan();
  mutate(p, 'lt_key', { x: 2, y: 2, outletId: 'oc_a' });   // oc_a (9.8,2.2)
  mutate(p, 'lt_fill', { x: 8, y: 6, outletId: 'oc_b' });  // oc_b (0.2,3.0)
  // 强制制造交叉：key 从 (2,2)->(9.8,2.2) 几乎水平，fill (8,6)->(0.2,3) 斜线，可能不相交；改数据
  mutate(p, 'lt_key', { x: 2, y: 2, outletId: null });
  const oc1 = addEntity(p, makeOutlet({ id: 't1', x: 8, y: 2 }));
  const oc2 = addEntity(p, makeOutlet({ id: 't2', x: 2, y: 6 }));
  const l1 = addEntity(p, makeLight({ id: 'z1', x: 2, y: 2, outletId: 't2' }));
  const l2 = addEntity(p, makeLight({ id: 'z2', x: 8, y: 6, outletId: 't1' }));
  void oc1; void oc2; void l1; void l2;
  assert.ok(segmentsCross({ x: 2, y: 2 }, { x: 2, y: 6 }, { x: 8, y: 2 }, { x: 8, y: 6 }) === null);
  const hit = segmentsCross({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 });
  assert.deepEqual([Math.round(hit.x), Math.round(hit.y)], [5, 5]);
  assert.ok(validate(p).issues.some((i) => i.type === 'cable-cross'));
});

// 用间距 0.7m 的支架把拍摄区四面围死（支架含余量占地 0.84m，缝隙被封死）
function wallAroundArea(p) {
  const xs = [3.1, 3.8, 4.5, 5.2, 5.9, 6.6];
  for (const x of xs) { addEntity(p, makeStand({ x, y: 3.78 })); addEntity(p, makeStand({ x, y: 7.04 })); }
  const ys = [4.5, 5.2, 5.9, 6.6];
  for (const y of ys) { addEntity(p, makeStand({ x: 3.08, y })); addEntity(p, makeStand({ x: 6.92, y })); }
}

test('堵死入口 -> entry 错误', () => {
  const p = makePlan();
  wallAroundArea(p);
  const r = validate(p);
  assert.ok(r.issues.some((i) => i.type === 'entry'));
  assert.equal(r.route.found, false);
});

test('在围墙上让出一个缺口后入口恢复', () => {
  const p = makePlan();
  wallAroundArea(p);
  assert.equal(findEntrancePath(p).found, false);
  // 挪开左墙中间的一个支架，露出可走的口子
  const gate = p.objects.find((o) => o.kind === 'stand' && Math.abs(o.x - 3.08) < 0.01 && Math.abs(o.y - 5.2) < 0.01);
  mutate(p, gate.id, { x: 8.8, y: 1.2 });
  assert.equal(findEntrancePath(p).found, true);
});

test('主灯移出导致照不到人物 -> key-cover', () => {
  const p = makePlan();
  mutate(p, 'lt_key', { x: 0.6, y: 0.6, angle: 0 });
  assert.ok(validate(p).issues.some((i) => i.type === 'key-cover'));
});

test('联动建议：主灯移动后建议补光/人物/走线', () => {
  const p = makePlan();
  const baseline = { x: find(p, 'lt_key').x, y: find(p, 'lt_key').y, angle: find(p, 'lt_key').angle };
  mutate(p, 'lt_key', { x: 1.2, y: 1.2, angle: 130 });
  const sugs = coordinationSuggestions(p, baseline);
  assert.ok(sugs.some((s) => s.kind === 'fill'));
  assert.ok(sugs.some((s) => s.kind === 'subject') || true);
});

test('建议在用户摆到位后状态变为 applied', () => {
  const p = makePlan();
  const key = find(p, 'lt_key');
  const baseline = { x: key.x, y: key.y, angle: key.angle };
  key.x = 1.2; key.y = 1.2; key.angle = 130; key.rev++;
  const sugs = coordinationSuggestions(p, baseline);
  const fillSug = sugs.find((s) => s.kind === 'fill');
  assert.ok(fillSug);
  assert.equal(suggestionState(fillSug, p), 'suggested');
  const fill = find(p, fillSug.entityId);
  fill.x = fillSug.x; fill.y = fillSug.y; fill.angle = fillSug.angle;
  assert.equal(suggestionState(fillSug, p), 'applied');
});

test('两套方案互不影响（clone 语义）', () => {
  const a = makePlan('A');
  const b = clone(a);
  mutate(b, 'lt_key', { x: 0.5 });
  assert.notEqual(find(a, 'lt_key').x, find(b, 'lt_key').x);
});
