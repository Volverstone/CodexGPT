import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudClient, validateCloudConfig } from '../src/cloud.js';
import { emptyState } from '../src/model.js';

const url = 'https://sample.supabase.co';
const key = 'sb_publishable_public-test';
const envelope = { state: emptyState(), revision: 0 };
const session = (access = 'access-1', expires = Date.now() / 1000 + 3600) => ({ access_token: access, refresh_token: 'refresh-1', expires_at: expires, user: { id: 'user-1', email: 'test@example.com' } });
const storage = () => {
  const values = new Map();
  return { getItem: k => values.get(k), setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
};
function json(data, status = 200) { return new Response(JSON.stringify(data), { status }); }
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('rejects private keys and malformed project addresses', () => {
  const jwt = role => `e30.${btoa(JSON.stringify({ role }))}.signature`;
  for (const invalid of ['sb_secret_private', jwt('service_role'), 'garbage']) assert.throws(() => new CloudClient({ url, key: invalid }), { code: 'config' });
  assert.throws(() => new CloudClient({ url: `${url}/path`, key }), { code: 'config' });
  assert.throws(() => new CloudClient({ url: 'http://example.com', key }), { code: 'config' });
  assert.doesNotThrow(() => new CloudClient({ url, key: jwt('anon') }));
  assert.deepEqual(validateCloudConfig({ url: `${url}/`, key: ` ${key} ` }), { url, key });
});

test('sign in persists only normalized session and sends current user token to RPC', async () => {
  const store = storage(), requests = [];
  const client = new CloudClient({ url, key, storage: store, fetchImpl: async (address, init) => {
    requests.push({ address, init });
    return json(address.includes('/auth/') ? { ...session(), unrelated: 'not persisted' } : envelope);
  } });
  await client.signIn(' test@example.com ', 'password');
  assert.deepEqual(await client.load(), envelope);
  assert.equal(JSON.parse(requests[0].init.body).email, 'test@example.com');
  assert.equal(requests[1].init.headers.Authorization, 'Bearer access-1');
  assert.equal(requests[1].init.headers.apikey, key);
  assert(!store.getItem(client.storageKey).includes('unrelated'));
  const restored = new CloudClient({ url, key, storage: store });
  assert.equal(restored.session.user.id, 'user-1');
  assert.notEqual(new CloudClient({ url: 'https://another.supabase.co', key, storage: store }).storageKey, client.storageKey);
});

test('signup with email confirmation leaves session empty', async () => {
  const client = new CloudClient({ url, key, storage: null, fetchImpl: async () => json({ id: 'user-1', email: 'test@example.com' }) });
  assert.equal(await client.signUp('test@example.com', 'password'), null);
  assert.equal(client.session, null);
  await assert.rejects(client.load(), { code: 'auth' });
});

test('saves optimistic revision and reports conflicts without retrying overwrite', async () => {
  const requests = [];
  const client = new CloudClient({ url, key, storage: null, fetchImpl: async (address, init) => {
    requests.push({ address, init });
    return json({ code: '40001', message: 'journal_conflict' }, 409);
  } });
  client.session = session();
  await assert.rejects(client.save(emptyState(), 4), { code: 'conflict' });
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].init.body), { p_state: emptyState(), p_expected_revision: 4 });
});

test('concurrent loads share exactly one refresh and use the new access token', async () => {
  let refreshes = 0;
  const waiting = deferred(), requests = [];
  const client = new CloudClient({ url, key, storage: null, fetchImpl: async (address, init) => {
    if (address.includes('refresh_token')) { refreshes++; await waiting.promise; return json(session('access-2')); }
    requests.push(init.headers.Authorization);
    return json(envelope);
  } });
  client.session = session('old', 1);
  const a = client.load(), b = client.load();
  waiting.resolve();
  await Promise.all([a,b]);
  assert.equal(refreshes, 1);
  assert.deepEqual(requests, ['Bearer access-2', 'Bearer access-2']);
});

