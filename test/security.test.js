'use strict';

// Khoá những hành vi mà hỏng là lộ token hoặc để dữ liệu ngoài điều khiển request
// mang token. Mỗi test ứng với một lỗi có thật; xem SECURITY.md.

const assert = require('node:assert');
const { Buffer } = require('node:buffer');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const Client = require('../src/client/Client.js');
const Recorder = require('../src/client/voice/receiver/Recorder.js');
const { findOwnFFmpeg, overwriteFlag } = Recorder;
const { uploadToSlot } = require('../src/util/AttachmentUpload.js');
const { RemoteAuth } = require('../src/util/RemoteAuth.js');
const { UserRoutes, segment } = require('../src/util/UserRoutes.js');

// Chuỗi tấn công: lùi thư mục, cắt path bằng `#` hoặc `?`.
const TRAVERSALS = ['../../invites/abc#', '../../channels/1/messages?', 'a/b', '..', '.', 'x#y', 'x?y=1'];

function makeClient() {
  const client = new Client({});
  client.token = 'tok';
  return client;
}

/**
 * Path cuối cùng mà undici sẽ gửi đi, sau khi URL tự chuẩn hoá `..` và cắt `#`.
 * @param {string} route Route tương đối
 * @returns {string}
 */
function resolvedPath(route) {
  return new URL(`https://discord.com/api/v10${route}`).pathname;
}

test('segment ma hoa ky tu bat duoc path, giu nguyen @', () => {
  assert.strictEqual(segment('123456789012345678'), '123456789012345678');
  assert.strictEqual(segment('@me'), '@me');
  assert.strictEqual(segment('../x'), '..%2Fx');
  assert.strictEqual(segment('a#b'), 'a%23b');
  assert.strictEqual(segment('a?b'), 'a%3Fb');
});

test('segment tu choi . va .. vi URL van hieu la lui thu muc', () => {
  for (const value of ['.', '..', '']) {
    assert.throws(() => segment(value), /Invalid route parameter/);
  }
});

test('moi UserRoute co tham so deu giu nguyen tien to khi gap chuoi tan cong', () => {
  const routes = Object.entries(UserRoutes).filter(([, build]) => build.length > 0);
  assert.ok(routes.length > 10, 'phai quet duoc cac route co tham so');

  for (const [name, build] of routes) {
    const expectedPrefix = resolvedPath(build(...Array(build.length).fill('1'))).split('/1')[0];

    for (const payload of TRAVERSALS) {
      let route;
      try {
        route = build(...Array(build.length).fill(payload));
      } catch (error) {
        // Từ chối hẳn cũng là an toàn.
        assert.match(error.message, /Invalid route parameter/, name);
        continue;
      }
      const path = resolvedPath(route);
      assert.ok(path.startsWith(expectedPrefix), `${name}(${payload}) thoat ra ${path}`);
      assert.ok(!route.includes('#') && !route.includes('?'), `${name}(${payload}) con # hoac ?`);
    }
  }
});

test('redeemNitro khong de ma qua bat request sang endpoint khac', async () => {
  const client = makeClient();
  const routes = [];
  client.rest.post = async route => {
    routes.push(route);
    return {};
  };

  // Gift sniper hay đưa thẳng nội dung tin nhắn vào; không khớp link thì code là cả chuỗi.
  await client.redeemNitro('../../invites/abc#');
  await client.redeemNitro('discord.gift/../../../../users/@me/relationships?');

  for (const route of routes) {
    assert.match(resolvedPath(route), /^\/api\/v10\/entitlements\/gift-codes\/[^/]+\/redeem$/, route);
  }

  client.destroy();
});

test('acceptInvite tu choi ma moi chua ky tu bat path', async () => {
  const client = makeClient();
  let fetched = false;
  client.fetchInvite = async () => {
    fetched = true;
    return {};
  };
  client.rest.post = async () => assert.fail('khong duoc goi API');

  for (const payload of ['../../users/@me#', 'abc/def', 'abc?x', 'a']) {
    await assert.rejects(() => client.acceptInvite(payload), /resolve an invite code/, payload);
  }
  assert.strictEqual(fetched, false);

  client.destroy();
});

test('acceptInvite van nhan link moi hop le', async () => {
  const client = makeClient();
  const codes = [];
  client.fetchInvite = async code => {
    codes.push(code);
    return { guild: { id: 'g1' }, channelId: 'c1' };
  };
  client.guilds.cache.set('g1', { id: 'g1' });

  await client.acceptInvite('https://discord.gg/abc-DEF_1');
  await client.acceptInvite('abcDEF');

  assert.deepStrictEqual(codes, ['abc-DEF_1', 'abcDEF']);
  client.destroy();
});

function makeFakeSocket() {
  const listeners = {};
  return {
    send() {},
    close: () => listeners.close?.(),
    on(event, handler) {
      listeners[event] = handler;
    },
    receiveRaw(raw) {
      listeners.message(raw);
    },
  };
}

