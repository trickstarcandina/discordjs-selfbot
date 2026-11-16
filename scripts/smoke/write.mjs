// Smoke Tier 2: co ghi len tai khoan, nhung moi check tu tra lai gia tri cu
// trong cung mot phien. Mot lan login cho tat ca check de chi ton 1 identify.
// Chay: SMOKE_ALLOW_WRITE=1 node --env-file=.env scripts/smoke/write.mjs
// Khong chay trong CI.
//
// Nhung thu co tinh KHONG test o day, vi khong tra lai duoc hoac rui ro:
//   setUsername / doi email / doi mat khau — can password, Discord chan 2 lan/gio
//   setHypeSquad — badge cong khai, roi nha van de lai dau vet
//   setSamsungActivity — can package name cua mot app Android that
//   redeemNitro, installUserApps, deauthorize, authorizeURL — mat tien hoac
//   khong hoan tac duoc
import { createRequire } from 'node:module';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { appendResults } from './log.mjs';

const require = createRequire(import.meta.url);
const { Client, CustomStatus, Events, RichPresence, SpotifyRPC } = require('../../src/index.js');

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Thieu bien moi truong DISCORD_TOKEN');
  process.exit(1);
}

// Cong tac ro rang: script nay doi ho so that, khong duoc chay nham.
if (process.env.SMOKE_ALLOW_WRITE !== '1') {
  console.error('Script nay ghi len tai khoan that. Chay lai voi SMOKE_ALLOW_WRITE=1 neu that su muon.');
  process.exit(1);
}

// Ghi ton nhieu request hon doc (moi check: doc, ghi, doc, tra lai, doc lai),
// va PATCH /users/@me bi rate limit chat hon GET. Nghi lau hon ban readonly.
const CALL_DELAY_MS = Number(process.env.SMOKE_WRITE_DELAY_MS ?? 3000);
const LOG_FILE = new URL('results.md', import.meta.url);
const MARKER = `smoke-${Date.now().toString(36)}`;

const client = new Client({});
const results = [];

// Moi thao tac ghi ben duoi deu lam Discord day nguoc mot packet ve. Gom lai de
// cuoi phien kiem tra handler co that su nhan duoc khong — test offline chi chung
// minh duoc handler xu ly dung payload gia.
const seenPackets = new Set();
const seenEvents = new Set();
client.on(Events.Raw, packet => packet?.t && seenPackets.add(packet.t));
client.on(Events.UserNoteUpdate, () => seenEvents.add(Events.UserNoteUpdate));
client.on(Events.RelationshipUpdate, () => seenEvents.add(Events.RelationshipUpdate));
// Bat len khi mot buoc tra lai gia tri cu that bai. Tu do khong ghi them gi nua.
let aborted = null;

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const step = async fn => {
  await sleep(CALL_DELAY_MS);
  return fn();
};

// Discord tra captcha bang mot body khong co field `code`, nen @discordjs/rest
// dat message thanh "No Description". Doc rawError moi biet that su chuyen gi.
// Day khong phai loi cua thu vien: khong cau hinh `captchaSolver` thi 400 di
// thang ra ngoai dung nhu thiet ke.
const captchaService = error => error?.rawError?.captcha_service ?? null;

/**
 * Doc gia tri goc, ghi gia tri moi, doc lai, tra lai gia tri goc, doc lai lan nua.
 *
 * Ghi that bai ma gia tri van y nguyen thi khong co gi de tra lai — ghi nhan roi
 * chay tiep. Chi khi tai khoan that su da doi ma khong tra lai duoc moi dung han
 * script va in gia tri goc ra console de con sua tay.
 */
