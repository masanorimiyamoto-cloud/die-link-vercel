// 依存パッケージなしのローカル画面確認。先に process-mock-server.mjs を起動する。
// node tools/order-entry-browser-smoke.cjs http://127.0.0.1:8791
// 専用の一時プロファイルを使う。通常のブラウザや本番APIには接続しない。
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const pause = ms => new Promise(r => setTimeout(r, ms));
const origin = process.argv[2] || 'http://127.0.0.1:8791';
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'order-entry-smoke-'));
  await fetch(origin + '/__mock', { method: 'POST', body: JSON.stringify({ reset: true }) });
  const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const child = spawn(chrome, ['--headless', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + path.join(dir, 'profile'), 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let socket, closeBrowser;
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      try { port = Number((await fs.readFile(path.join(dir, 'profile', 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { await pause(100); }
    }
    assert.ok(port, 'Headless Chrome started');
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = tabs.find(t => t.type === 'page'); assert.ok(target);
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let seq = 0; const pending = new Map(), pageErrors = [];
    socket.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(msg.params.exceptionDetails);
      if (!msg.id) return;
      const task = pending.get(msg.id); if (!task) return; pending.delete(msg.id); clearTimeout(task.timer);
      if (msg.error) task.reject(new Error(JSON.stringify(msg.error))); else task.resolve(msg.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
    closeBrowser = () => send('Browser.close').catch(() => {});
    const evaluate = async expression => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    const waitFor = async expression => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await pause(100); }
      await fs.writeFile(path.join(dir, 'failure.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      throw new Error('Condition timed out: ' + expression + '\n' + JSON.stringify({ errors: pageErrors, text: await evaluate('document.body.innerText') }));
    };
    await send('Page.enable'); await send('Network.enable'); await send('Runtime.enable');
    await send('Network.setBlockedURLs', { urls: ['https://cdn.jsdelivr.net/*'] });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.confirm = () => true;' });
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send('Page.navigate', { url: origin + '/process.html?mode=new' });
    await waitFor("document.querySelectorAll('#entryRecent .choice').length > 0");
    const layout = await evaluate("({width:innerWidth, viewport:document.documentElement.clientWidth, content:document.documentElement.scrollWidth, tabs:[...document.querySelectorAll('.tabs button')].map(b=>({text:b.textContent,right:b.getBoundingClientRect().right}))})");
    assert.ok(layout.content <= layout.viewport + 1, JSON.stringify(layout));
    assert.ok(layout.tabs.every(t => t.right <= 391), JSON.stringify(layout));
    await fs.writeFile(path.join(dir, 'recent-mobile.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await evaluate("document.querySelector('#entryRecent .choice').click()");
    await waitFor("!document.getElementById('entryForm').hidden && document.querySelector('#entryForm input[aria-label=数量]')");
    assert.equal(await evaluate("document.getElementById('stepCard').hidden"), true);
    await fs.writeFile(path.join(dir, 'form-mobile.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await evaluate("document.querySelector('#entryForm input[aria-label=数量]').value='1234'; document.querySelector('#entryForm input[type=date]').value=new Date(Date.now()+9*3600000+7*86400000).toISOString().slice(0,10); [...document.querySelectorAll('#entryForm button')].find(b=>b.textContent==='登録する').click()");
    await waitFor("document.getElementById('entryMsg').textContent.includes('新規受注を作りました')");
    const writes = await (await fetch(origin + '/__mock/log')).json();
    assert.equal(writes.filter(x => x.action === 'neworder').length, 1);
    await evaluate("document.getElementById('entryQuery').value='テスト商事'; document.getElementById('entrySearch').click()");
    await waitFor("document.querySelectorAll('#entryResults .choice').length > 0");
    assert.ok(await evaluate("[...document.querySelectorAll('#entryResults .choice')].every(b=>b.textContent.includes('テスト商事'))"));
    await evaluate("document.getElementById('tabList').click()");
    await waitFor("!document.getElementById('listCard').hidden && document.querySelectorAll('#viewChips button').length > 0");
    await evaluate("[...document.querySelectorAll('#viewChips button')].find(b=>b.textContent.startsWith('全件')).click()");
    await waitFor("!document.getElementById('listCard').hidden && document.querySelectorAll('#list .order').length > 0");
    assert.deepEqual(pageErrors, []);
    console.log('PASS mobile layout, recent selection, registration, customer search, existing work list');
    console.log('Screenshots: ' + dir);
  } finally {
    if (closeBrowser) await closeBrowser();
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    child.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