test('RemoteAuth: goi tin hong lam connect reject chu khong nem ra ngoai socket', async () => {
  const socket = makeFakeSocket();
  const auth = new RemoteAuth({ createSocket: () => socket, rest: {} });
  const connecting = auth.connect();

  assert.doesNotThrow(() => socket.receiveRaw('{khong phai json'));
  await assert.rejects(connecting, SyntaxError);
});

test('RemoteAuth: payload giai ma that bai lam connect reject', async () => {
  const socket = makeFakeSocket();
  const auth = new RemoteAuth({ createSocket: () => socket, rest: {} });
  const connecting = auth.connect();

  socket.receiveRaw(JSON.stringify({ op: 'hello', timeout_ms: 60_000, heartbeat_interval: 30_000 }));
  assert.doesNotThrow(() => socket.receiveRaw(JSON.stringify({ op: 'nonce_proof', encrypted_nonce: 'AAAA' })));
  await assert.rejects(connecting);
});

test('RemoteAuth: client.login loi thi connect reject, khong treo', async () => {
  const auth = new RemoteAuth({ createSocket: () => makeFakeSocket(), rest: {} });
  const client = {
    login: async () => {
      throw new Error('token bi tu choi');
    },
  };
  const connecting = auth.connect(client);

  auth.emit('finish', 'token');
  await assert.rejects(connecting, /token bi tu choi/);
});

test('uploadToSlot tu choi dia chi khong phai https', async () => {
  await assert.rejects(() => uploadToSlot('http://example.com/upload', 'data'), /non-https/);
  await assert.rejects(() => uploadToSlot('file:///etc/passwd', 'data'), /non-https/);
});

test('findOwnFFmpeg chi khop pid/ppid, khong khop theo dong lenh', () => {
  const list = [
    { pid: 10, ppid: 1, cmd: 'ffmpeg -i - -f matroska out.mkv' },
    { pid: 20, ppid: 5, cmd: 'ffmpeg -i - -f matroska out.mkv' },
  ];

  assert.strictEqual(findOwnFFmpeg(list, 20).pid, 20);
  assert.strictEqual(findOwnFFmpeg([{ pid: 30, ppid: 7 }], 7).pid, 30);
  // Tiến trình của mình đã thoát: không được kill tiến trình khác chỉ vì trùng lệnh.
  assert.strictEqual(findOwnFFmpeg(list, 99), null);
  assert.strictEqual(findOwnFFmpeg(list, undefined), null);
});

test('Recorder khong ghi de file da co neu khong duoc phep', () => {
  // Ném trước khi mở socket hay spawn ffmpeg, nên test không cần ffmpeg.
  assert.throws(() => new Recorder(null, { output: __filename, portUdpH264: 1, portUdpOpus: 2 }), /already exists/);
});

test('ffmpeg chi bi cam ghi de khi output la file', () => {
  assert.strictEqual(overwriteFlag(false, false), '-n');
  assert.strictEqual(overwriteFlag(false, true), '-y');
  // Stream ghi qua socket ma Recorder vua mo; tren Windows `-n` lam ffmpeg thoat ngay.
  assert.strictEqual(overwriteFlag(true, false), '-y');
});

test('_censoredToken giau phan bi mat cua token', () => {
  const client = makeClient();
  // Token giả dựng lúc chạy, không để nguyên chuỗi trong file: nếu không thì test
  // quét token bên dưới và các máy quét secret (GitGuardian) báo nhầm là lộ token.
  const id = Buffer.from('123456789012345678').toString('base64');
  const secret = 'x'.repeat(30);
  client.token = [id, 'GabcDE', secret].join('.');

  const censored = client._censoredToken;
  assert.ok(!censored.includes(secret));
  assert.ok(censored.startsWith(`${id}.GabcDE.`));

  client.destroy();
});

// Token người dùng: base64 của id, timestamp, rồi chữ ký HMAC.
const DISCORD_TOKEN_PATTERN = /[MNO][\w-]{23,27}\.[\w-]{6}\.[\w-]{27,40}/;

test('khong file nao dang duoc git theo doi chua token Discord that', t => {
  const root = join(__dirname, '..');
  let files;
  try {
    files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    t.skip('khong co git');
    return;
  }

  const leaks = files.filter(file => {
    if (file === 'package-lock.json') return false;
    try {
      return DISCORD_TOKEN_PATTERN.test(readFileSync(join(root, file), 'utf8'));
    } catch {
      return false;
    }
  });

  assert.deepStrictEqual(leaks, []);
});

test('.env nam trong .gitignore', () => {
  const ignored = readFileSync(join(__dirname, '..', '.gitignore'), 'utf8').split('\n');
  assert.ok(ignored.includes('.env'));
});
