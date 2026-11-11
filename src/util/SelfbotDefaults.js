'use strict';

const { Buffer } = require('node:buffer');
const { randomUUID } = require('node:crypto');

/**
 * Chrome release the client claims. Every place that names a version must name this one: the User-Agent,
 * `browser_version`, and the `sec-ch-ua` client hints. Discord compares them.
 * @type {string}
 */
const DefaultChromeVersion = '153.0.0.0';

/**
 * API version the Discord web client talks. User-only endpoints live here; the bot default is v10.
 * @type {string}
 */
const WebApiVersion = '9';

/**
 * User-Agent of the Discord web client in Chrome on Windows.
 * @type {string}
 */
const DefaultUserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  `Chrome/${DefaultChromeVersion} Safari/537.36`;

/**
 * `sec-ch-ua` exactly as Chrome sends it: three brands, the real one first. A pair of brands, or one
 * whose version does not match the User-Agent, tells a server that the client is not Chrome.
 * @type {string}
 */
const DefaultSecChUa =
  `"Google Chrome";v="${DefaultChromeVersion.split('.')[0]}", " Not;A Brand";v="99", ` +
  `"Chromium";v="${DefaultChromeVersion.split('.')[0]}"`;

/**
 * Build number of the Discord web client, verified on 2026-11-11. Discord ships a new build most days and
 * reports it on every request, so prefer {@link fetchClientBuildNumber} over this constant.
 * @type {number}
 */
const DefaultClientBuildNumber = 670026;

/**
 * Super properties sent with every REST request (header `x-super-properties`) and in the gateway identify
 * payload. Key set, order and values follow the web client; keys carry no `$` prefix, Discord dropped the
 * old schema.
 * @type {Object}
 */
const DefaultSuperProperties = {
  os: 'Windows',
  browser: 'Chrome',
  device: '',
  device_model_name: '',
  system_locale: 'en-US',
  has_client_mods: false,
  browser_user_agent: DefaultUserAgent,
  browser_version: DefaultChromeVersion,
  os_version: '10',
  referrer: '',
  referring_domain: '',
  referrer_current: '',
  referring_domain_current: '',
  release_channel: 'stable',
  client_build_number: DefaultClientBuildNumber,
  client_event_source: null,
  // The web client draws both once per page load.
  client_launch_id: randomUUID(),
  launch_signature: randomUUID(),
  client_app_state: 'unfocused',
};

/**
 * Gateway capabilities bitfield the web client identifies with, captured from a live session on
 * 2026-11-11. It selects the dispatch format Discord sends, so a stale value changes the payloads a
 * client receives.
 * Tham khảo: https://docs.discord.food/topics/gateway#gateway-capabilities
 * @type {number}
 */
const DefaultCapabilities = 1767421;

/**
 * Client-side cache state sent with the identify. A fresh web client reports an empty guild version map
 * and nothing else; the older seven-field shape no longer matches what the client sends.
 * @type {Object}
 */
const DefaultClientState = {
  guild_versions: {},
};

/**
 * Danh sách cipher TLS theo thứ tự Chrome dùng. Đặt đúng thứ tự này để
 * TLS fingerprint (JA3) giống browser thay vì giống Node mặc định.
 * @type {string[]}
 */
const DefaultCiphers = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  'AES128-SHA',
  'AES256-SHA',
];

/**
 * Bỏ tiền tố `$` khỏi key của super properties (schema cũ của Discord).
 * Không mutate object đầu vào.
 * @param {Object} properties Super properties thô
 * @returns {Object}
 */
function normalizeSuperProperties(properties) {
  const result = {};
  for (const [key, value] of Object.entries(properties)) {
    result[key.startsWith('$') ? key.slice(1) : key] = value;
  }
  return result;
}

/**
 * Encode super properties thành giá trị header `x-super-properties`.
 * @param {Object} properties Super properties
 * @returns {string} base64
 */
function encodeSuperProperties(properties) {
  return Buffer.from(JSON.stringify(normalizeSuperProperties(properties)), 'utf8').toString('base64');
}

/**
 * Reads the build number the live web client reports. Its app shell carries `window.GLOBAL_ENV`, which is
 * where the client itself takes `client_build_number` from, so this is the value Discord expects today.
 * @param {Function} [fetchImpl] Fetch implementation, defaults to the global one
 * @param {AbortSignal} [signal] Abort signal
 * @returns {Promise<number>}
 */
async function fetchClientBuildNumber(fetchImpl = globalThis.fetch, signal = undefined) {
  const response = await fetchImpl('https://discord.com/app', {
    headers: { 'user-agent': DefaultUserAgent },
    signal,
  });
  if (!response.ok) throw new Error(`Discord app shell returned HTTP ${response.status}`);

  const buildNumber = /"BUILD_NUMBER":"(\d+)"/.exec(await response.text())?.[1];
  if (!buildNumber) throw new Error('Discord app shell did not contain a build number');

  return Number(buildNumber);
}

module.exports = {
  DefaultChromeVersion,
  DefaultUserAgent,
  DefaultSecChUa,
  DefaultClientBuildNumber,
  WebApiVersion,
  DefaultSuperProperties,
  DefaultCapabilities,
  DefaultClientState,
  DefaultCiphers,
  normalizeSuperProperties,
  encodeSuperProperties,
  fetchClientBuildNumber,
};
