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
 * Builds `sec-ch-ua` the way Chrome does. The GREASE brand, its version and the order of the three brands
 * all derive from the major version (Chromium `GetGreasedUserAgentBrandVersion`), so a header copied from
 * another release names a brand this release never sends.
 * @param {string} chromeVersion Chrome version, e.g. `153.0.0.0`
 * @returns {string}
 */
function buildSecChUa(chromeVersion) {
  const major = Number.parseInt(chromeVersion, 10);
  if (Number.isNaN(major)) throw new RangeError(`Not a Chrome version: ${chromeVersion}`);
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const grease = `"Not${chars[major % 11]}A${chars[(major + 1) % 11]}Brand";v="${['8', '99', '24'][major % 3]}"`;

  // Slot of the GREASE brand, of Chromium and of the real brand.
  const order = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ][major % 6];
  const brands = [];
  brands[order[0]] = grease;
  brands[order[1]] = `"Chromium";v="${major}"`;
  brands[order[2]] = `"Google Chrome";v="${major}"`;
  return brands.join(', ');
}

/**
 * `sec-ch-ua` of the default Chrome release.
 * @type {string}
 */
const DefaultSecChUa = buildSecChUa(DefaultChromeVersion);

/**
 * Build number of the Discord web client, read from its app shell on 2026-11-15. Discord ships a new build
 * most days and reports it on every request; pass `ws.properties.client_build_number` to use a newer one.
 * @type {number}
 */
const DefaultClientBuildNumber = 673764;

/**
 * Bits of the launch signature the web client sets when it detects a client mod (BetterDiscord, Vencord
 * and others). An unmodified client sends them all as zero.
 * Reference: https://docs.discord.food/reference#launch-signature
 * @type {number[]}
 */
const ClientModBits = [119, 108, 100, 91, 84, 75, 61, 55, 48, 38, 24, 11];

/**
 * Draws a launch signature: a random UUID with every client mod bit cleared. A plain random UUID leaves
 * those bits random and so reports a client mod, against `has_client_mods: false`.
 * @param {string} [uuid] UUID to derive the signature from
 * @returns {string}
 */
function generateLaunchSignature(uuid = randomUUID()) {
  const mask = ClientModBits.reduce((bits, bit) => bits | (1n << BigInt(bit)), 0n);
  const hex = (BigInt(`0x${uuid.replaceAll('-', '')}`) & ~mask).toString(16).padStart(32, '0');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/**
 * Super properties sent with every REST request (header `x-super-properties`) and in the gateway identify
 * payload. Key set, order and values follow the web client; keys carry no `$` prefix, Discord dropped the
 * old schema. It leaves out `client_launch_id` and `launch_signature`: a client draws its own in
 * {@link createSuperProperties}, and a copy of this object must not carry one pair into every client.
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
  client_app_state: 'unfocused',
};

/**
 * Super properties for one client, with a launch id and signature of its own. Clients that shared them
 * would tell Discord that their accounts run in one process.
 * @returns {Object}
 */
function createSuperProperties() {
  const { client_app_state, ...properties } = DefaultSuperProperties;

  // The web client draws both once per page load and sends them ahead of `client_app_state`.
  return {
    ...properties,
    client_launch_id: randomUUID(),
    launch_signature: generateLaunchSignature(),
    client_app_state,
  };
}

/**
 * Gateway capabilities bitfield. It selects the dispatch format Discord sends, so a stale value changes
 * the payloads a client receives.
 *
 * The web client identified with 1767421 in a live session on 2026-11-11. This is that value without
 * `CHANNEL_OBFUSCATION` (`1 << 15`): with it Discord obfuscates every channel the user cannot view, and
 * nothing here reads that format.
 * Tham khảo: https://docs.discord.food/topics/gateway#gateway-capabilities
 * @type {number}
 */
const DefaultCapabilities = 1767421 & ~(1 << 15);

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

module.exports = {
  DefaultChromeVersion,
  DefaultUserAgent,
  DefaultSecChUa,
  DefaultClientBuildNumber,
  ClientModBits,
  WebApiVersion,
  DefaultSuperProperties,
  DefaultCapabilities,
  DefaultClientState,
  DefaultCiphers,
  normalizeSuperProperties,
  encodeSuperProperties,
  buildSecChUa,
  generateLaunchSignature,
  createSuperProperties,
};
