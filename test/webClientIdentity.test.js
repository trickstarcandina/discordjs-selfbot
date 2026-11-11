'use strict';

const assert = require('node:assert');
const { Buffer } = require('node:buffer');
const { test } = require('node:test');
const { buildSelfbotHeaders, removeOrigin } = require('../src/rest/SelfbotREST.js');
const Options = require('../src/util/Options.js');
const {
  DefaultChromeVersion,
  DefaultSecChUa,
  DefaultSuperProperties,
  WebApiVersion,
  fetchClientBuildNumber,
} = require('../src/util/SelfbotDefaults.js');

const options = { ws: { properties: DefaultSuperProperties }, http: { headers: {} } };

function superProperties(headers) {
  return JSON.parse(Buffer.from(headers['x-super-properties'], 'base64').toString('utf8'));
}

test('user agent, client hints and super properties name one Chrome release', () => {
  const headers = buildSelfbotHeaders(options);
  const major = DefaultChromeVersion.split('.')[0];

  assert.ok(headers['user-agent'].includes(`Chrome/${DefaultChromeVersion}`));
  assert.strictEqual(headers['sec-ch-ua'], DefaultSecChUa);
  assert.strictEqual(DefaultSecChUa, `"Google Chrome";v="${major}", " Not;A Brand";v="99", "Chromium";v="${major}"`);
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

test('fetchClientBuildNumber reads the build number the live client reports', async () => {
  const shell = body => async () => ({ ok: true, status: 200, text: async () => body });

  assert.strictEqual(
    await fetchClientBuildNumber(shell('window.GLOBAL_ENV = {"BUILD_NUMBER":"670026","API_VERSION":9};')),
    670026,
  );
  await assert.rejects(fetchClientBuildNumber(shell('<html></html>')), /did not contain a build number/);
  await assert.rejects(
    fetchClientBuildNumber(async () => ({ ok: false, status: 503, text: async () => '' })),
    /HTTP 503/,
  );
});
