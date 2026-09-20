// 场景 A：两个标签页同时改同一盏灯 -> 冲突弹窗，不被静默覆盖
// 场景 B：60 个设备时单次校验耗时与拖动响应
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import os from 'node:os';

const PORT = 9331;
const userDir = os.tmpdir() + '/cdp-smoke2-' + Date.now();
const chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDir}`, '--no-first-run', '--no-proxy-server', '--no-sandbox', 'about:blank'], { stdio: 'ignore' });

async function targets() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); const l = await r.json(); if (l.find((t) => t.type === 'page')) return l; } catch {}
    await sleep(200);
  }
  throw new Error('no chrome');
}
let mid = 0;
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl); const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const ready = new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((res) => { const id = ++mid; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  return { ws, send, ready };
}
async function ev(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
const results = [];
const check = (n, c, x = '') => { results.push(c); console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${x}`); };

const list = await targets();
const cdp1 = connect(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await cdp1.ready; await cdp1.send('Runtime.enable'); await cdp1.send('Page.enable');
await cdp1.send('Page.navigate', { url: 'http://127.0.0.1:8741/index.html' });
await sleep(1000);

// 标签 2：通过 CDP 新建目标
const t2 = await cdp1.send('Target.createTarget', { url: 'about:blank' });
const all = await targets();
const page2 = all.find((t) => t.id === t2.targetId) || all.filter((t) => t.type === 'page')[1];
const cdp2 = connect(page2.webSocketDebuggerUrl);
await cdp2.ready; await cdp2.send('Runtime.enable'); await cdp2.send('Page.enable');
await cdp2.send('Page.navigate', { url: 'http://127.0.0.1:8741/index.html' });
await sleep(1000);

// 两边在看到彼此改动之前，各自本地改同一盏灯 -> 首次同步即冲突
// 做法：先断开两页对 sync 消息的响应（用标志位拦截），各自改完后再放开。
await ev(cdp1, `(() => {
  const { store } = window.__studio;
  store.commit((p) => { const k = p.objects.find(o=>o.id==='lt_key'); k.x = 2.0; k.y = 2.0; }, { reason:'t1' });
})()`);
// 标签1 已广播；让标签2的 store 暂时忽略入站消息，模拟“先各自改动”
await ev(cdp2, `(() => {
  const { store } = window.__studio;
  store.__muted = true;
  const orig = store._mergeRemotePlan.bind(store);
  store._mergeRemotePlan = (...args) => { if (store.__muted) return; orig(...args); };
})()`);
await ev(cdp1, `(() => {
  const { store } = window.__studio;
  store.commit((p) => { const k = p.objects.find(o=>o.id==='lt_key'); k.x = 2.0; k.y = 2.0; }, { reason:'t1-again' });
})()`);
await ev(cdp2, `(() => {
  const { store } = window.__studio;
  // 基于初始共同状态（未收到 t1）改同一盏灯
  store.commit((p) => { const k = p.objects.find(o=>o.id==='lt_key'); k.x = 7.0; k.y = 7.0; }, { reason:'t2' });
})()`);
await sleep(200);
const t1Pos = await ev(cdp1, `window.__studio.store.currentPlan().objects.find(o=>o.id==='lt_key').x`);
check('标签1本地改动为 2', t1Pos === 2, 't1x=' + t1Pos);
const c2Before = await ev(cdp2, `window.__studio.store.currentPlan().objects.find(o=>o.id==='lt_key').x`);
check('标签2在同步前保留自己的 7', c2Before === 7, 'c2x=' + c2Before);
// 放开标签2：补一条 t1 的编辑消息触发合并
await ev(cdp2, `(async () => {
  const { store } = window.__studio;
  store.__muted = false;
  const planA = JSON.parse(localStorage.getItem('gsb.studio.doc.v1')).plans.find(p=>p.objects.some(o=>o.id==='lt_key'));
  // 从标签1频道重放其“基于初始 rev=1 的改动”
  const ch = new BroadcastChannel('gsb-studio-sync');
  ch.postMessage({ type:'edit', tab:'replay-t1', planId: planA.id, plan: planA, baseRevs: { lt_key: 1 } });
  await new Promise(r=>setTimeout(r,300)); ch.close();
})()`);
await sleep(400);
const modalShown = await ev(cdp2, `!document.querySelector('#conflict-modal').classList.contains('hidden')`);
check('两边同改一盏灯 -> 弹出冲突选择（不静默覆盖）', modalShown);
await ev(cdp2, `document.querySelector('#conflict-use-theirs').click()`);
await sleep(300);
const resolved = await ev(cdp2, `({
  x: window.__studio.store.currentPlan().objects.find(o=>o.id==='lt_key').x,
  modalHidden: document.querySelector('#conflict-modal').classList.contains('hidden'),
})`);
check('选择“采用对方版本”后 x=2 且弹窗关闭', resolved.modalHidden && resolved.x === 2, JSON.stringify(resolved));

// ---- 性能：60 个灯/支架（走页面内存态，避免被覆盖）----
await ev(cdp1, `(() => {
  const { store } = window.__studio;
  store.commit((p) => {
    for (let i=0;i<60;i++) {
      p.objects.push({ id:'bulk_'+i, kind: i%2?'stand':'light', name:'设备'+i,
        x: 0.5 + (i%10)*0.92, y: 0.5 + Math.floor(i/10)*0.72, size:0.55,
        angle: 90, cableLength: 5, outletId: null, rev: 1,
        ...(i%2?{}:{type:'other'}) });
    }
  }, { reason:'bulk' });
})()`);
await sleep(800);
const perfRes = await ev(cdp1, `(async () => {
  const ents = document.querySelectorAll('.l-ent [data-id]').length;
  const svg = document.querySelector('#stage');
  const g = document.querySelector('.l-ent [data-id="bulk_59"] circle') || document.querySelector('.l-ent [data-id="lt_rim"] circle');
  const b = g.getBoundingClientRect();
  const m = (type,x,y,buttons) => svg.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,pointerId:2,button:0,buttons}));
  const d0 = performance.now();
  m('pointerdown', b.left+b.width/2, b.top+b.height/2, 1);
  for(let i=0;i<10;i++) m('pointermove', b.left+b.width/2+i*3, b.top+b.height/2+i*2, 1);
  m('pointerup', b.left+30, b.top+20, 0);
  const moveMs = performance.now() - d0;
  // 等待一次完整校验（BFS+全量渲染）完成
  await new Promise(r=>setTimeout(r,700));
  return { ents, moveMs: Math.round(moveMs) };
})()`);
check('60+ 设备仍能渲染', perfRes.ents >= 60, JSON.stringify(perfRes));
check('10 次移动事件处理 < 100ms（拖动不卡死）', perfRes.moveMs < 100, perfRes.moveMs + 'ms');

cdp1.ws.close(); cdp2.ws.close(); chrome.kill();
const fails = results.filter((r) => !r).length;
console.log(`\\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