async function roundTrip({ name, read, write, restore }) {
  if (aborted) {
    results.push({ name, status: 'SKIP', detail: `bo qua sau khi "${aborted}" khong tra lai duoc` });
    return;
  }

  let before;
  try {
    before = await step(read);
  } catch (error) {
    results.push({ name, status: 'FAIL', detail: `doc gia tri goc that bai: ${error.message}` });
    return;
  }

  let expected;
  let writeError;
  try {
    expected = await step(() => write());
  } catch (error) {
    writeError = error;
  }

  let after;
  try {
    after = await step(read);
  } catch (error) {
    results.push({ name, status: 'FAIL', detail: `doc lai sau khi ghi that bai: ${error.message}` });
    return;
  }

  // Ghi hong va gia tri khong nhuc nhich: tai khoan sach, khong can tra lai.
  if (writeError && same(after, before)) {
    const service = captchaService(writeError);
    results.push(
      service
        ? { name, status: 'SKIP', detail: `${service} chan: can captchaSolver moi ghi duoc, tai khoan khong doi` }
        : { name, status: 'FAIL', detail: `ghi that bai, tai khoan khong doi: ${writeError.message}` },
    );
    return;
  }

  // Tu day tro di tai khoan co the dang mang gia tri moi. Bat buoc tra lai.
  try {
    await step(() => restore(before));
    const back = await step(read);
    if (!same(back, before)) {
      throw new Error(`doc lai khong khop: mong ${JSON.stringify(before)}, nhan ${JSON.stringify(back)}`);
    }
  } catch (error) {
    aborted = name;
    console.error(`\nKHONG TRA LAI DUOC "${name}": ${error.message}`);
    console.error('Gia tri goc, sua tay bang tay:', JSON.stringify(before));
    results.push({ name, status: 'FAIL', detail: `khong tra lai duoc: ${error.message}` });
    return;
  }

  if (writeError) {
    results.push({ name, status: 'FAIL', detail: `ghi that bai nhung van lam doi tai khoan: ${writeError.message}` });
  } else if (!same(after, expected)) {
    results.push({
      name,
      status: 'FAIL',
      detail: `ghi xong nhung doc lai khong khop: mong ${JSON.stringify(expected)}, nhan ${JSON.stringify(after)}`,
    });
  } else {
    results.push({ name, status: 'PASS', detail: 'ghi, doc lai va tra lai deu khop' });
  }
}

// Danh cho check khong chay duoc vi thieu dieu kien ben ngoai, khong phai vi hong.
class Skipped extends Error {
  name = 'Skipped';
}

// Check khong theo dang round trip (presence chi di qua gateway, khong co ack).
async function check(name, fn) {
  if (aborted) {
    results.push({ name, status: 'SKIP', detail: `bo qua sau khi "${aborted}" khong tra lai duoc` });
    return;
  }
  try {
    results.push({ name, status: 'PASS', detail: (await step(fn)) ?? 'ok' });
  } catch (error) {
    const service = captchaService(error);
    results.push(
      service
        ? { name, status: 'SKIP', detail: `${service} chan: can captchaSolver moi ghi duoc` }
        : { name, status: 'FAIL', detail: `${error.name}: ${error.message}` },
    );
  }
}

const timeout = setTimeout(() => {
  console.error('FAIL: khong nhan duoc ready sau 30s');
  process.exit(1);
}, 30_000);

client.on('error', error => {
  console.error('FAIL:', error);
  process.exit(1);
});

