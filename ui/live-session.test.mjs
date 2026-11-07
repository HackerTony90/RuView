import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resetLiveSession,
  setMemoryToken,
  getToken,
  rememberToken,
  forgetStoredToken,
  ignoreStoredToken,
  tokenSource,
  parseTokenText,
  demoOptIn,
  selectObservatoryFrame,
  prepareSameOriginTicket,
  isSameOriginSensingWs,
} from './live-session.mjs';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    removeItem(key) { delete data[key]; },
    dump: data,
  };
}

test('token stays in memory unless remember is explicit', () => {
  resetLiveSession();
  const storage = memoryStorage();
  setMemoryToken('tab-token-value');
  assert.equal(getToken(storage), 'tab-token-value');
  assert.equal(tokenSource(storage), 'memory');
  assert.equal(storage.dump['ruview-api-token'], undefined);
  rememberToken('saved-token-value', storage);
  assert.equal(storage.dump['ruview-api-token'], 'saved-token-value');
  forgetStoredToken(storage);
  assert.equal(storage.dump['ruview-api-token'], undefined);
});

test('an existing dashboard token is used and can be ignored', () => {
  resetLiveSession();
  const storage = memoryStorage({ 'ruview-api-token': 'already-saved' });
  assert.equal(getToken(storage), 'already-saved');
  assert.equal(tokenSource(storage), 'stored');
  ignoreStoredToken();
  assert.equal(getToken(storage), null);
  assert.equal(storage.dump['ruview-api-token'], 'already-saved');
});

test('token file parser rejects plans and accepts one line', () => {
  assert.equal(parseTokenText('').ok, false);
  assert.equal(parseTokenText('{"building":{}}').ok, false);
  assert.equal(parseTokenText('one\ntwo').ok, false);
  const parsed = parseTokenText('\uFEFFabcDEF123456\n');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.token, 'abcDEF123456');
});

test('demo generator is off unless the URL asks for it', () => {
  assert.equal(demoOptIn(''), false);
  assert.equal(demoOptIn('?demo=1'), true);
  const missing = selectObservatoryFrame({ demoRequested: false, liveFrame: null, link: 'auth-required' });
  assert.equal(missing.useDemoGenerator, false);
  assert.equal(missing.drawFigures, false);
  assert.equal(missing.mode, 'auth-required');
  const live = selectObservatoryFrame({
    demoRequested: false,
    liveFrame: { persons: [{ position: [1, 2, 3] }], classification: { presence: true } },
    link: 'live',
  });
  assert.equal(live.useDemoGenerator, false);
  assert.equal(live.drawFigures, false);
  assert.equal(live.figuresAreMeasuredLocations, false);
  assert.equal(live.hud, 'server');
  const demo = selectObservatoryFrame({ demoRequested: true, liveFrame: null, link: 'demo' });
  assert.equal(demo.useDemoGenerator, true);
});

test('ticket request stays on the page origin and reports missing auth', async () => {
  resetLiveSession();
  const locationLike = { protocol: 'http:', host: '127.0.0.1:3000', href: 'http://127.0.0.1:3000/ui/observatory-live.html' };
  assert.equal(isSameOriginSensingWs('ws://127.0.0.1:3000/ws/sensing', locationLike), true);
  assert.equal(isSameOriginSensingWs('ws://127.0.0.1:3001/ws/sensing', locationLike), false);
  assert.equal(isSameOriginSensingWs('ws://example.test/ws/sensing', locationLike), false);
  const missing = await prepareSameOriginTicket({
    locationLike,
    storage: memoryStorage(),
    fetchImpl: async (url) => {
      assert.equal(url, '/api/v1/ws-ticket');
      return { status: 401, ok: false, json: async () => ({}) };
    },
  });
  assert.equal(missing.auth, 'missing');
  setMemoryToken('rejected-token');
  const rejected = await prepareSameOriginTicket({
    locationLike,
    storage: memoryStorage(),
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer rejected-token');
      assert.equal(options.credentials, 'same-origin');
      return { status: 403, ok: false, json: async () => ({}) };
    },
  });
  assert.equal(rejected.auth, 'rejected');
});
