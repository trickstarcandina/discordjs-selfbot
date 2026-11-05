'use strict';

// Bản discord.js 14.28.1 sửa một race: kênh trong `resolved` của interaction mang
// `permissions`/`app_permissions` của *người gọi* interaction đó, nhưng
// `BaseChannel._patch` lại ghi chúng thẳng vào kênh trong cache. Hai interaction
// trên cùng kênh của hai người khác nhau thì người đọc sau có thể thấy quyền của
// người kia. Bản vá ghi quyền lên một bản clone thuộc interaction, cache giữ null.

const assert = require('node:assert');
const { test } = require('node:test');
const { ChannelType } = require('discord-api-types/v10');
const Client = require('../src/client/Client.js');
const { Guild } = require('../src/structures/Guild.js');
const { resolveInteractionChannel } = require('../src/util/Util.js');

function makeGuild(client) {
  const guild = new Guild(client, { id: 'g1', name: 'G', unavailable: false, features: [], roles: [] });
  client.guilds.cache.set('g1', guild);
  return guild;
}

const resolvedChannel = (permissions, appPermissions) => ({
  id: 'c1',
  type: ChannelType.GuildText,
  name: 'general',
  guild_id: 'g1',
  permissions,
  app_permissions: appPermissions,
});

test('quyen trong resolved khong lot vao kenh trong cache', () => {
  const client = new Client({});
  const guild = makeGuild(client);

  const first = resolveInteractionChannel(client, guild, resolvedChannel('8', '0'));
  const cached = client.channels.cache.get('c1');

  assert.ok(cached, 'kenh phai duoc them vao cache');
  assert.notStrictEqual(first, cached, 'phai tra ve ban clone');
  assert.strictEqual(cached.permissions, null);
  assert.strictEqual(cached.appPermissions, null);
  assert.strictEqual(first.permissions.bitfield, 8n);
  assert.strictEqual(first.appPermissions.bitfield, 0n);
  assert.ok(Object.isFrozen(first.permissions));
});

test('hai interaction tren cung kenh giu quyen rieng', () => {
  const client = new Client({});
  const guild = makeGuild(client);

  const first = resolveInteractionChannel(client, guild, resolvedChannel('8', '0'));
  const second = resolveInteractionChannel(client, guild, resolvedChannel('1024', '2048'));

  assert.strictEqual(first.permissions.bitfield, 8n);
  assert.strictEqual(second.permissions.bitfield, 1024n);
  assert.strictEqual(second.appPermissions.bitfield, 2048n);
  assert.strictEqual(client.channels.cache.get('c1').permissions, null);
});

test('kenh khong co quyen trong resolved thi permissions la null', () => {
  const client = new Client({});
  const guild = makeGuild(client);

  const channel = resolveInteractionChannel(client, guild, resolvedChannel(undefined, undefined));

  assert.strictEqual(channel.permissions, null);
  assert.strictEqual(channel.appPermissions, null);
});
