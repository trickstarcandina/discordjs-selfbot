'use strict';

// Hai việc voice phải chịu được mà bản port cũ không chịu được: gói UDP hỏng
// (hoặc mã hoá bằng key cũ) đến tay `PacketHandler`, và người dùng ghi log
// `debug` ra ngoài. Việc đầu làm sập process, việc sau làm lộ voice token và
// `secret_key`.

const assert = require('node:assert');
const { Buffer } = require('node:buffer');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const { test } = require('node:test');

const VoiceWebSocket = require('../src/client/voice/networking/VoiceWebSocket.js');
const PacketHandler = require('../src/client/voice/receiver/PacketHandler.js');
const { redactSecrets, stringifyRedacted, REDACTED } = require('../src/client/voice/util/Redact.js');
const { VoiceOpcodes } = require('../src/client/voice/util/VoiceConstants.js');

function makeHandler() {
  const errors = [];
  const receiver = new EventEmitter();
  receiver.connection = {
    ssrcMap: new Map([[1234, { userId: 'u1', hasVideo: false, speaking: 0 }]]),
    authentication: { mode: 'aead_aes256_gcm_rtpsize', secret_key: crypto.randomBytes(32) },
    dave: null,
    onSpeaking() {},
  };
  const handler = new PacketHandler(receiver);
  handler.on('error', error => errors.push(error));
  return { handler, errors, receiver };
}

function rtpHeader(ssrc, firstByte = 0x80) {
  const header = Buffer.alloc(12);
  header.writeUInt8(firstByte, 0);
  header.writeUInt32BE(ssrc, 8);
  return header;
}

test('push bo qua goi ngan hon mot goi RTP toi thieu, khong nem', () => {
  const { handler, receiver } = makeHandler();
  const received = [];
  receiver.on('receiverData', (...args) => received.push(args));

  for (const buffer of [Buffer.alloc(0), Buffer.alloc(8), Buffer.alloc(11), rtpHeader(1234), Buffer.alloc(31)]) {
    assert.doesNotThrow(() => handler.push(buffer), `goi ${buffer.length} byte`);
  }
  assert.doesNotThrow(() => handler.push('khong phai buffer'));
  assert.deepStrictEqual(received, []);
});

test('goi sai auth tag (key cu, hoac rac) bi bo qua thay vi nem', () => {
  const { handler, errors, receiver } = makeHandler();
  const received = [];
  receiver.on('receiverData', (...args) => received.push(args));

  const garbage = Buffer.concat([rtpHeader(1234), crypto.randomBytes(40)]);
  assert.doesNotThrow(() => handler.push(garbage));
  // Co extension bit: header 16 byte, cung khong nem.
  assert.doesNotThrow(() => handler.push(Buffer.concat([rtpHeader(1234, 0x90), crypto.randomBytes(40)])));
  // Video ssrc (ssrc + 1) di nhanh parse rieng, cung phai an toan.
  assert.doesNotThrow(() => handler.push(Buffer.concat([rtpHeader(1235), crypto.randomBytes(40)])));

  assert.deepStrictEqual(received, [], 'goi hong khong duoc phat ra ngoai');
  // Khong co stream dang mo cho user nay thi khong emit error (giong hanh vi cu
  // voi parse loi): tranh app khong lang nghe `error` chet theo.
  assert.deepStrictEqual(errors, []);
});

test('goi hop le sau goi hong van di qua binh thuong', () => {
  const { handler, receiver } = makeHandler();
  const { secret_key } = receiver.connection.authentication;
  const received = [];
  receiver.on('receiverData', (userStat, packet) => received.push([userStat.userId, packet.payload.toString('utf8')]));

  handler.push(Buffer.concat([rtpHeader(1234), crypto.randomBytes(40)]));

  // Dung mot goi that: payload type 120 (opus), ma hoa AES-256-GCM voi nonce 4 byte dem 0.
  const header = rtpHeader(1234);
  header.writeUInt8(120, 1);
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32BE(7, 0);
  const cipher = crypto.createCipheriv('aes-256-gcm', secret_key, nonce);
  cipher.setAAD(header);
  const encrypted = Buffer.concat([cipher.update(Buffer.from('opus-data')), cipher.final()]);
  const packet = Buffer.concat([header, encrypted, cipher.getAuthTag(), nonce.subarray(0, 4)]);

  handler.push(packet);
  assert.deepStrictEqual(received, [['u1', 'opus-data']]);
});

test('handshake UDP sai khong nem trong listener message', async () => {
  const VoiceUDPClient = require('../src/client/voice/networking/VoiceUDPClient.js');
  const udp = Object.create(VoiceUDPClient.prototype);
  EventEmitter.call(udp);
  udp.voiceConnection = {
    on() {},
    sockets: {},
    authentication: { ssrc: 1, port: 1 },
    receiver: { packets: { push() {} } },
  };
  const errors = [];
  udp.on('error', error => errors.push(error.message));
  udp.on('debug', () => {});

  // Chan gui di: chi can listener `message` duoc gan.
  const dgram = require('node:dgram');
  const original = dgram.createSocket;
  const fake = new EventEmitter();
  fake.send = () => {};
  dgram.createSocket = () => fake;
  try {
    // `send` giả không gọi callback nên promise này không bao giờ settle; không cần chờ.
    udp.createUDPSocket('127.0.0.1').catch(() => {});
  } finally {
    dgram.createSocket = original;
  }

  assert.doesNotThrow(() => fake.emit('message', Buffer.alloc(1)));
  assert.deepStrictEqual(errors, ['UDP_WRONG_HANDSHAKE']);
});