test('a rejected access token refreshes and retries once, never loops', async () => {
  let refreshes = 0, rpcs = 0;
  const client = new CloudClient({ url, key, storage: null, fetchImpl: async address => {
    if (address.includes('refresh_token')) { refreshes++; return json(session('new')); }
    rpcs++; return json({ message: 'bad token' }, 401);
  } });
  client.session = session();
  await assert.rejects(client.load(), { code: 'auth' });
  assert.equal(refreshes, 1);
  assert.equal(rpcs, 2);
  assert.equal(client.session, null);
});

test('expired refresh credentials clear a restored session', async () => {
  const client = new CloudClient({ url, key, storage: null, fetchImpl: async () => json({ code: 'refresh_token_not_found' }, 400) });
  client.session = session('expired', 1);
  await assert.rejects(client.load(), { code: 'auth' });
  assert.equal(client.session, null);
});

test('signout clears session even when server is offline', async () => {
  const store = storage();
  const client = new CloudClient({ url, key, storage: store, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  client._setSession(session());
  await assert.rejects(client.signOut(), { code: 'network' });
  assert.equal(client.session, null);
  assert.equal(store.getItem(client.storageKey), undefined);
});

test('fetch is invoked without an arbitrary receiver and logout affects only this device', async () => {
  const addresses = [];
  const client = new CloudClient({ url, key, storage: null, fetchImpl: async function(address) {
    assert.equal(this, undefined);
    addresses.push(address);
    return json(envelope);
  } });
  client.session = session();
  await client.load();
  await client.signOut();
  assert.equal(addresses.at(-1), `${url}/auth/v1/logout?scope=local`);
});

test('a late refresh cannot revive a signed-out user', async () => {
  const waiting = deferred();
  const client = new CloudClient({ url, key, storage: null, fetchImpl: async address => address.includes('refresh_token') ? waiting.promise : new Response(null, { status: 204 }) });
  client.session = session('expired', 1);
  const pending = client.load();
  await client.signOut();
  waiting.resolve(json(session('late')));
  await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(client.session, null);
});

test('a late response from the previous account is rejected after signing in again', async () => {
  const waiting = deferred();
  const client = new CloudClient({ url, key, storage: null, fetchImpl: async address => address.includes('/rpc/') ? waiting.promise : json({ ...session('new-account'), user: { id: 'user-2' } }) });
  client.session = session();
  const pending = client.load();
  await client.signIn('other@example.com', 'password');
  waiting.resolve(json(envelope));
  await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(client.session.user.id, 'user-2');
});

test('malformed API responses are rejected instead of replacing a journal', async () => {
  const client = new CloudClient({ url, key, storage: null, fetchImpl: async () => json({ state: { students: [] }, revision: 4 }) });
  client.session = session();
  await assert.rejects(client.load(), { code: 'response' });
});

test('in-memory sessions work when a preview denies storage access', async () => {
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const client = new CloudClient({ url, key, storage: denied, fetchImpl: async address => json(address.includes('/auth/') ? session() : envelope) });
  await client.signIn('test@example.com', 'password');
  assert.deepEqual(await client.load(), envelope);
});


test('old cloud responses require SQL migration instead of silently downgrading typed attendance', async () => {
  const oldEnvelope = { state: { version: 1, students: [], attendance: {} }, revision: 7 };
  const client = new CloudClient({ url, key, storage: null, fetchImpl: async () => json(oldEnvelope) });
  client.session = session();
  await assert.rejects(client.load(), error => error.code === 'schema' && /SQL-схему/.test(error.message) && error.snapshot.version === 4);
  await assert.rejects(client.save(emptyState(), 7), { code: 'schema' });
});

test('old save RPC errors explain the calendar SQL migration', async () => {
  for (const response of [
    { code: '22023', message: 'invalid_journal' },
    { code: '22023', message: 'calendar_migration_required' },
  ]) {
    const client = new CloudClient({ url, key, storage: null, fetchImpl: async () => json(response, 400) });
    client.session = session();
    await assert.rejects(client.save(emptyState(), 1), error => error.code === 'schema' && /SQL-схему/.test(error.message));
  }
});
