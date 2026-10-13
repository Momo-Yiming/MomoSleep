import assert from 'node:assert/strict';
import { Script, createContext } from 'node:vm';
import test from 'node:test';
import { appPage } from '../src/app-page.mjs';
import { disclosedSleepSample } from '../src/sleep-sample.mjs';

// Exercise the shipped inline client with only its event/element surface.
function clientHarness(language) {
  const accountId = 'b5796ca0-524a-4f45-a9cf-7d28f6e77710';
  const requestId = 'b5796ca0-524a-4f45-a9cf-7d28f6e77711';
  const pending = { accountId, requestId, points: 390 };
  const stored = new Map([['sleepDemoAccount', accountId], ['momoPendingToken', JSON.stringify(pending)]]);
  const events = {}, roots = new Map(), dynamic = [];
  const attrs = source => Object.fromEntries([...source.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([, key, value]) => [key, value ?? '']));
  const matches = (element, selector) => selector.split(',').some(part => {
    part = part.trim();
    if (part.startsWith('#')) return element.id === part.slice(1);
    const data = /^\[data-([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(part);
    if (!data) return false;
    const key = data[1].replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    return Object.hasOwn(element.dataset, key) && (data[2] == null || element.dataset[key] === data[2]);
  });
  const element = (tag = 'div', attributes = {}) => {
    let html = '';
    const node = {
      tagName: tag.toUpperCase(), id: attributes.id, dataset: {}, value: attributes.value ?? '',
      disabled: Object.hasOwn(attributes, 'disabled'), hidden: false, textContent: '', open: false,
      setAttribute() {}, removeAttribute() {}, focus() {},
      replaceChildren() {}, append() {}, showModal() { this.open = true; }, close() { this.open = false; },
      querySelector() { return { focus() {} }; },
    };
    for (const [key, value] of Object.entries(attributes)) if (key.startsWith('data-')) node.dataset[key.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
    Object.defineProperty(node, 'innerHTML', { get: () => html, set(value) {
      html = value;
      if (node.id !== 'content') return;
      dynamic.splice(0);
      for (const [, name, source] of value.matchAll(/<(button|input|select|a|h1|div|strong|p)\b([^>]*)>/g)) dynamic.push(element(name, attrs(source)));
    } });
    return node;
  };
  for (const id of ['content', 'refresh', 'connection', 'connection-error', 'sheet', 'sheet-content', 'toast']) roots.set(id, element('div', { id }));
  const document = {
    getElementById: id => dynamic.find(node => node.id === id) || roots.get(id) || null,
    querySelectorAll: selector => [...roots.values(), ...dynamic].filter(node => matches(node, selector)),
    addEventListener: (type, callback) => { events[type] = callback; },
    createElement: tag => element(tag), createTextNode: text => ({ textContent: text }),
  };
  const state = {
    account: { id: accountId, points: 50 }, sampleSleep: disclosedSleepSample().summary,
    currentClaim: null, currentSimulationClaim: null, simulationSleep: null, claims: [], products: [], orders: [], entries: [],
    stats: { earnedPoints: 440, spentPoints: 390, virtualTokenBalance: 390, claimedNights: 1, orderCount: 0 },
    cashPolicy: { minimumPoints: 100, maximumPoints: 10000, rateFenPer100Points: 100 }, cashRedemptions: [],
    tokenExchangePolicy: { minimumPoints: 1, maximumPoints: 10000 }, tokenExchanges: [], tokenMints: [], tokenPolicy: {},
  };
  const requests = [];
  let uuidCalls = 0;
  const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
  const context = createContext({
    document, location: { hash: '#rewards' }, navigator: {}, AbortController,
    window: { localStorage: storage, sessionStorage: storage, addEventListener() {}, scrollTo() {} },
    crypto: { randomUUID() { uuidCalls++; return 'b5796ca0-524a-4f45-a9cf-7d28f6e77712'; } },
    setTimeout: () => 1, clearTimeout() {},
    fetch: async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, body });
      const response = structuredClone(state);
      if (url === '/api/demo/token-exchanges') response.tokenExchanges.push({ id: requestId, points: 390, tokenAmount: 390, status: 'sandbox_completed', createdAt: '2026-10-14T00:00:00Z' });
      return { ok: true, status: 200, json: async () => response };
    },
  });
  const script = /<script>([\s\S]*?)<\/script>/.exec(appPage(language))[1];
  new Script(script).runInContext(context);
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const click = node => events.click({ target: { closest: () => node } });
  return { document, requests, stored, requestId, settle, uuidCalls: () => uuidCalls,
    showTokens() { click({ dataset: { rewards: 'token' } }); },
    presetButtons: () => document.querySelectorAll('[data-preset="token"]'),
    clickPreset: click,
    submit() { events.submit({ target: { id: 'token-form' }, preventDefault() {} }); },
  };
}

for (const language of ['zh', 'en']) test(`pending token exchange preserves its amount and request ID after an unknown debit (${language})`, async () => {
  const client = clientHarness(language);
  await client.settle();
  client.showTokens();
  const input = client.document.getElementById('token-points');
  const submit = client.document.getElementById('token-submit');
  assert.equal(input.value, '390');
  assert.equal(input.disabled, true);
  assert.equal(client.document.getElementById('token-estimate').textContent, '390 SLEEP');
  assert.equal(submit.disabled, false, 'a previously committed request must be resumable even after its debit reduced the balance');
  assert.ok(client.presetButtons().length > 0);
  for (const preset of client.presetButtons()) {
    assert.equal(preset.disabled, true);
    client.clickPreset(preset);
    assert.equal(input.value, '390', 'presets cannot change a frozen pending request');
  }
  client.submit();
  await client.settle();
  const posts = client.requests.filter(request => request.body);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/demo/token-exchanges');
  assert.equal(posts[0].body.requestId, client.requestId);
  assert.equal(posts[0].body.points, 390);
  assert.equal(client.uuidCalls(), 0, 'resuming must not allocate another request ID');
  assert.equal(client.stored.has('momoPendingToken'), false);
});