test('redactSecrets che token, secret_key va session o moi do sau, khong sua goc', () => {
  const input = {
    op: VoiceOpcodes.SESSION_DESCRIPTION,
    d: { mode: 'aead_aes256_gcm_rtpsize', secret_key: [1, 2, 3], dave_protocol_version: 1 },
    nested: [{ token: 'tok', session_id: 'sid', sessionId: 'sid2', keep: 'me' }],
    token: null,
  };
  const out = redactSecrets(input);

  assert.deepStrictEqual(out, {
    op: VoiceOpcodes.SESSION_DESCRIPTION,
    d: { mode: 'aead_aes256_gcm_rtpsize', secret_key: REDACTED, dave_protocol_version: 1 },
    nested: [{ token: REDACTED, session_id: REDACTED, sessionId: REDACTED, keep: 'me' }],
    token: null,
  });
  assert.deepStrictEqual(input.d.secret_key, [1, 2, 3], 'object goc phai giu nguyen');
  assert.ok(!stringifyRedacted(input).includes('"tok"'));
});

test('log [WS] >> va << khong chua voice token lan secret_key', async () => {
  const ws = Object.create(VoiceWebSocket.prototype);
  EventEmitter.call(ws);
  const logs = [];
  ws.on('debug', message => logs.push(message));
  ws.send = async (data, description = data) => {
    ws.emit('debug', `[WS] >> ${description}`);
    return data;
  };

  const sent = await ws.sendPacket({
    op: VoiceOpcodes.IDENTIFY,
    d: { server_id: 'g', user_id: 'u', session_id: 'sess-secret', token: 'voice-token-secret' },
  });
  // Du lieu gui di van nguyen ven, chi log bi che.
  assert.ok(sent.includes('voice-token-secret') && sent.includes('sess-secret'));

  ws.onPacket({
    op: VoiceOpcodes.SESSION_DESCRIPTION,
    d: { mode: 'aead_aes256_gcm_rtpsize', secret_key: [9, 9, 9], dave_protocol_version: 1 },
  });

  const joined = logs.join('\n');
  assert.ok(joined.includes('[WS] >>') && joined.includes('[WS] <<'), joined);
  assert.ok(!joined.includes('voice-token-secret'), joined);
  assert.ok(!joined.includes('sess-secret'), joined);
  assert.ok(!joined.includes('[9,9,9]'), joined);
  assert.ok(joined.includes(REDACTED));
});

test('VoiceConnection khong in token, sessionId hay secret_key ra debug', () => {
  const VoiceConnection = require('../src/client/voice/VoiceConnection.js');
  const connection = Object.create(VoiceConnection.prototype);
  EventEmitter.call(connection);
  const logs = [];
  connection.on('debug', message => logs.push(message));
  connection.authentication = { token: 'voice-token-secret', sessionId: 'sess-secret', secret_key: [9, 9, 9] };
  connection.reconnect = () => {};
  connection.authenticate = () => {};
  connection.status = 0;

  connection.setTokenAndEndpoint('voice-token-secret', 'host:443');
  connection.setSessionId('sess-secret');
  connection.emit('debug', `Ready with authentication details: ${stringifyRedacted(connection.authentication)}`);

  const joined = logs.join('\n');
  assert.ok(joined.includes('endpoint "host:443"'), joined);
  assert.ok(!joined.includes('voice-token-secret'), joined);
  assert.ok(!joined.includes('sess-secret'), joined);
  assert.ok(!joined.includes('[9,9,9]'), joined);
});

// `SpeakingBitField` cua v14 dat co la `Flags.Speaking`; ban port doc
// `FLAGS.SPEAKING` cua v13, tuc `undefined.SPEAKING`. O `onSpeaking` loi bi
// try/catch cua WebSocket nuot thanh `error`, nen stream `end: 'silence'` khong
// bao gio ket thuc; o `PacketHandler` thi no nam tren duong UDP va lam sap process.
test('speaking = 0 ket thuc stream end:silence, goi dau tien bat co Speaking', () => {
  const VoiceConnection = require('../src/client/voice/VoiceConnection.js');
  const SpeakingBitField = require('../src/util/SpeakingBitField.js');
  const { VoiceStatus } = require('../src/client/voice/util/VoiceConstants.js');

  const connection = Object.create(VoiceConnection.prototype);
  EventEmitter.call(connection);
  connection.channel = { guild: { members: { cache: new Map() } } };
  // `client` la getter doc tu voiceManager.
  connection.voiceManager = { client: { users: { cache: new Map() } } };
  connection._speaking = new Map();
  connection.status = VoiceStatus.CONNECTED;
  const stopped = [];
  connection.receiver = { packets: { _stoppedSpeaking: id => stopped.push(id) } };

  assert.doesNotThrow(() => connection.onSpeaking({ user_id: 'u1', speaking: 0 }));
  assert.deepStrictEqual(stopped, ['u1']);

  const { handler, receiver } = makeHandler();
  const speaking = [];
  receiver.connection.onSpeaking = data => speaking.push(data.speaking);
  const userStat = receiver.connection.ssrcMap.get(1234);
  handler.audioReceiver(1234, userStat, { header: { payloadType: 120 }, payload: Buffer.alloc(1) });
  assert.deepStrictEqual(speaking, [SpeakingBitField.Flags.Speaking]);
  assert.strictEqual(userStat.speaking, SpeakingBitField.Flags.Speaking);
});
