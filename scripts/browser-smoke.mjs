import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Dependency-free browser smoke test. Launch Chrome with --remote-debugging-port=9222
// and run the app at http://localhost:3000 before invoking this script.
const root = fileURLToPath(new URL('../', import.meta.url));
const origin = process.env.APP_URL || 'http://localhost:3000';
const debuggerOrigin = process.env.CHROME_DEBUG_URL || 'http://127.0.0.1:9222';
const screenshotDirectory = path.join(root, '.local', 'screenshots');
const tab = await fetch(`${debuggerOrigin}/json/new?${encodeURIComponent(origin)}`, { method: 'PUT' }).then(response => {
  if (!response.ok) throw new Error(`Could not create a Chrome tab (${response.status}).`);
  return response.json();
});
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
const pending = new Map();
const runtimeErrors = [];
let nextId = 0;
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const promise = pending.get(message.id);
    if (promise) {
      pending.delete(message.id);
      clearTimeout(promise.timeout);
      if (message.error) promise.reject(new Error(message.error.message));
      else promise.resolve(message.result);
    }
  } else if (message.method === 'Runtime.exceptionThrown') {
    runtimeErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  }
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out.`)); }, 15000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function waitFor(expression, description, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}
async function screenshot(name) {
  await evaluate('document.activeElement?.blur(); document.querySelector("#toast")?.classList.remove("visible")');
  await mkdir(screenshotDirectory, { recursive: true });
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path.join(screenshotDirectory, `${name}.png`), Buffer.from(data, 'base64'));
}
async function fill(selector, value) {
  await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true})); })()`);
}
async function click(selector) {
  await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Missing element: ' + ${JSON.stringify(selector)}); element.click(); })()`);
}
async function login(company) {
  await waitFor('!!document.querySelector("#login-form")', 'login form');
  await fill('#email', `${company.toLowerCase()}@leadinbox.demo`);
  await fill('#password', 'LeadInbox2026!');
  await click('#login-submit');
  await waitFor('!!document.querySelector("#lead-results .lead-row") && !document.querySelector(".loading-bar")', `Company ${company} inbox`);
  const companyName = await evaluate('document.querySelector(".workspace-switch strong").textContent');
  assert.equal(companyName, `Company ${company}`);
  assert.equal(await evaluate('Number(document.querySelector(".heading-count").textContent)'), 20);
}

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Network.clearBrowserCookies');
  await send('Page.navigate', { url: origin });
  await waitFor('!!document.querySelector("#login-form")', 'login form');
  await screenshot('01-login-desktop');
  await login('A');
  const firstName = await evaluate('document.querySelector(".lead-row .person-name").textContent');
  const companyALeadId = await evaluate('document.querySelector(".lead-row").dataset.id');
  await screenshot('02-inbox-desktop');
  await fill('#lead-search', firstName);
  assert.equal(await evaluate('document.querySelectorAll(".lead-row").length'), 1);
  await fill('#lead-search', 'no lead has this exact name');
  assert.equal(await evaluate('document.querySelectorAll(".lead-row").length'), 0);
  assert.ok(await evaluate('document.querySelector("#lead-results").textContent.includes("No leads match")'));
  await click('[data-action="clear-filters"]');
  await fill('#status-filter', 'no_show');
  assert.ok(await evaluate('document.querySelectorAll(".lead-row").length > 0'));
  assert.ok(await evaluate('[...document.querySelectorAll(".lead-row .status")].every(element => element.textContent === "No-show")'));
  await fill('#status-filter', '');
  const closer = await evaluate('document.querySelector("#closer-filter option:nth-child(2)").value');
  await fill('#closer-filter', closer);
  assert.ok(await evaluate('document.querySelectorAll(".lead-row").length > 0'));
  await click('.lead-row [data-action="lead-detail"]');
  assert.ok(await evaluate('document.querySelector("#lead-dialog").open'));
  assert.ok(await evaluate('document.querySelector("#lead-title").textContent.length > 0'));
  await screenshot('03-lead-details');
  await click('#lead-dialog [data-action="close-dialog"]');
  await fill('#closer-filter', '');
  await click('[data-action="navigate"][data-page="stats"]');
  assert.ok(await evaluate('document.querySelectorAll(".performance-table tbody tr").length >= 2'));
  assert.ok(await evaluate('document.querySelector(".formula-note").textContent.includes("Show rate = showed")'));
  await screenshot('04-team-performance');
  await click('[data-action="navigate"][data-page="followups"]');
  assert.ok(await evaluate('document.querySelectorAll(".followup-card").length > 0'));
  await screenshot('05-followups');
  await click('[data-action="navigate"][data-page="leads"]');
  await click('[data-action="open-import"]');
  const documentNode = await send('DOM.getDocument');
  const leadNode = await send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#leads-file' });
  const bookingNode = await send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#bookings-file' });
  await send('DOM.setFileInputFiles', { nodeId: leadNode.nodeId, files: [path.join(root, 'data', 'leads.json')] });
  await send('DOM.setFileInputFiles', { nodeId: bookingNode.nodeId, files: [path.join(root, 'data', 'bookings.json')] });
  await click('#import-submit');
  await waitFor('!!document.querySelector(".import-result") && !document.querySelector(".loading-bar")', 'repeat import success');
  assert.ok(await evaluate('document.querySelector(".import-result").textContent.includes("0 leads imported")'));
  assert.ok(await evaluate('document.querySelector(".import-result").textContent.includes("0 events imported")'));
  await screenshot('06-repeat-import');
  await click('#import-dialog [data-action="close-dialog"]');
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 900, deviceScaleFactor: 1, mobile: true });
  assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), '360px inbox has horizontal overflow');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".lead-cards")).display'), 'block');
  await screenshot('07-inbox-mobile-360');
  await click('[data-action="navigate"][data-page="stats"]');
  assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), '360px stats has horizontal overflow');
  await screenshot('08-stats-mobile-360');
  await click('[data-action="navigate"][data-page="followups"]');
  assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), '360px follow-ups has horizontal overflow');
  await screenshot('09-followups-mobile-360');
  await click('.mobile-topbar [data-action="logout"]');
  await login('B');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), '390px inbox has horizontal overflow');
  // The fixtures intentionally contain one person in both companies. Identity and
  // contacts may overlap; company-scoped lead IDs must never cross the boundary.
  const companyBIds = await evaluate('[...document.querySelectorAll(".lead-row")].map(element => element.dataset.id)');
  assert.ok(!companyBIds.includes(companyALeadId), 'Company A lead ID appears in Company B inbox');
  assert.ok(companyBIds.every(id => id.startsWith('B-')), 'Company B contains an unexpected tenant lead ID');
  await screenshot('10-company-b-mobile-390');
  await click('.mobile-topbar [data-action="logout"]');
  assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), '390px login has horizontal overflow');
  await screenshot('11-login-mobile-390');
  assert.deepEqual(runtimeErrors, [], 'Browser runtime exceptions detected');
  console.log(`Browser smoke passed: login A/B, company separation, search, filters, details, stats, follow-ups, idempotent import, logout, and mobile overflow. Screenshots: ${screenshotDirectory}`);
} finally {
  const closed = new Promise(resolve => {
    if (socket.readyState === WebSocket.CLOSED) resolve();
    else socket.addEventListener('close', resolve, { once: true });
  });
  socket.close();
  await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1000))]);
  await fetch(`${debuggerOrigin}/json/close/${tab.id}`).catch(() => {});
}
