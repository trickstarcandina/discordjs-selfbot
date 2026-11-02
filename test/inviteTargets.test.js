'use strict';

// Bản discord.js 14.28.0 thêm role gán khi vào bằng invite và danh sách user được
// phép dùng invite (target users). Mã upstream giả định invite luôn thuộc một
// guild client đã cache; tài khoản người dùng thì hay xem invite của guild chưa
// vào (`acceptInvite` gọi `fetchInvite` trước khi join) và có cả lời mời kết bạn
// không thuộc guild nào. Các test dưới đây giữ đúng những đường đó.

const assert = require('node:assert');
const { Buffer } = require('node:buffer');
const { test } = require('node:test');
const { InviteTargetUsersJobStatus } = require('discord-api-types/v10');
const Client = require('../src/client/Client.js');
const { Guild } = require('../src/structures/Guild.js');
const InviteRole = require('../src/structures/InviteRole.js');
const { Role } = require('../src/structures/Role.js');

// Shape của `APIInviteRole`: chỉ phần hiển thị, không có permissions.
const inviteRole = (id, name) => ({
  id,
  name,
  position: 1,
  color: 0xff0000,
  colors: { primary_color: 0xff0000, secondary_color: null, tertiary_color: null },
  icon: null,
  unicode_emoji: null,
});

const guildInvite = (guildId, roles) => ({
  code: 'abc',
  type: 0,
  guild: { id: guildId, name: 'G', features: [], verification_level: 0, nsfw_level: 0 },
  channel: null,
  roles,
});

function makeClient() {
  return new Client({});
}

function cacheGuild(client, roles) {
  const guild = new Guild(client, {
    id: 'g1',
    name: 'G',
    unavailable: false,
    features: [],
    roles: roles.map(role => ({ ...role, permissions: '0', hoist: false, managed: false, mentionable: false })),
  });
  client.guilds.cache.set('g1', guild);
  return guild;
}

test('invite cua guild chua vao: roles la InviteRole', async () => {
  const client = makeClient();
  client.rest.get = async () => guildInvite('g9', [inviteRole('r1', 'Member')]);

  const invite = await client.fetchInvite('abc');

  assert.strictEqual(invite.guild.constructor.name, 'InviteGuild');
  assert.deepStrictEqual([...invite.roles.keys()], ['r1']);
  const role = invite.roles.get('r1');
  assert.ok(role instanceof InviteRole);
  assert.strictEqual(role.name, 'Member');
  assert.strictEqual(role.hexColor, '#ff0000');
  assert.strictEqual(role.toString(), '<@&r1>');

  client.destroy();
});

test('invite cua guild da cache: roles lay tu guild nhung khong ghi vao cache', async () => {
  const client = makeClient();
  const guild = cacheGuild(client, [inviteRole('r1', 'Ten cu')]);
  client.rest.get = async () => guildInvite('g1', [inviteRole('r1', 'Ten moi')]);

  const invite = await client.fetchInvite('abc');
  const role = invite.roles.get('r1');

  assert.ok(role instanceof Role);
  assert.strictEqual(role.guild, guild);
  assert.strictEqual(role.name, 'Ten moi');
  // `_add(role, false)`: clone, nên role trong cache không bị dữ liệu invite ghi đè.
  assert.strictEqual(guild.roles.cache.get('r1').name, 'Ten cu');

  client.destroy();
});

test('friend invite khong co roles: roles la null', () => {
  const client = makeClient();
  const Invite = require('../src/structures/Invite.js');

  const invite = new Invite(client, { code: 'abc', type: 2, channel: null });

  assert.strictEqual(invite.roles, null);
  assert.strictEqual(invite.channel, null);

  client.destroy();
});

test('INVITE_CREATE co role_ids: map sang role trong cache', () => {
  const client = makeClient();
  cacheGuild(client, [inviteRole('r1', 'Member')]);
  client.channels.cache.set('c1', { id: 'c1' });

  const { invite } = client.actions.InviteCreate.handle({
    code: 'abc',
    channel_id: 'c1',
    guild_id: 'g1',
    role_ids: ['r1'],
    uses: 0,
  });

  assert.strictEqual(invite.roles.get('r1'), client.guilds.cache.get('g1').roles.cache.get('r1'));

  client.destroy();
});

test('invites.create gui role_ids va target users dang CSV', async () => {
  const client = makeClient();
  const guild = cacheGuild(client, [inviteRole('r1', 'Member')]);
  const posts = [];
  client.rest.post = async (route, options) => {
    posts.push([route, options]);
    return { code: 'abc', type: 0, channel: null };
  };

  await guild.invites.create('c1', { roles: ['r1'], targetUsersFile: ['u1', 'u2'], reason: 'test' });
  await guild.invites.create('c1');

  const [[route, first], [, second]] = posts;
  assert.strictEqual(route, '/channels/c1/invites');
  assert.deepStrictEqual(first.body.role_ids, ['r1']);
  assert.strictEqual(first.reason, 'test');
  assert.deepStrictEqual(first.files, [
    { key: 'target_users_file', data: 'u1\nu2', name: 'users.csv', contentType: 'text/csv' },
  ]);
  // Không truyền target users thì không có file, request đi dạng JSON như cũ.
  assert.deepStrictEqual(second.files, []);
  assert.strictEqual(second.body.role_ids, undefined);

  client.destroy();
});

test('target users: tai CSV, cap nhat va xem trang thai job', async () => {
  const client = makeClient();
  const guild = cacheGuild(client, []);
  const gets = [];
  const puts = [];
  client.rest.get = async route => {
    gets.push(route);
    if (route.endsWith('/job-status')) {
      return {
        status: InviteTargetUsersJobStatus.Completed,
        total_users: 2,
        processed_users: 2,
        created_at: '2026-11-01T00:00:00.000Z',
        completed_at: '2026-11-01T00:00:05.000Z',
        error_message: null,
      };
    }
    // `@discordjs/rest` trả ArrayBuffer khi body không phải JSON.
    return new TextEncoder().encode('u1\nu2').buffer;
  };
  client.rest.put = async (route, options) => puts.push([route, options.files]);

  const csv = await guild.invites.fetchTargetUsers('https://discord.gg/abc');
  assert.ok(Buffer.isBuffer(csv));
  assert.strictEqual(csv.toString('utf8'), 'u1\nu2');

  await guild.invites.updateTargetUsers('abc', ['u3']);
  assert.deepStrictEqual(puts, [
    [
      '/invites/abc/target-users',
      [{ key: 'target_users_file', data: 'u3', name: 'users.csv', contentType: 'text/csv' }],
    ],
  ]);

  const job = await guild.invites.fetchTargetUsersJobStatus('abc');
  assert.deepStrictEqual(job, {
    status: InviteTargetUsersJobStatus.Completed,
    totalUsers: 2,
    processedUsers: 2,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    completedAt: new Date('2026-11-01T00:00:05.000Z'),
    errorMessage: null,
  });

  assert.deepStrictEqual(gets, ['/invites/abc/target-users', '/invites/abc/target-users/job-status']);

  client.destroy();
});
