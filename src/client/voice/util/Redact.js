'use strict';

/**
 * Key mà giá trị không bao giờ được lọt vào log `debug`.
 *
 * Voice token và `secret_key` cho phép bất kỳ ai cầm được nó nghe và nói thay
 * tài khoản trong kênh đó cho tới khi session hết hạn. Người dùng gắn
 * `client.on('debug')` rồi ghi ra file hay dán lên issue là chuyện thường, nên
 * phải che ngay tại nguồn chứ không trông chờ ở phía đọc.
 * @type {Set<string>}
 */
const SECRET_KEYS = new Set(['token', 'secret_key', 'session_id', 'sessionId']);

const REDACTED = '[redacted]';

/**
 * Trả về bản sao của `value` với mọi giá trị dưới key nhạy cảm thay bằng
 * `[redacted]`, ở mọi độ sâu. Không sửa object gốc.
 *
 * `Buffer` và `Uint8Array` dưới key nhạy cảm (`secret_key` của
 * `SESSION_DESCRIPTION` là mảng byte) cũng bị che; ở key khác thì giữ nguyên.
 * @param {*} value Giá trị cần che
 * @returns {*}
 */
function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;

  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_KEYS.has(key) && inner != null ? REDACTED : redactSecrets(inner);
  }
  return out;
}

/**
 * `JSON.stringify` sau khi che secret, cho các dòng `debug` in nguyên packet.
 * @param {*} value Giá trị cần in
 * @returns {string}
 */
function stringifyRedacted(value) {
  return JSON.stringify(redactSecrets(value));
}

module.exports = { redactSecrets, stringifyRedacted, REDACTED, SECRET_KEYS };
