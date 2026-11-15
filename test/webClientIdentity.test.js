'use strict';

const assert = require('node:assert');
const { Buffer } = require('node:buffer');
const { test } = require('node:test');
const { DefaultRestOptions } = require('@discordjs/rest');
const { buildSelfbotHeaders, createSelfbotREST, removeOrigin } = require('../src/rest/SelfbotREST.js');
const Options = require('../src/util/Options.js');
const {
  ClientModBits,
  DefaultCapabilities,
  DefaultChromeVersion,
  DefaultSuperProperties,
  WebApiVersion,
  buildSecChUa,
  generateLaunchSignature,
} = require('../src/util/SelfbotDefaults.js');

const options = { ws: { properties: DefaultSuperProperties }, http: { headers: {} } };

function superProperties(headers) {
  return JSON.parse(Buffer.from(headers['x-super-properties'], 'base64').toString('utf8'));
}

test('user agent, client hints and super properties name one Chrome release', () => {
  const headers = buildSelfbotHeaders(options);
  assert.ok(headers['user-agent'].includes(`Chrome/${DefaultChromeVersion}`));
  assert.strictEqual(headers['sec-ch-ua'], buildSecChUa(DefaultChromeVersion));
  assert.strictEqual(superProperties(headers).browser_version, DefaultChromeVersion);
  assert.strictEqual(superProperties(headers).browser_user_agent, headers['user-agent']);
});

test('accept-language matches what Chrome sends', () => {
  assert.strictEqual(buildSelfbotHeaders(options)['accept-language'], 'en-US,en;q=0.9');
});

test('super properties carry the key set of the web client', () => {
  assert.deepStrictEqual(Object.keys(superProperties(buildSelfbotHeaders(options))), [
    'os',
    'browser',
    'device',
    'device_model_name',
    'system_locale',
    'has_client_mods',
    'browser_user_agent',
    'browser_version',
    'os_version',
    'referrer',
    'referring_domain',
    'referrer_current',
    'referring_domain_current',
    'release_channel',
    'client_build_number',
    'client_event_source',
    'client_launch_id',
    'launch_signature',
    'client_app_state',
  ]);
});

test('removeOrigin drops the header a browser omits on same-origin GET', () => {
  assert.deepStrictEqual(removeOrigin({ Origin: 'https://discord.com', 'x-keep': '1' }), { 'x-keep': '1' });
});

test('REST and gateway default to the API version of the web client', () => {
  const defaults = Options.createDefault();

  assert.strictEqual(defaults.rest.version, WebApiVersion);
  assert.strictEqual(defaults.ws.version, Number(WebApiVersion));
});

test('buildSecChUa reproduces the header real Chrome releases send', () => {
  // Chrome derives the GREASE brand, its version and the brand order from the major version. The first
  // three are headers real Chrome sent; they pin the algorithm the fourth is computed with.
  assert.strictEqual(buildSecChUa('120.0.0.0'), '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"');
  assert.strictEqual(buildSecChUa('131.0.0.0'), '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"');
  assert.strictEqual(buildSecChUa('134.0.0.0'), '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"');
  assert.strictEqual(buildSecChUa('153.0.0.0'), '"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"');
});

test('client hints follow the Chrome version in ws.properties', () => {
  const headers = buildSelfbotHeaders({
    ...options,
    ws: { properties: { ...DefaultSuperProperties, browser_version: '134.0.0.0', os: 'Mac OS X' } },
  });

  assert.strictEqual(headers['sec-ch-ua'], buildSecChUa('134.0.0.0'));
  assert.strictEqual(headers['sec-ch-ua-platform'], '"macOS"');
});

test('a browser that is not Chrome sends no client hints', () => {
  const headers = buildSelfbotHeaders({
    ...options,
    ws: { properties: { ...DefaultSuperProperties, browser: 'Firefox', browser_version: '140.0' } },
  });

  assert.deepStrictEqual(
    Object.keys(headers).filter(key => key.startsWith('sec-ch-ua')),
    [],
  );
});

function uuidBits(uuid) {
  return BigInt(`0x${uuid.replaceAll('-', '')}`);
}

test('launch signature reports no client mod', () => {
  const signature = generateLaunchSignature('ffffffff-ffff-ffff-ffff-ffffffffffff');
  const mask = ClientModBits.reduce((bits, bit) => bits | (1n << BigInt(bit)), 0n);

  assert.match(signature, /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
  // Every mod bit is cleared and nothing else is touched.
  assert.strictEqual(uuidBits(signature), (1n << 128n) - 1n - mask);
  assert.strictEqual(uuidBits(Options.createDefault().ws.properties.launch_signature) & mask, 0n);
});

test('every client draws its own launch id and signature', () => {
  const first = Options.createDefault().ws.properties;
  const second = Options.createDefault().ws.properties;

  assert.notStrictEqual(first.client_launch_id, second.client_launch_id);
  assert.notStrictEqual(first.launch_signature, second.launch_signature);
});

test('default capabilities leave channel obfuscation off', () => {
  // Bit 15 makes Discord obfuscate channels the user cannot view; nothing in the library reads that format.
  assert.strictEqual(DefaultCapabilities & (1 << 15), 0);
});

test('a partial ws.properties override keeps the other super properties', () => {
  const BaseClient = require('../src/client/BaseClient.js');
  const client = new BaseClient({ ws: { properties: { client_build_number: 1 } } });
  const sent = superProperties(client.rest.options.headers);

  assert.strictEqual(client.options.ws.properties.browser, 'Chrome');
  assert.strictEqual(client.options.ws.properties.client_build_number, 1);
  // REST and the gateway identify read the same object, so both report the overridden build.
  assert.deepStrictEqual(sent, client.options.ws.properties);
  client.destroy();
});

test('Origin goes out on POST and is dropped on GET', async t => {
  const original = DefaultRestOptions.makeRequest;
  t.after(() => {
    DefaultRestOptions.makeRequest = original;
  });

  const sent = [];
  DefaultRestOptions.makeRequest = async (url, init) => {
    sent.push(init.headers);
    return { status: 200, statusText: 'OK', ok: true, headers: new Headers(), text: async () => '{}' };
  };

  const rest = createSelfbotREST(Options.createDefault());
  const url = 'https://discord.com/api/v9/users/@me';
  const request = method => rest.options.makeRequest(url, { method, headers: { origin: 'https://discord.com' } });

  await request('POST');
  await request('GET');
  await request(undefined);

  assert.deepStrictEqual(
    sent.map(headers => headers.origin),
    ['https://discord.com', undefined, undefined],
  );
});
