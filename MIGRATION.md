**English** | [Tiếng Việt](./MIGRATION.vi.md)

# Migrating from `discord.js-selfbot-v13`

This library is built on `discord.js@14.28.1`, replacing `discord.js-selfbot-v13`
(based on `discord.js@13.17.1`, archived).

The compatibility layer is **on by default**, so most old code runs unchanged.
This document lists exactly what does not, and how to fix it.

## Run the codemod first

```sh
# Preview, writes nothing
node scripts/codemod-v13-to-v14.mjs ../your-repo/src

# Apply
node scripts/codemod-v13-to-v14.mjs ../your-repo/src --write
```

It handles most of sections 1 and 2 below, and **reports** the cases it will not
guess at. It is a regex-based aid, not a verifier — read the diff before you
commit.

## 1. String comparisons on the read side

This is the widest-reaching change, and the one the compatibility layer **cannot**
paper over.

```js
// v13
if (channel.type === 'GUILD_TEXT') {
}

// v14
const { ChannelType } = require('discord-api-types/v10');
if (channel.type === ChannelType.GuildText) {
}
```

In v14 `channel.type` returns a **number**. Keeping the strings would mean forcing
all of discord.js internals back to string enums — 99 `ChannelType` sites across
18 files, 84 `AuditLogEvent`, 70 `MessageType`. That forfeits the ability to merge
upstream fixes, which is the whole reason to move to v14.

The same applies to every enum: `type`, `style`, `verificationLevel`,
`premiumTier`, `nsfwLevel`, `status`, `privacyLevel`, `entityType`,
`membershipState`, and so on.

For the smallest diff, the v13-shaped `Constants` object is still there:

```js
const { Constants } = require('@trickstarcandina/discordjs-selfbot');
if (channel.type === Constants.ChannelTypes.GUILD_TEXT) {
}
```

## 2. Names that exist in both versions but mean different things

These cannot be aliased, because in v14 the names already mean something else.
Using the old name is **actually broken**, not merely outdated.

| Name                    | In v13                    | In v14                                 | Change to                     |
| ----------------------- | ------------------------- | -------------------------------------- | ----------------------------- |
| `TextInputComponent`    | text input builder        | submitted text input model             | `TextInputBuilder`            |
| `CommandInteraction`    | slash command interaction | base class of all command interactions | `ChatInputCommandInteraction` |
| `SelectMenuInteraction` | select menu interaction   | base class of all select menus         | `StringSelectMenuInteraction` |
| `MessageFlags`          | BitField class            | API enum                               | `MessageFlagsBitField`        |
| `UserFlags`             | BitField class            | API enum                               | `UserFlagsBitField`           |
| `ActivityFlags`         | BitField class            | API enum                               | `ActivityFlagsBitField`       |
| `ApplicationFlags`      | BitField class            | API enum                               | `ApplicationFlagsBitField`    |
| `ChannelFlags`          | BitField class            | API enum                               | `ChannelFlagsBitField`        |
| `GuildMemberFlags`      | BitField class            | API enum                               | `GuildMemberFlagsBitField`    |
| `RoleFlags`             | BitField class            | API enum                               | `RoleFlagsBitField`           |
| `AttachmentFlags`       | BitField class            | API enum                               | `AttachmentFlagsBitField`     |
| `ThreadMemberFlags`     | BitField class            | API enum                               | `ThreadMemberFlagsBitField`   |

## 3. What works as-is

### Class names

`MessageEmbed`, `MessageAttachment`, `MessageActionRow`, `MessageButton`,
`MessageSelectMenu`, `MessageSelectOption`, `Modal`, `Channel`,
`BaseCommandInteraction`, `ContextMenuInteraction`, `Permissions`, `Intents`,
`SystemChannelFlags` — all are aliases pointing straight at the v14 class, so
`instanceof` holds in both directions.

### Permission and flag names

```js
// Both spellings work
channel.permissionsFor(member).has('SEND_MESSAGES');
channel.permissionsFor(member).has('SendMessages');
new Permissions(['SEND_MESSAGES', 'ManageGuild']);
```

Including the ones that were renamed outright: `MANAGE_EMOJIS_AND_STICKERS`,
`USE_PUBLIC_THREADS`, `USE_PRIVATE_THREADS`, `START_EMBEDDED_ACTIVITIES`,
`USE_VAD`.

Note that `toArray()` returns **v14-style names**. Code comparing the result of
`toArray()` against v13 strings still has to change.

### Enum strings on the write side

Accepted at these call sites:

- `guild.channels.create()` / `.edit()` — `type`, `videoQualityMode`
- `client.guilds.create()` and `guild.edit()` — `verificationLevel`,
  `defaultMessageNotifications`, `explicitContentFilter`
- `guild.scheduledEvents.create()` / `.edit()` — `privacyLevel`, `entityType`, `status`
- `guild.stageInstances.create()` / `.edit()` — `privacyLevel`
- `client.user.setActivity()` / `setPresence()` — activity `type`

Anything outside this list is not covered. A string that cannot be translated is
passed through to the API so the API reports the error, rather than being turned
into `undefined`.

### Renamed methods

`embed.addField(name, value, inline)`, `channel.isText()` and `channel.isVoice()`
still work.

## 4. Selfbot-specific changes

| v13                                | Here                              | Why                                                                                                    |
| ---------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `session.createdAt`                | `session.lastUsedAt`              | The value is `approx_last_used_time`, not a creation time. The old name stays as a `@deprecated` alias |
| `boost.guilld`                     | `boost.guild`                     | v13 had a typo, so that getter was unreachable                                                         |
| `clientUser.getAllFriendInvites()` | `clientUser.fetchFriendInvites()` | Follows the discord.js `fetch*` convention                                                             |
| `new CustomStatus(client)`         | `new CustomStatus()`              | No longer extends `Activity`, so `client` is unnecessary                                               |
| `new RichPresence(client)`         | `new RichPresence()`              | Same                                                                                                   |
| `channel.getInvite()`              | `channel.createInvite()`          | It creates an invite, it does not get one                                                              |
| `channel.fetchAllInvite()`         | `channel.fetchInvites()`          | Follows the discord.js plural convention                                                               |
| `channel.removeInvite()`           | `channel.deleteInvite()`          | Follows the `delete*` convention                                                                       |

### Dropped, not ported

`relationship.sendFriendRequest()`, `.addFriend()`, `.addBlocked()` and
`.deleteRelationship()` — all four threw on their first line in v13
(`'Risky action, not finished yet.'`), so porting them would only copy dead code.

## 5. TypeScript

`intents` is no longer required:

```ts
const client = new Client({}); // valid
```

The whole selfbot surface is typed: `client.relationships`, `.settings`,
`.sessions`, `.notes`, `.billing`, along with `WebEmbed`, `CustomStatus`,
`RichPresence`, `SpotifyRPC`, `Session`, `CallState` and `GuildBoost`.

## 6. Logging in

Besides a token, there are now two more ways:

```js
// Scan a QR code with the Discord mobile app
await client.QRLogin();

// Email and password, generating the 2FA code from a base32 secret
await client.passLogin('a@b.com', 'password', { mfaSecret: 'BASE32SECRET' });
```

`passLogin` is riskier than using a token: Discord scrutinises password logins and
often blocks them with a captcha. Configure `captchaSolver` first if you need it.
