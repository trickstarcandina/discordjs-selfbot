'use strict';

const assert = require('node:assert');
const { Buffer } = require('node:buffer');
const { test } = require('node:test');
const { DefaultSuperProperties, DefaultCapabilities, DefaultClientState } = require('../src/util/SelfbotDefaults.js');
const buildUserIdentify = require('../src/util/buildUserIdentify.js');

const base = {
  token: 'tok',
  properties: DefaultSuperProperties,
  capabilities: DefaultCapabilities,
  clientState: DefaultClientState,
};

test('khong co intents va shard trong payload', () => {
  const d = buildUserIdentify(base);
  assert.ok(!('intents' in d), 'payload user account khong duoc co intents');
  assert.ok(!('shard' in d), 'payload user account khong duoc co shard');
});

test('payload co dung key set cua web client', () => {
  const d = buildUserIdentify(base);
  // Captured from a live web client session: token, capabilities, properties, client_state. No compress.
  assert.deepStrictEqual(Object.keys(d), ['token', 'capabilities', 'properties', 'client_state']);
  assert.ok(!('compress' in d), 'web client khong gui compress trong identify');
});

test('client_state chi co guild_versions', () => {
  assert.deepStrictEqual(DefaultClientState, { guild_versions: {} });
});

test('co token, capabilities, client_state, properties', () => {
  const d = buildUserIdentify(base);
  assert.strictEqual(d.token, 'tok');
  assert.strictEqual(d.capabilities, DefaultCapabilities);
  assert.deepStrictEqual(d.client_state, DefaultClientState);
  assert.strictEqual(d.properties.browser, DefaultSuperProperties.browser);
});

test('strip tien to $ trong properties', () => {
  const d = buildUserIdentify({ ...base, properties: { $os: 'Windows', browser: 'Chrome' } });
  assert.strictEqual(d.properties.os, 'Windows');
  assert.strictEqual(d.properties.browser, 'Chrome');
  assert.ok(!('$os' in d.properties), 'key $os phai bi strip');
});

test('presence chi xuat hien khi duoc truyen', () => {
  assert.ok(!('presence' in buildUserIdentify(base)));
  const withPresence = buildUserIdentify({ ...base, presence: { status: 'online', activities: [] } });
  assert.deepStrictEqual(withPresence.presence, { status: 'online', activities: [] });
});

test('khong mutate object properties dau vao', () => {
  const input = { $os: 'Windows' };
  buildUserIdentify({ ...base, properties: input });
  assert.deepStrictEqual(input, { $os: 'Windows' });
});

test('encodeSuperProperties tra ve base64 cua JSON', () => {
  const { encodeSuperProperties } = require('../src/util/SelfbotDefaults.js');
  const encoded = encodeSuperProperties({ os: 'Windows' });
  assert.strictEqual(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')).os, 'Windows');
});
