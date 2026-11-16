'use strict';

const { normalizeSuperProperties } = require('./SelfbotDefaults');

/**
 * Dựng phần `d` của payload identify cho user account.
 *
 * Khác payload của bot ở hai điểm bắt buộc: KHÔNG có `intents` và KHÔNG có
 * `shard`. Gửi kèm hai field đó thì Discord đóng kết nối với code 4013/4004.
 *
 * @param {Object} options Tuỳ chọn
 * @param {string} options.token Token của user
 * @param {Object} options.properties Super properties
 * @param {number} options.capabilities Gateway capabilities bitfield
 * @param {Object} options.clientState Client state
 * @param {Object} [options.presence] Presence ban đầu
 * @returns {Object} payload `d` của op 2
 */
function buildUserIdentify({ token, properties, capabilities, clientState, presence }) {
  // The web client sends no `compress` key at all; transport compression is negotiated in the gateway URL.
  const data = {
    token,
    capabilities,
    properties: normalizeSuperProperties(properties),
    client_state: clientState,
  };

  if (presence) data.presence = presence;

  return data;
}

module.exports = buildUserIdentify;
