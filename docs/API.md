**English** | [Tiếng Việt](./API.vi.md)

# API reference

This documents **only what this fork adds** on top of discord.js `14.28.1`.
Everything else — `Client`, `Message`, `Guild`, channels, builders, collectors —
is unchanged and documented at **[discord.js.dev](https://discord.js.dev)**.

The signatures below are the ones in
[`typings/index.d.ts`](../typings/index.d.ts), which is the source of truth. The
files they live in are the ones listed in the divergence table of
[`UPSTREAM.md`](../UPSTREAM.md).

## How to read the status column

| Status | Meaning                                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------- |
| tested | Exercised against a real account, logged in [`scripts/smoke/results.md`](../scripts/smoke/results.md) |
| unit   | Covered by offline tests in [`test/`](../test); never run against Discord                             |
| ported | Copied from `discord.js-selfbot-v13` and never run at all. Routes and constants may be stale          |

`tested` covers login, the whole read side (relationships, settings, sessions,
notes, profile fetching, billing, friend invites, authorized applications, the
application-command search route), the writes that can be undone in the same
session (account and per-guild settings, custom status, notes, friend nicknames,
friend invites, the three presence builders) and the message lifecycle: send,
fetch, edit, reply, react, typing, pin, file upload, collectors, WebEmbed and
delete.

Still `unit` or `ported`, so assume they can fail against today's Discord:
everything that joins a guild, sends an interaction, opens a voice connection, or
costs money. Profile edits (`setAboutMe`, `setPronouns`, `setGlobalName`,
`setAccentColor`) are also untested for a different reason — see
[section 8](#8-account-and-profile).

## Contents

[1. Client options](#1-client-options) ·
[2. Logging in](#2-logging-in) ·
[3. Relationships](#3-relationships) ·
[4. Sessions](#4-sessions) ·
[5. Notes](#5-notes) ·
[6. Settings](#6-settings) ·
[7. Billing and boosts](#7-billing-and-boosts) ·
[8. Account and profile](#8-account-and-profile) ·
[9. Group DMs and calls](#9-group-dms-and-calls) ·
[10. Presence](#10-presence) ·
[11. WebEmbed](#11-webembed) ·
[12. Interactions as a user](#12-interactions-as-a-user) ·
[13. Voice, video, Go Live](#13-voice-video-go-live) ·
[14. Events](#14-events) ·
[15. Utilities](#15-utilities)

---

## 1. Client options

Source: [`src/util/Options.js`](../src/util/Options.js),
[`src/util/SelfbotDefaults.js`](../src/util/SelfbotDefaults.js),
[`src/rest/SelfbotREST.js`](../src/rest/SelfbotREST.js) · Status: **unit**
(defaults `tested` through every login)

```ts
new Client({
  http?: {
    headers?: Record<string, string>;      // merged over the spoofed browser headers
    agent?: string | object | null;        // proxy: 'http://user:pass@host:port'
  };
  captchaSolver?: (captcha: CaptchaError, userAgent: string) => Promise<string>;
  captchaRetryLimit?: number;              // default 3
  autoAcceptAgreements?: boolean;          // default false
  ws?: {
    properties?: Record<string, unknown>;  // identify super-properties
    capabilities?: number;                 // default 161789
    client_state?: Record<string, unknown>;
  };
});
```

`intents` is optional and ignored — the user identify payload has no intents
field.

```js
const client = new Client({
  http: { agent: 'http://user:pass@1.2.3.4:8080' },
  captchaSolver: async captcha => solveWith2Captcha(captcha.captcha_sitekey),
});
```

`autoAcceptAgreements` accepts new Terms of Service on the account owner's
behalf, which is a legal act, so it is **off by default** (v13 did it silently).

> The defaults in `SelfbotDefaults.js` — `client_build_number`, `capabilities`,
> the user agent, the TLS cipher list — came from the v13 fork and are
> **unverified** against today's Discord. They are the first thing to check if
> logins start getting flagged.

Example: [`examples/Proxy.js`](../examples/Proxy.js)

---

## 2. Logging in

Source: [`src/client/ClientActions.js`](../src/client/ClientActions.js),
[`src/util/RemoteAuth.js`](../src/util/RemoteAuth.js),
[`src/util/totp.js`](../src/util/totp.js) · Status: **tested**

```ts
client.login(token: string): Promise<string>;
client.logout(): Promise<void>;
client.QRLogin(options?: { printQR?: boolean }): Promise<string>;
client.passLogin(login: string, password: string, options?: PassLoginOptions): Promise<string>;
client.sessionId: string | null;

interface PassLoginOptions {
  mfaSecret?: string | null;      // base32 secret, the code is generated for you
  mfaCode?: () => Promise<string>; // or supply the code yourself
  login?: boolean;                 // default true: log the client in with the token
}
```

```js
// QR code, scanned with the Discord mobile app
const token = await client.QRLogin({ printQR: true });

// Email and password, 2FA from a base32 secret
await client.passLogin('a@b.com', 'password', { mfaSecret: 'BASE32SECRET' });
```

`passLogin` is the riskiest path: Discord scrutinises password logins and
frequently answers with a captcha. Set `captchaSolver` before relying on it.

For the QR flow without a `Client`, use `RemoteAuth` directly:

```ts
class RemoteAuth extends EventEmitter {
  constructor(options?: { rest?: REST; createSocket?: (url: string) => unknown });
  fingerprint: string | null;
  user: RemoteAuthUser | null;
  expiresAt: Date | null;
  get qrCodeURL(): string | null;
  connect(client?: Client): Promise<string>;
  generateQR(): Promise<string>;
  destroy(): void;
}
```

Events: `ready`, `pending(user)`, `finish(token)`, `cancel`, `closed`,
`error(error)`, `debug(message)`.

Examples: [`examples/QRLogin.js`](../examples/QRLogin.js),
[`examples/PasswordLogin.js`](../examples/PasswordLogin.js)

---

## 3. Relationships

Source: [`src/managers/RelationshipManager.js`](../src/managers/RelationshipManager.js)
· Status: **tested** (read side, plus `setNickname` written and restored)

```ts
client.relationships: RelationshipManager;

class RelationshipManager {
  cache: Collection<Snowflake, number>;             // userId -> RelationshipType
  friendNicknames: Collection<Snowflake, string | null>;
  sinceCache: Collection<Snowflake, Date>;
  get friendCache(): Collection<Snowflake, User | undefined>;
  get blockedCache(): Collection<Snowflake, User | undefined>;
  get incomingCache(): Collection<Snowflake, User | undefined>;
  get outgoingCache(): Collection<Snowflake, User | undefined>;
  fetch(): Promise<this>;
  fetch(user: UserResolvable): Promise<number | undefined>;
  setNickname(user: UserResolvable, nickname?: string | null): Promise<boolean>;
  resolveId(user: UserResolvable): Snowflake | null;
  toJSON(): RelationshipJSONData[];
}
```

The caches are filled from `READY`, so they are populated before you call
`fetch()`.

```js
client.on('ready', () => {
  console.log(`${client.relationships.friendCache.size} friends`);
  console.log(`${client.relationships.blockedCache.size} blocked`);
});

await client.relationships.setNickname('123456789', 'Bob');
```

`RelationshipType`: `None: 0`, `Friend: 1`, `Blocked: 2`, `PendingIncoming: 3`,
`PendingOutgoing: 4`, `Implicit: 5`, `Suggestion: 6`.

> Sending, accepting and removing friend requests are **not implemented**. In
> v13 all four methods threw `'Risky action, not finished yet.'` on their first
> line, so there was nothing to port.

Friend invite links are on `ClientUser` — see [section 8](#8-account-and-profile).

---

## 4. Sessions

Source: [`src/managers/SessionManager.js`](../src/managers/SessionManager.js),
[`src/structures/Session.js`](../src/structures/Session.js) · Status: **tested**
(read side)

```ts
client.sessions: SessionManager;

class SessionManager {
  currentSessionIdHash: string | null;
  get currentSession(): Session | null;
  fetch(): Promise<Collection<string, Session>>;
  logoutAllDevices(): Promise<void>;
}

class Session {
  id: string;
  approxLastUsedTime: string;
  clientInfo: { location: string; platform: string; os: string };
  get lastUsedAt(): Date;
  get lastUsedTimestamp(): number;
  logout(): Promise<void>;
}
```

```js
const sessions = await client.sessions.fetch();
for (const s of sessions.values()) {
  console.log(s.clientInfo.os, s.clientInfo.location, s.lastUsedAt);
}
```

`session.createdAt` / `createdTimestamp` still work but are `@deprecated`: the
underlying value is `approx_last_used_time`, not a creation time.

---

## 5. Notes

Source: [`src/managers/UserNoteManager.js`](../src/managers/UserNoteManager.js)
· Status: **tested** (read side, plus `updateNote` written and restored)

```ts
client.notes: UserNoteManager;

class UserNoteManager {
  cache: Collection<Snowflake, string>;
  fetch(user: UserResolvable, options?: BaseFetchOptions): Promise<string>;
  updateNote(user: UserResolvable, note?: string | null): Promise<this>;
  resolveId(user: UserResolvable): Snowflake | null;
}
```

```js
await client.notes.fetch('123456789');
await client.notes.updateNote('123456789', 'met at the conference');
await client.notes.updateNote('123456789', null); // delete
```

---

## 6. Settings

Source: [`src/managers/ClientUserSettingManager.js`](../src/managers/ClientUserSettingManager.js),
[`src/managers/GuildSettingManager.js`](../src/managers/GuildSettingManager.js)
· Status: **tested** (read side, plus `setTheme`, `toggleCompactMode`,
`setCustomStatus`, `addRestrictedGuild`/`removeRestrictedGuild` and
`Guild#settings.edit` written and restored against a real account)

> **`client.settings` does not stay live.** Discord now pushes account settings as
> `USER_SETTINGS_PROTO_UPDATE`, a protobuf payload this fork does not decode; the
> JSON `USER_SETTINGS_UPDATE` handler it does have never fires. Change a setting on
> another device and this object keeps the old value until you call `fetch()` or
> `edit()`. Per-guild settings are unaffected — `USER_GUILD_SETTINGS_UPDATE` still
> arrives as JSON and is handled.

### Account settings

```ts
client.settings: ClientUserSettingManager;

class ClientUserSettingManager {
  get raw(): Record<string, unknown>;   // everything, including unmapped keys
  fetch(): Promise<this>;
  edit(data: Record<string, unknown>): Promise<this>;
  toggleCompactMode(): Promise<this>;
  setTheme(value: 'dark' | 'light'): Promise<this>;
  setCustomStatus(options: CustomStatus | CustomStatusOptions | null): Promise<this>;
  restrictedGuilds(status: boolean): Promise<this>;
  addRestrictedGuild(guild: GuildResolvable): Promise<this>;
  removeRestrictedGuild(guild: GuildResolvable): Promise<this>;
}
```

Read-only mapped fields: `locale`, `theme`, `activityDisplay`,
`allowDMsFromGuild`, `displayImage`, `linkedImageDisplay`, `autoplayGIF`,
`previewLink`, `animatedEmoji`, `allowTTS`, `compactMode`, `convertEmoticons`,
`DMScanLevel`, `developerMode`, `afkTimeout`, `stickerAnimationMode`,
`showEmojiReactions`, `customStatus`, `disableDMfromGuilds`. Anything not mapped
is still in `.raw`.

```js
await client.settings.fetch();
console.log(client.settings.theme, client.settings.locale);

await client.settings.setCustomStatus({ text: 'brb', emoji: '🕐', expires: Date.now() + 3.6e6 });
await client.settings.setCustomStatus(null); // clear
```

### Per-guild settings

```ts
guild.settings: GuildSettingManager;

class GuildSettingManager {
  guildId: Snowflake;
  muteConfig: { endTime: Date; selectedTimeWindow: number } | null;
  get raw(): Record<string, unknown>;
  get guild(): Guild | null;
  edit(data: Record<string, unknown>): Promise<this>;
}
```

Mapped fields: `suppressEveryone`, `suppressRoles`, `muteScheduledEvents`,
`messageNotifications`, `flags`, `mobilePush`, `muted`, `hideMutedChannels`,
`channelOverrides`, `notifyHighlights`, `version`.

Filled from the `user_guild_settings` block of `READY`, so it is available
without a fetch.

```js
const g = client.guilds.cache.get('123456789');
console.log(g.settings.muted, g.settings.messageNotifications);
await g.settings.edit({ muted: true });
```

---

## 7. Billing and boosts

Source: [`src/managers/BillingManager.js`](../src/managers/BillingManager.js),
[`src/structures/GuildBoost.js`](../src/structures/GuildBoost.js) · Status:
**tested** (all three fetches), **unit** (`subscribe`/`unsubscribe`)

```ts
client.billing: BillingManager;

class BillingManager {
  paymentSources: Collection<Snowflake, unknown>;
  guildBoosts: Collection<Snowflake, GuildBoost>;
  currentSubscription: Collection<Snowflake, unknown>;
  fetchPaymentSources(): Promise<Collection<Snowflake, unknown>>;
  fetchGuildBoosts(): Promise<Collection<Snowflake, GuildBoost>>;
  fetchCurrentSubscription(): Promise<Collection<Snowflake, unknown>>;
}

class GuildBoost {
  id: Snowflake;
  subscriptionId: Snowflake;
  canceled: boolean;
  cooldownEndsAt: Date | null;
  guildId: Snowflake | null;
  ended: boolean | null;
  get guild(): Guild | null;
  get used(): boolean;
  subscribe(guild: GuildResolvable): Promise<this>;
  unsubscribe(): Promise<this>;
}
```

```js
const boosts = await client.billing.fetchGuildBoosts();
const free = boosts.find(b => !b.used);
await free?.subscribe('123456789');
```

`boost.guild` was spelled `guilld` in v13, so that getter was unreachable. The
typo is not aliased.

Nitro codes are redeemed through `client.redeemNitro()` — see
[section 8](#8-account-and-profile).

---

## 8. Account and profile

Source: [`src/structures/ClientUserActions.js`](../src/structures/ClientUserActions.js),
[`src/client/ClientActions.js`](../src/client/ClientActions.js) · Status: **unit**,
except the friend-invite trio and `authorizedApplications()`, which are **tested**

> The four profile setters are **untested against a real account**.
> `PATCH /users/@me` answers with an hCaptcha challenge, so nothing lands unless
> the client is built with a [`captchaSolver`](#1-client-options). The library is
> behaving correctly here — it surfaces the `400` rather than pretending the edit
> worked — but the account is left unchanged.

> `fetchBurstCredit()` was **removed**. `GET /users/@me/burst-credits` answers a
> bare `404 code 0` on both API v9 and v10 — route gone, not a permission or Nitro
> problem (`/users/@me/premium-usage` on the same account answers a typed `10084`
> instead). No replacement route is known, so the method was deleted rather than
> left to always throw.

### Profile

```ts
client.user.setGlobalName(globalName?: string | null): Promise<this>;
client.user.setPronouns(pronouns?: string | null): Promise<this>;
client.user.setAboutMe(bio?: string | null): Promise<this>;
client.user.setAccentColor(color?: ColorResolvable | null): Promise<this>;
client.user.setHypeSquad(house: number | 'Leave' | 'Bravery' | 'Brilliance' | 'Balance'): Promise<void>;
client.user.setSamsungActivity(packageName: string, action?: 'START' | 'UPDATE' | 'STOP'): Promise<this>;
client.user.stopRinging(channel: ChannelResolvable): Promise<void>;
```

`client.user.edit()` also takes `password`, `bio`, `pronouns`, `globalName`,
`accentColor` on top of the upstream options. Changing the email, password or
username requires `password`.

```js
await client.user.setAboutMe('hello');
await client.user.setHypeSquad('Bravery');
```

### Friend invites

```ts
client.user.createFriendInvite(): Promise<Invite>;
client.user.fetchFriendInvites(): Promise<Collection<string, Invite>>;
client.user.revokeAllFriendInvites(): Promise<void>;
```

v13 called the middle one `getAllFriendInvites()`.

### Invites, apps, Nitro

```ts
client.acceptInvite(invite: InviteResolvable, options?: {
  bypassOnboarding?: boolean;
  bypassVerify?: boolean;
}): Promise<Guild | GroupDMChannel | null>;

client.redeemNitro(nitro: string, channel?: ChannelResolvable, paymentSourceId?: Snowflake): Promise<unknown>;
client.authorizeURL(url: string, options?: Record<string, unknown>): Promise<unknown>;
client.installUserApps(applicationId: Snowflake): Promise<unknown>;
client.authorizedApplications(): Promise<Collection<Snowflake, AuthorizedApplication>>;
client.deauthorize(id: Snowflake, type?: 'application' | 'token'): Promise<void>;
client.refreshAttachmentURL(...urls: string[]): Promise<RefreshedAttachmentURL[]>;
```

```js
await client.acceptInvite('https://discord.gg/abc123', { bypassOnboarding: true });

const apps = await client.authorizedApplications();
await apps.first()?.deauthorize();

// Attachment CDN links expire; this mints fresh ones
const [{ refreshed }] = await client.refreshAttachmentURL(oldUrl);
```

---

## 9. Group DMs and calls

Source: [`src/structures/GroupDMChannel.js`](../src/structures/GroupDMChannel.js),
[`src/structures/CallState.js`](../src/structures/CallState.js) · Status: **unit**

> **Tested** against a real account, with a second account for the parts that need
> one: `create`, `setName`, `setIcon`, `createInvite`, `fetchInvites`,
> `deleteInvite`, `delete`, `addUser`, `removeUser`, `fetchOwner`, `ring`,
> `stopRinging`, `CallState.setRTCRegion`, and the `channelRecipientAdd`,
> `channelRecipientRemove`, `callCreate`, `callUpdate`, `callDelete` events.
> `setOwner` and `edit({ owner })` remain **untested**: handing the group over
> cannot be undone.

> **`ring()` does not start a call.** With no call in progress Discord answers
> `{}` and nothing happens — no `CALL_CREATE`, nobody's phone rings. A call is
> created by sending a voice state update naming the channel, which is what the
> official client does when you press the call button; only then does `ring()` do
> anything. This fork has no method for that first step, so you have to send the
> gateway payload yourself:
>
> ```js
> client.ws.shards
>   .first()
>   .send({ op: 4, d: { guild_id: null, channel_id: groupDm.id, self_mute: true, self_deaf: true } });
> // wait for callCreate, then:
> await groupDm.ring();
> ```
>
> Hearing anything is a separate matter — the audio side goes through the voice
> gateway, which is blocked; see [section 13](#13-voice-video-go-live).

```ts
class GroupDMChannel extends BaseChannel {
  type: ChannelType.GroupDM;
  name: string | null;
  icon: string | null;
  ownerId: Snowflake | null;
  messages: PartialGroupDMMessageManager;
  get recipients(): Collection<Snowflake, User>;
  get owner(): User | null;
  iconURL(options?: ImageURLOptions): string | null;
  fetchOwner(options?: BaseFetchOptions): Promise<User>;
  edit(options: { name?; icon?; owner? }): Promise<this>;
  setName(name: string | null): Promise<this>;
  setIcon(icon: BufferResolvable | Base64Resolvable | null): Promise<this>;
  setOwner(user: UserResolvable): Promise<this>;
  addUser(user: UserResolvable): Promise<this>;
  removeUser(user: UserResolvable): Promise<this>;
  delete(silent?: boolean): Promise<this>;
  createInvite(maxAge?: number, maxUses?: number): Promise<Invite>;
  fetchInvites(): Promise<Collection<string, Invite>>;
  deleteInvite(invite: InviteResolvable): Promise<this>;
  ring(recipients?: readonly UserResolvable[]): Promise<this>;
  // plus send, sendTyping, createMessageCollector, awaitMessages
}
```

The v13 names `getInvite()`, `fetchAllInvite()` and `removeInvite()` became
`createInvite()`, `fetchInvites()` and `deleteInvite()`.

```js
const gdm = client.channels.cache.get('123456789');
await gdm.setName('the group');
await gdm.addUser('987654321');
await gdm.ring(); // ring everyone
await client.user.stopRinging(gdm);
```

Calls arrive as events, not a manager:

```ts
class CallState {
  channelId: Snowflake;
  region: string;
  get channel(): DMChannel | GroupDMChannel | null;
  get ringing(): Collection<Snowflake, User | null>;
  setRTCRegion(region: string): Promise<void>;
}
```

```js
client.on('callCreate', call => console.log('incoming', call.ringing.size));
```

Example: [`examples/GroupDM.js`](../examples/GroupDM.js)

---

## 10. Presence

Source: [`src/structures/RichPresence.js`](../src/structures/RichPresence.js),
[`src/structures/ClientPresence.js`](../src/structures/ClientPresence.js) ·
Status: **tested** — all three builders were broadcast on a real session without
the gateway dropping it. Presence has no acknowledgement, so what actually renders
on someone else's client is still unproven

All three builders are plain objects — they no longer take a `client`, unlike
v13. They share a base:

```ts
abstract class BaseActivityBuilder {
  name: string;
  type: ActivityType;
  toJSON(): Record<string, unknown>; // what you pass to setPresence()
  toString(): string;
}
```

### CustomStatus

```ts
class CustomStatus {
  constructor(data?: { state?: string | null; emoji?: EmojiIdentifierResolvable | null });
  setState(state: string | null): this;
  setEmoji(emoji: EmojiIdentifierResolvable | null): this;
}
```

```js
const status = new CustomStatus().setState('coding').setEmoji('💻');
client.user.setPresence({ activities: [status.toJSON()] });
```

For a status that persists and expires, use `client.settings.setCustomStatus()`
in [section 6](#6-settings) instead — presence is per-session, the setting is
per-account.

### RichPresence

```ts
class RichPresence {
  constructor(data?: Record<string, unknown>);
  setName(name: string | null): this;
  setType(type: ActivityType): this;
  setURL(url: string | null): this;
  setApplicationId(id: Snowflake | null): this;
  setState(state: string | null): this;
  setDetails(details: string | null): this;
  setPlatform(platform: string | null): this;
  setParty(party: { id?: string | null; size: number; max: number } | null): this;
  setStartTimestamp(timestamp: Date | number | null): this;
  setEndTimestamp(timestamp: Date | number | null): this;
  setAssetsLargeImage(image: string | null): this;
  setAssetsSmallImage(image: string | null): this;
  setAssetsLargeText(text: string | null): this;
  setAssetsSmallText(text: string | null): this;
  setJoinSecret(join: string | null): this;
  addButton(label: string, url: string): this;
  setButtons(...buttons: { label: string; url: string }[]): this;
  static getExternal(client: Client, applicationId: Snowflake, ...images: string[]): Promise<ExternalAsset[]>;
}
```

`getExternal()` uploads an arbitrary image URL to Discord's proxy and returns the
`external_asset_path` you then pass to `setAssetsLargeImage()`. Without it,
assets must be ones already registered on the application.

```js
const [asset] = await RichPresence.getExternal(client, '1234', 'https://i.imgur.com/x.png');
const rpc = new RichPresence()
  .setName('Some Game')
  .setType(ActivityType.Playing)
  .setDetails('level 3')
  .setAssetsLargeImage(asset.external_asset_path)
  .addButton('Website', 'https://example.com');

client.user.setPresence({ activities: [rpc.toJSON()] });
```

### SpotifyRPC

```ts
class SpotifyRPC extends RichPresence {
  setSongId(id: string): this;
  setAlbumId(id: string): this;
  addArtistId(id: string): this;
  setArtistIds(...ids: string[]): this;
}
```

> `SpotifyRPC` carries hardcoded flags and an application id from the v13 fork.
> **Unverified** against today's Discord.

Example: [`examples/RichPresence.js`](../examples/RichPresence.js)

---

## 11. WebEmbed

Source: [`src/structures/WebEmbed.js`](../src/structures/WebEmbed.js) · Status:
**tested** — a built link was sent to a real channel and Discord unfurled it into
an embed with the right title

User accounts cannot send real embeds. `WebEmbed` fakes one by building a link
that a rendering service turns into an OpenGraph preview, which Discord then
unfurls in the message.

```ts
class WebEmbed {
  constructor(data?: Record<string, unknown> & { baseURL?: string });
  setTitle(title: string): this;
  setDescription(description: string): this;
  setURL(url: string): this;
  setColor(color: ColorResolvable): this;
  setAuthor(options: { name: string; url?: string } | null): this;
  setProvider(options: { name: string; url?: string } | null): this;
  setImage(url: string): this;
  setThumbnail(url: string): this;
  setVideo(url: string): this;
  setRedirect(url: string): this;
  toString(): string; // the link you send
  static hiddenEmbed: string; // zero-width prefix that hides the raw link
  static DEFAULT_BASE_URL: string;
}
```

```js
const embed = new WebEmbed().setTitle('Hello').setColor('Red').setImage('https://i.imgur.com/x.png');
await channel.send(`${WebEmbed.hiddenEmbed}${embed}`);
```

The default `baseURL` is `https://webembed-sb.onrender.com/embed`, a
**third-party service** inherited from the v13 fork: every embed you build sends
your content through someone else's server, and it can disappear at any time.
Self-host it and pass `baseURL` if that matters.

Example: [`examples/WebEmbed.js`](../examples/WebEmbed.js)

---

## 12. Interactions as a user

Source: [`src/util/InteractionSender.js`](../src/util/InteractionSender.js),
[`src/structures/ChannelInteractionActions.js`](../src/structures/ChannelInteractionActions.js),
[`src/structures/MessageInteractionActions.js`](../src/structures/MessageInteractionActions.js)
· Status: **tested** for `searchApplicationCommands()` and `sendSlash()`;
`clickButton`, `selectMenu`, modal submit and attachment options are **unit**

> In a **guild** channel, `searchApplicationCommands()` reads the guild's command
> index rather than `/channels/:id/application-commands/search`. That search route
> answers `200` with an empty list for every guild channel — even in a guild with
> hundreds of commands, and regardless of `query`, `application_id` or API version —
> so building on it meant `sendSlash` could never find a command. DM and group DM
> channels still use the search route.

> `clickButton` and `selectMenu` are still unproven against a real bot: the reply
> the smoke suite got back carried no components. Point `SMOKE_INTERACTION_COMMAND`
> at a command whose answer has buttons to exercise them.

A user account cannot _receive_ interactions, but it can _send_ them: run
another bot's slash command, click its buttons, pick from its select menus.

On every text-capable channel:

```ts
channel.searchApplicationCommands(options?: {
  query?: string;
  limit?: number;
  applicationId?: Snowflake;
}): Promise<unknown>;

channel.sendSlash(bot: UserResolvable, commandName: string, ...args: unknown[]): Promise<Message | unknown>;
```

On `Message`:

```ts
message.clickButton(button: string | number, timeout?: number): Promise<Message | unknown>;
message.selectMenu(menu: string | number, values?: readonly string[], timeout?: number): Promise<Message | unknown>;
```

```js
// Subcommands go in the name, at most "command group subcommand"
await channel.sendSlash('botUserId', 'ping');
await channel.sendSlash('botUserId', 'role add', '@user', 'Admin');

const reply = await channel.sendSlash('botUserId', 'help');
await reply.clickButton('next_page'); // by customId
await reply.selectMenu(0, ['option_value']); // by index
```

`args` are positional, in the order Discord declares the options — there is no
name-based form. An option of type `Attachment` takes the file itself; it is
uploaded first and the index is sent in its place.

`clickButton` and `selectMenu` resolve when the bot's response arrives, or
reject after `timeout` (default 5000ms). They throw on a disabled component, and
on link buttons, which have no `custom_id` and cannot be clicked through the API.
A string select also accepts option **labels**, not just values.

File uploads inside an interaction go through
[`src/util/AttachmentUpload.js`](../src/util/AttachmentUpload.js):

```ts
requestUploadSlots(
  client: Client,
  channelId: Snowflake,
  files: readonly { name: string; data: Buffer | Uint8Array }[],
): Promise<UploadSlot[]>;
```

Example: [`examples/SlashCommand.js`](../examples/SlashCommand.js)

---

## 13. Voice, video, Go Live

Source: [`src/client/voice/`](../src/client/voice) · Status: **ported**

> **Voice works.** All five smoke checks pass against a real channel: join, play,
> open a receive stream, open a Go Live connection, leave.
>
> Getting there took two fixes. Discord has required end-to-end encryption on every
> non-stage voice call since March 2026 and answered the IDENTIFY with
> `4017 E2EE/DAVE protocol required`; the stack now wraps `@snazzah/davey` — the same
> native MLS binding `@discordjs/voice` uses — speaks DAVE's binary frames, runs the
> epoch and transition handshake, and encrypts audio end to end inside the existing
> transport encryption. Then came `4006 Session is no longer valid`, which turned out
> to be ours: the endpoint parser threw away the port, so a
> `c-hkg12-….discord.media:8443` from Discord became a connection to port 443 of a
> different voice process that had never heard of our session.
>
> Alone in a channel the DAVE group never reaches an epoch, so `session.ready` stays
> `false` and audio travels under transport encryption only — there is nobody else in
> the group to encrypt for.
>
> **`@snazzah/davey` is an `optionalDependency` and voice cannot work without it.**
> `npm i @snazzah/davey`. Missing it, `joinChannel` throws a sentence naming the
> package rather than letting you discover 4017 for yourself. Voice also needs two
> things the library deliberately does **not** bundle, because they are the
> consumer's choice: `ffmpeg` on `PATH`, and an Opus binding (`@discordjs/opus`, or
> `opusscript` if you cannot build native modules). `prism-media` picks whichever it
> finds.
>
> Video and Go Live are **not** end-to-end encrypted. Only audio is.

> This whole area was copied wholesale from the v13 fork and has **never been run
> against a real voice channel**. Every file loads and the pure parts are tested
> — the codec table, SDP construction, the bitfields, the spots where v13 used
> string enums and v14 uses numbers — but UDP, RTP packetisation, the voice
> gateway handshake and encryption can only be proven live. Treat this as
> "ported", not "working".

```ts
client.voice: ClientVoiceManager;

manager.joinChannel(channel, config?: {
  selfMute?: boolean;
  selfDeaf?: boolean;
  selfVideo?: boolean;
}): Promise<VoiceConnection>;

class VoiceConnection extends EventEmitter {
  receiver: VoiceReceiver;
  playAudio(resource, options?): AudioDispatcher;   // path, URL or stream
  playVideo(resource, options?): VideoDispatcher;
  createStreamConnection(): Promise<StreamConnection>;  // Go Live: start streaming
  joinStreamConnection(user: UserResolvable): Promise<StreamConnectionReadonly>;  // watch someone else
  setSpeaking(value): void;
  setVideoCodec(value): void;
  setVideoStatus(value): void;
  disconnect(): void;
}
```

`StreamConnection` is itself a `VoiceConnection`, so you play into it the same
way.

```js
const connection = await client.voice.joinChannel(channel, { selfDeaf: false });

const dispatcher = connection.playAudio('./music.mp3');
dispatcher.on('finish', () => console.log('done'));

const stream = await connection.createStreamConnection();
stream.playVideo('./video.mp4');
```

Receiving audio:

```js
const opusStream = connection.receiver.createStream(user, { mode: 'opus', end: 'silence' });
```

Who is talking:

```js
client.on('guildMemberSpeaking', (member, speaking) => {
  if (speaking.has('Speaking')) console.log(member.user.username);
});
```

`SpeakingBitField.Flags`: `Speaking: 1`, `Soundshare: 2`, `PrioritySpeaking: 4`.

Example: [`examples/Voice.js`](../examples/Voice.js)

---

## 14. Events

Source: [`src/util/Events.js`](../src/util/Events.js) · Status: mixed

On top of the upstream events:

| Event                      | Arguments                                              | Status |
| -------------------------- | ------------------------------------------------------ | ------ |
| `relationshipAdd`          | `(userId, shouldNotify)`                               | unit   |
| `relationshipRemove`       | `(userId, type, nickname)`                             | unit   |
| `relationshipUpdate`       | `(userId, oldData, newData)`                           | unit   |
| `userNoteUpdate`           | `(userId, oldNote, newNote)`                           | unit   |
| `callCreate`               | `(call: CallState)`                                    | unit   |
| `callUpdate`               | `(call: CallState)`                                    | unit   |
| `callDelete`               | `(call: CallState)`                                    | unit   |
| `channelRecipientAdd`      | `(channel: GroupDMChannel, user)`                      | unit   |
| `channelRecipientRemove`   | `(channel: GroupDMChannel, user)`                      | unit   |
| `interactionModalCreate`   | `(modal)`                                              | unit   |
| `userRequiredActionUpdate` | `(action, message)` — captcha, ToS, phone verification | unit   |
| `voiceChannelStatusUpdate` | `(oldChannel, newChannel)`                             | unit   |
| `applicationCommandCreate` | `(command: ApplicationCommand)`                        | unit   |
| `applicationCommandUpdate` | `(command: ApplicationCommand)`                        | unit   |
| `applicationCommandDelete` | `(command: ApplicationCommand)`                        | unit   |
| `guildMemberSpeaking`      | `(member, speaking: SpeakingBitField)`                 | ported |

`relationshipUpdate` old/new data is `{ type, nickname, since }`.

Watch `userRequiredActionUpdate` in anything long-running: it is how Discord
tells you the account has been gated behind a captcha or a new ToS.

---

## 15. Utilities

### TOTP

Source: [`src/util/totp.js`](../src/util/totp.js) · Status: **unit**

```ts
generateTOTP(secret: string, options?: { timestamp?: number; digits?: number; step?: number }): string;
decodeBase32(input: string): Buffer;
```

Used by `passLogin({ mfaSecret })`; exported so you can generate the code
yourself.

### Bitfields

Source: [`src/util/`](../src/util) · Status: **unit**

| Class                       | Flags                                                              |
| --------------------------- | ------------------------------------------------------------------ |
| `SpeakingBitField`          | `Speaking: 1`, `Soundshare: 2`, `PrioritySpeaking: 4`              |
| `PremiumUsageFlagsBitField` | `PremiumDiscriminator: 1`, `AnimatedAvatar: 2`, `ProfileBanner: 4` |
| `PurchasedFlagsBitField`    | `NitroClassic: 1`, `Nitro: 2`, `GuildBoost: 4`, `NitroBasic: 8`    |

### Enums

Source: [`src/util/UserEnums.js`](../src/util/UserEnums.js)

`RelationshipType`, `HypeSquadHouse` (`Leave: 0`, `Bravery: 1`, `Brilliance: 2`,
`Balance: 3`), `SamsungActivityAction` (`START`, `UPDATE`, `STOP`).

### Routes

Source: [`src/util/UserRoutes.js`](../src/util/UserRoutes.js) · Status: **ported**

```ts
UserRoutes: Record<string, (...args: string[]) => string>;
```

Every user-only endpoint this fork calls, as path builders. Exported so you can
hit something not wrapped yet:

```js
const { UserRoutes } = require('@trickstarcandina/discordjs-selfbot');
await client.rest.get(UserRoutes.settings());
```

> Most of these routes came from the v13 fork and are **unverified**. If a call
> 404s or returns 403 code `40001`, the route is probably bot-only or has moved.

---

## Not here

- **Anything upstream** — [discord.js.dev](https://discord.js.dev).
- **v13 → v14 differences** — [`MIGRATION.md`](../MIGRATION.md), including the
  compatibility layer, the codemod, and the names that silently changed meaning.
- **Which upstream files were patched and why** — [`UPSTREAM.md`](../UPSTREAM.md).
- **Sending friend requests, blocking, unfriending** — not implemented,
  see [section 3](#3-relationships).
