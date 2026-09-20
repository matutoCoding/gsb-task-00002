// CDP 冒烟：headless chrome 加载页面 -> 真实鼠标拖动主灯 -> 校验/持久化/方案切换/刷新恢复。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import os from 'node:os';

const PORT = 9330;
const URL = 'http://127.0.0.1:8741/index.html';
const userDir = os.tmpdir() + '/cdp-smoke-' + Date.now();
const chrome = spawn('google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--no-proxy-server', '--no-sandbox', 'about:blank',
], { stdio: 'ignore' });

async function waitForTarget(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error('chrome target not ready');
}

let msgId = 0;
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  ws.addEventListener('open', () => {});
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  };
  const ready = new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, send, ready };
}

const results = [];
function check(name, cond, extra = '') { results.push({ name, ok: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`); }

async function evalIn(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function dragBy(cdp, x0, y0, dx, dy, steps = 8) {
  const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  await mouse('mousePressed', x0, y0);
  for (let i = 1; i <= steps; i++) await mouse('mouseMoved', x0 + (dx * i) / steps, y0 + (dy * i) / steps);
  await mouse('mouseReleased', x0 + dx, y0 + dy);
}

async function main() {
  const target = await waitForTarget();
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const errors = [];
  cdp.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error');
  });

  await cdp.send('Page.navigate', { url: URL });
  await sleep(1200);

  const state0 = await evalIn(cdp, `(() => ({
    lights: document.querySelectorAll('[data-id^="lt_"]').length,
    issues: document.querySelectorAll('#issue-list .issue').length,
    planTabs: document.querySelectorAll('.plan-tab').length,
    circles: document.querySelectorAll('#stage circle').length,
  }))()`);
  check('初始渲染', state0.lights >= 3 && state0.issues >= 1 && state0.planTabs === 1, JSON.stringify(state0));

  // 主灯屏幕中心（取灯本体圆，避开文字标签）
  const pos = await evalIn(cdp, `(() => {
    const grp = document.querySelector('.l-ent [data-id="lt_key"]');
    const circle = grp.querySelector('circle');
    const r = circle.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await dragBy(cdp, pos.x, pos.y, 90, -50);
  await sleep(500);

  const drag = await evalIn(cdp, `(() => {
    const k = JSON.parse(localStorage.getItem('gsb.studio.doc.v1')).plans[0].objects.find(o => o.id === 'lt_key');
    return { x: k.x, y: k.y, rev: k.rev };
  })()`);
  check('拖动主灯后位置/版本变化并持久化', drag.rev >= 2 && (drag.x !== 3.2 || drag.y !== 4.2), JSON.stringify(drag));

  // 第二套方案
  await evalIn(cdp, `document.querySelector('#btn-add-plan').click()`);
  await sleep(300);
  const tabs2 = await evalIn(cdp, `document.querySelectorAll('.plan-tab').length`);
  check('新增第二套方案', tabs2 === 2, 'tabs=' + tabs2);

  const persist = await evalIn(cdp, `(async () => {
    document.querySelectorAll('.plan-tab')[0].click();
    await new Promise(r => setTimeout(r, 250));
    const doc = JSON.parse(localStorage.getItem('gsb.studio.doc.v1'));
    const ui = JSON.parse(localStorage.getItem('gsb.studio.ui.v1'));
    const k = doc.plans[0].objects.find(o => o.id === 'lt_key');
    return { x: k.x, onFirst: ui.currentPlanId === doc.plans[0].id };
  })()`);
  check('切走再切回，方案一改动保留', persist.onFirst && (persist.x !== 3.2), JSON.stringify(persist));

  // 刷新恢复
  await cdp.send('Page.reload');
  await sleep(1200);
  const reloaded = await evalIn(cdp, `(() => {
    const doc = JSON.parse(localStorage.getItem('gsb.studio.doc.v1'));
    const ui = JSON.parse(localStorage.getItem('gsb.studio.ui.v1'));
    return { idx: doc.plans.findIndex(p => p.id === ui.currentPlanId), tabs: document.querySelectorAll('.plan-tab').length };
  })()`);
  check('刷新后回到刚才那套方案', reloaded.idx === 0 && reloaded.tabs === 2, JSON.stringify(reloaded));

  // 暂时绕开
  const waive = await evalIn(cdp, `(async () => {
    const btns = [...document.querySelectorAll('#issue-list .issue button')];
    const b = btns.find(x => x.textContent.trim() === '暂时绕开');
    if (!b) return 'NO_BTN:' + btns.map(x => x.textContent).join('|');
    b.click();
    await new Promise(r => setTimeout(r, 300));
    return document.querySelector('#summary .n-waive').textContent;
  })()`);
  check('暂时绕开计入统计', waive === '1', String(waive));

  // 联动建议：大幅移动主灯后应出现建议
  const sug = await evalIn(cdp, `(async () => {
    const grp = document.querySelector('.l-ent [data-id="lt_key"]');
    const r = grp.querySelector('circle').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await dragBy(cdp, sug.x, sug.y, -120, 80);
  await sleep(500);
  const sugCount = await evalIn(cdp, `(async () => {
    document.querySelector('.itab[data-itab="suggest"]').click();
    await new Promise(r => setTimeout(r, 300));
    return document.querySelectorAll('#issue-list .issue').length;
  })()`);
  check('主灯大改动后出现联动建议', sugCount >= 1, 'suggestions=' + sugCount);

  check('运行期无 JS 异常', errors.length === 0, errors.slice(0, 2).join(' || '));

  cdp.ws.close();
  chrome.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error('SMOKE ERROR', e); chrome.kill(); process.exit(2); });