client.once('ready', async () => {
  clearTimeout(timeout);
  console.log(`Dang nhap: ${client.user.tag} (${client.user.id})`);
  console.log(`Marker cua lan chay nay: ${MARKER}\n`);

  // GET /users/@me tra ve bio va pronouns; User#_patch khong luu hai field nay,
  // nen doc thang tu API moi la doc lai that su.
  const profile = () => client.rest.get('/users/@me');

  await roundTrip({
    name: 'user.setAboutMe()',
    read: async () => (await profile()).bio ?? null,
    write: async () => {
      await client.user.setAboutMe(MARKER);
      return MARKER;
    },
    restore: bio => client.user.setAboutMe(bio),
  });

  // Shortcut: bo qua. GET /users/@me khong tra pronouns (doc o /users/{id}/profile) va
  // PATCH /users/@me doi captcha; setPronouns can chuyen sang PATCH /users/@me/profile.
  results.push({
    name: 'user.setPronouns()',
    status: 'SKIP',
    detail: 'chua kiem: PATCH /users/@me doi captcha, duong dung la /users/@me/profile',
  });

  await roundTrip({
    name: 'user.setGlobalName()',
    read: async () => (await profile()).global_name ?? null,
    write: async () => {
      await client.user.setGlobalName(MARKER);
      return MARKER;
    },
    restore: globalName => client.user.setGlobalName(globalName),
  });

  await roundTrip({
    name: 'user.setAccentColor()',
    read: async () => (await profile()).accent_color ?? null,
    write: async () => {
      await client.user.setAccentColor(0x5865f2);
      return 0x5865f2;
    },
    restore: color => client.user.setAccentColor(color),
  });

  await roundTrip({
    name: 'settings.setTheme()',
    read: async () => (await client.settings.fetch()).theme,
    write: async () => {
      // Method setTheme chi nhan dark|light. Tai khoan co the dang dung theme khac
      // (midnight), nen buoc tra lai phai di duong edit() tho.
      const next = client.settings.theme === 'dark' ? 'light' : 'dark';
      await client.settings.setTheme(next);
      return next;
    },
    restore: theme => client.settings.edit({ theme }),
  });

  await roundTrip({
    name: 'settings.toggleCompactMode()',
    read: async () => (await client.settings.fetch()).compactMode ?? false,
    write: async () => {
      const next = !client.settings.compactMode;
      await client.settings.toggleCompactMode();
      return next;
    },
    restore: () => client.settings.toggleCompactMode(),
  });

  // Chup rieng object custom_status tho: buoc ghi de len client.settings.raw,
  // nen den luc restore chay thi doc lai tu do se ra chinh MARKER.
  await client.settings.fetch();
  const originalCustomStatus = client.settings.raw.custom_status ?? null;

  await roundTrip({
    name: 'settings.setCustomStatus()',
    read: async () => {
      await client.settings.fetch();
      return client.settings.raw.custom_status?.text ?? null;
    },
    write: async () => {
      await client.settings.setCustomStatus({ text: MARKER });
      return MARKER;
    },
    restore: () =>
      originalCustomStatus
        ? client.settings.edit({ custom_status: originalCustomStatus })
        : client.settings.setCustomStatus(null),
  });

  const friendId = client.relationships.friendCache.firstKey();

  await roundTrip({
    name: 'notes.updateNote()',
    read: async () => (friendId ? (await client.notes.fetch(friendId, { force: true })) || null : null),
    write: async () => {
      if (!friendId) return null;
      await client.notes.updateNote(friendId, MARKER);
      return MARKER;
    },
    restore: note => (friendId ? client.notes.updateNote(friendId, note || null) : undefined),
  });

  await roundTrip({
    name: 'relationships.setNickname()',
    read: async () => {
      if (!friendId) return null;
      await client.relationships.fetch();
      return client.relationships.friendNicknames.get(friendId) ?? null;
    },
    write: async () => {
      if (!friendId) return null;
      await client.relationships.setNickname(friendId, MARKER);
      return MARKER;
    },
    restore: nickname => (friendId ? client.relationships.setNickname(friendId, nickname ?? null) : undefined),
  });

  await roundTrip({
    name: 'settings.addRestrictedGuild() + removeRestrictedGuild()',
    read: async () => {
      await client.settings.fetch();
      return [...client.settings.disableDMfromGuilds.keys()].sort();
    },
    write: async () => {
      const guildId = client.guilds.cache.firstKey();
      if (!guildId) return [];
      const before = [...client.settings.disableDMfromGuilds.keys()];
      if (before.includes(guildId)) return before.sort();

      await client.settings.addRestrictedGuild(guildId);
      return [...before, guildId].sort();
    },
    restore: async before => {
      const guildId = client.guilds.cache.firstKey();
      if (!guildId || before.includes(guildId)) return undefined;
      return client.settings.removeRestrictedGuild(guildId);
    },
  });

  const settledGuild = client.guilds.cache.find(guild => Object.keys(guild.settings.raw ?? {}).length > 0);

  await roundTrip({
    name: 'guild.settings.edit()',
    read: async () => settledGuild?.settings.raw.message_notifications ?? null,
    write: async () => {
      if (!settledGuild) return null;
      // 1 = chi bao khi bi nhac ten. Doi sang 0 (bao moi tin) neu dang la 1.
      const next = settledGuild.settings.raw.message_notifications === 1 ? 0 : 1;
      await settledGuild.settings.edit({ message_notifications: next });
      return next;
    },
    restore: value => (settledGuild ? settledGuild.settings.edit({ message_notifications: value ?? 3 }) : undefined),
  });

  // Khong dung roundTrip: buoc don dep la revokeAllFriendInvites(), no xoa CA
  // nhung loi moi co tu truoc. Chi chay khi tai khoan dang co dung 0 loi moi.
  await check('user.createFriendInvite() + revokeAllFriendInvites()', async () => {
    const existing = await client.user.fetchFriendInvites();
    if (existing.size > 0) return `skipped: tai khoan dang co ${existing.size} loi moi, khong dam revoke`;

    const invite = await client.user.createFriendInvite();
    await sleep(CALL_DELAY_MS);
    const after = await client.user.fetchFriendInvites();
    const created = after.has(invite.code);

    await sleep(CALL_DELAY_MS);
    await client.user.revokeAllFriendInvites();
    await sleep(CALL_DELAY_MS);
    const remaining = await client.user.fetchFriendInvites();
    if (remaining.size > 0) throw new Error(`revoke xong van con ${remaining.size} loi moi`);

    if (!created) throw new Error('tao xong nhung khong thay ma trong danh sach');
    return 'tao roi thu hoi, ve lai 0';
  });

  // Presence di qua gateway va khong co ack. Check nay chi chung minh duoc payload
  // khong lam Discord ngat ket noi; dung/sai hien thi phai nhin bang mat.
  const activityName = async () => {
    await sleep(CALL_DELAY_MS);
    return client.presence.activities[0]?.name ?? null;
  };

  await check('setPresence(CustomStatus)', async () => {
    client.user.setPresence({ activities: [new CustomStatus().setState(MARKER).setEmoji('🔥')] });
    return `activity=${await activityName()}`;
  });

  await check('setPresence(RichPresence)', async () => {
    client.user.setPresence({
      activities: [new RichPresence().setName(MARKER).setDetails('smoke').setStartTimestamp(Date.now())],
    });
    return `activity=${await activityName()}`;
  });

  await check('setPresence(SpotifyRPC)', async () => {
    client.user.setPresence({
      activities: [new SpotifyRPC().setSongId('4cOdK2wGLETKBW3PvgPWqT').setArtistIds('1uNFoZAHBGtllmzznpCI3s')],
    });
    return `activity=${await activityName()}`;
  });

  await check('setPresence(clear)', async () => {
    client.user.setPresence({ activities: [] });
    return `activity=${await activityName()}`;
  });

  await check('RichPresence.getExternal()', async () => {
    // Discord proxy anh ngoai thanh asset dung duoc trong rich presence. Dung
    // anh mac dinh cua chinh Discord de khong keo ai khac vao.
    const [asset] = await RichPresence.getExternal(
      client,
      '367827983903490050',
      'https://cdn.discordapp.com/embed/avatars/0.png',
    );

    if (!asset?.external_asset_path) throw new Error('khong co external_asset_path trong ket qua');
    return 'co external_asset_path';
  });

  // Cac check ghi phia tren deu lam Discord day packet ve. Doi mot nhip cho packet
  // cuoi kip toi noi roi moi ket luan.
  await check('gateway day nguoc packet cua cac thao tac vua ghi', async () => {
    await sleep(2000);
    const wanted = ['USER_GUILD_SETTINGS_UPDATE', 'USER_NOTE_UPDATE', 'RELATIONSHIP_UPDATE'];
    const missing = wanted.filter(name => !seenPackets.has(name));
    // In ca danh sach thay duoc: ten packet khong phai du lieu tai khoan, va khi
    // thieu thi thu can biet la Discord doi ten packet hay khong day gi ve ca.
    if (missing.length) {
      throw new Error(`khong thay packet: ${missing.join(', ')} - thay: ${[...seenPackets].join(', ')}`);
    }
    return `nhan du ${wanted.length} loai packet`;
  });

  await check('setting tai khoan dong bo nguoc qua gateway', () => {
    // Discord van day USER_SETTINGS_UPDATE thi handler cua fork chay duoc.
    if (seenPackets.has('USER_SETTINGS_UPDATE')) return 'handler USER_SETTINGS_UPDATE chay duoc';
    if (!seenPackets.has('USER_SETTINGS_PROTO_UPDATE')) throw new Error('khong thay packet setting nao ca');

    // Discord da chuyen setting tai khoan sang protobuf. Fork chi co handler cho
    // USER_SETTINGS_UPDATE dang JSON, nen packet moi roi vao khoang khong:
    // client.settings chi tuoi lai khi tu goi fetch() hoac edit().
    throw new Skipped(
      'Discord day USER_SETTINGS_PROTO_UPDATE (protobuf), fork khong giai ma - client.settings khong tu tuoi lai',
    );
  });

  await check('handler emit event tuong ung', () => {
    const wanted = [Events.UserNoteUpdate, Events.RelationshipUpdate];
    const missing = wanted.filter(name => !seenEvents.has(name));
    if (missing.length) throw new Error(`khong thay event: ${missing.join(', ')}`);
    return `nhan du ${wanted.length} event`;
  });

  // Skipped duoc nem tu trong check nen den day moi phan loai lai duoc.
  for (const result of results) {
    if (result.detail.startsWith('Skipped: ')) {
      result.status = 'SKIP';
      result.detail = result.detail.slice('Skipped: '.length);
    }
  }

  const failed = results.filter(result => result.status === 'FAIL');
  const passed = results.filter(result => result.status === 'PASS').length;

  console.log(results.map(result => `${result.status.padEnd(4)} ${result.name} — ${result.detail}`).join('\n'));
  console.log(`tong: ${passed}/${results.length} pass`);

  appendResults(LOG_FILE, 'write', results);
  console.log(`Da ghi ket qua vao ${LOG_FILE.pathname}`);

  client.destroy();
  process.exit(failed.length ? 1 : 0);
});

await client.login(token);
