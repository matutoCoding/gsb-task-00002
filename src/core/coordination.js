// 主灯联动：主灯调整后，给出补光/轮廓光/人物/走线的“建议”，不自动改动。
// 建议带状态：suggested(待处理) / applied(已照做) / dismissed(暂时绕开)
import { keyLight } from './validation.js';
import { LIGHT_TYPES } from './model.js';
import { dist } from './geometry.js';

const MOVE_TOL = 0.25; // 米
const ANGLE_TOL = 12;  // 度

export function keyBaseline(plan) {
  const key = keyLight(plan);
  if (!key) return null;
  return { x: key.x, y: key.y, angle: key.angle };
}

function norm(a) {
  while (a > 180) a -= 360;
  while (a < -180) a += 360;
  return a;
}

// 计算建议，返回数组
export function coordinationSuggestions(plan, baseline) {
  const key = keyLight(plan);
  if (!key || !baseline) return [];
  const moved = dist(key.x, key.y, baseline.x, baseline.y) > 0.05 || Math.abs(norm(key.angle - baseline.angle)) > 1;
  if (!moved) return [];

  const out = [];
  const sub = plan.subject;

  // 期望主灯照向人物的角度
  const aimAngle = (Math.atan2(sub.y - key.y, sub.x - key.x) * 180) / Math.PI;

  const lights = plan.objects.filter((o) => o.kind === 'light');
  for (const l of lights) {
    if (l.id === key.id) continue;
    if (l.type === 'fill') {
      const ang = aimAngle + 35; // 主灯对侧补光
      const rad = (ang * Math.PI) / 180;
      const sx = sub.x - Math.cos(rad) * 2.6, sy = sub.y - Math.sin(rad) * 2.6;
      out.push(rec('fill', l, sx, sy, norm(aimAngle - 180 + 35),
        `${l.name}：主灯已移动，建议把补光挪到人物另一侧约 45°，并转向人物，避免一边死黑。`));
    } else if (l.type === 'rim') {
      const ang = aimAngle - 170;
      const rad = (ang * Math.PI) / 180;
      const sx = sub.x - Math.cos(rad) * 1.8, sy = sub.y - Math.sin(rad) * 1.8;
      out.push(rec('rim', l, sx, sy, norm(aimAngle + 10),
        `${l.name}：建议放到人物身后侧后方，并保持逆着主灯方向打轮廓。`));
    }
  }

  // 人物：主灯已经不照人物时，建议转站位
  const keySpec = LIGHT_TYPES[key.type] || LIGHT_TYPES.other;
  const d = dist(key.x, key.y, sub.x, sub.y);
  let diff = (Math.atan2(sub.y - key.y, sub.x - key.x) * 180) / Math.PI - key.angle;
  diff = norm(diff);
  if (Math.abs(diff) > keySpec.cone / 2 || d > keySpec.reach) {
    out.push({
      key: 'coord:subject', kind: 'subject', entityId: 'subject',
      x: key.x, y: key.y,
      angle: norm((Math.atan2(key.y - sub.y, key.x - sub.x) * 180) / Math.PI),
      msg: '人物站位：主灯方向变了，人物应转向/微移到新的主光锥内，否则主光打空。',
    });
  }

  // 走线：主灯挪远后检查自己的线
  const oc = plan.objects.find((o) => o.kind === 'outlet' && o.id === key.outletId);
  if (oc && dist(key.x, key.y, oc.x, oc.y) > key.cableLength) {
    out.push({
      key: 'coord:cable', kind: 'cable', entityId: key.id, x: null, y: null, angle: null,
      msg: `走线：主灯离 ${oc.name} 已 ${dist(key.x, key.y, oc.x, oc.y).toFixed(1)} m，原线不够，需要换插座或加延长线。`,
    });
  }

  return out;
}

function rec(kind, light, x, y, angle, msg) {
  return { key: `coord:${kind}:${light.id}`, kind, entityId: light.id,
    x: round(x), y: round(y), angle: round(angle), msg };
}
function round(v) { return Math.round(v * 10) / 10; }

// 判断某条建议用户是否已经“照做”（目标对象已接近建议值）
export function suggestionState(suggestion, plan) {
  if (suggestion.kind === 'cable') {
    const key = keyLight(plan);
    const oc = plan.objects.find((o) => o.kind === 'outlet' && o.id === key.outletId);
    return oc && dist(key.x, key.y, oc.x, oc.y) <= key.cableLength ? 'applied' : 'suggested';
  }
  const ent = suggestion.entityId === 'subject'
    ? plan.subject
    : plan.objects.find((o) => o.id === suggestion.entityId);
  if (!ent) return 'dismissed';
  if (suggestion.kind === 'subject') {
    return Math.abs(norm((ent.angle || 0) - suggestion.angle)) <= ANGLE_TOL ||
           dist(ent.x, ent.y, suggestion.x, suggestion.y) <= MOVE_TOL
      ? 'applied' : 'suggested';
  }
  const posOk = dist(ent.x, ent.y, suggestion.x, suggestion.y) <= MOVE_TOL;
  const angOk = Math.abs(norm((ent.angle || 0) - suggestion.angle)) <= ANGLE_TOL;
  return posOk && angOk ? 'applied' : 'suggested';
}
