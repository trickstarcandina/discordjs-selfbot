[English](./API.md) | **Tiếng Việt**

# Tham chiếu API

Tài liệu này **chỉ mô tả phần fork thêm vào** discord.js `14.28.1`. Mọi thứ còn
lại — `Client`, `Message`, `Guild`, channel, builder, collector — giữ nguyên và
đã có tài liệu tại **[discord.js.dev](https://discord.js.dev)**.

Chữ ký bên dưới lấy từ [`typings/index.d.ts`](../typings/index.d.ts), đó là nguồn
sự thật. Các file chứa chúng nằm trong bảng lệch của
[`UPSTREAM.vi.md`](../UPSTREAM.vi.md).

## Đọc cột trạng thái thế nào

| Trạng thái | Nghĩa                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------- |
| tested     | Đã chạy với tài khoản thật, ghi log tại [`scripts/smoke/results.md`](../scripts/smoke/results.md) |
| unit       | Có test offline trong [`test/`](../test); chưa bao giờ chạy với Discord thật                      |
| ported     | Chép từ `discord.js-selfbot-v13`, chưa chạy lần nào. Route và hằng số có thể đã cũ                |

`tested` gồm đăng nhập, toàn bộ phía đọc (relationships, settings, sessions,
notes, fetch profile, thanh toán, lời mời kết bạn, application đã cấp quyền,
route tìm application command), những thao tác ghi trả lại được ngay trong cùng
phiên (setting tài khoản và setting theo guild, custom status, note, nickname bạn
bè, lời mời kết bạn, ba builder presence) và vòng đời tin nhắn: gửi, fetch, sửa,
trả lời, reaction, typing, ghim, đính kèm file, collector, WebEmbed và xoá.

Vẫn là `unit` hoặc `ported`, nên coi như có thể hỏng với Discord hiện tại: mọi thứ
vào guild, gửi interaction, mở kết nối voice, hoặc mất tiền. Bốn hàm sửa hồ sơ
(`setAboutMe`, `setPronouns`, `setGlobalName`, `setAccentColor`) cũng chưa test
được, vì một lý do khác — xem [mục 8](#8-tài-khoản-và-hồ-sơ).

## Mục lục

[1. Tuỳ chọn Client](#1-tuỳ-chọn-client) ·
[2. Đăng nhập](#2-đăng-nhập) ·
[3. Quan hệ bạn bè](#3-quan-hệ-bạn-bè) ·
[4. Phiên đăng nhập](#4-phiên-đăng-nhập) ·
[5. Ghi chú](#5-ghi-chú) ·
[6. Cài đặt](#6-cài-đặt) ·
[7. Thanh toán và boost](#7-thanh-toán-và-boost) ·
[8. Tài khoản và hồ sơ](#8-tài-khoản-và-hồ-sơ) ·
[9. Group DM và cuộc gọi](#9-group-dm-và-cuộc-gọi) ·
[10. Trạng thái hiển thị](#10-trạng-thái-hiển-thị) ·
[11. WebEmbed](#11-webembed) ·
[12. Gửi interaction như user](#12-gửi-interaction-như-user) ·
[13. Voice, video, Go Live](#13-voice-video-go-live) ·
[14. Sự kiện](#14-sự-kiện) ·
[15. Tiện ích](#15-tiện-ích)

---

## 1. Tuỳ chọn Client

Nguồn: [`src/util/Options.js`](../src/util/Options.js),
[`src/util/SelfbotDefaults.js`](../src/util/SelfbotDefaults.js),
[`src/rest/SelfbotREST.js`](../src/rest/SelfbotREST.js) · Trạng thái: **unit**
(giá trị mặc định thì `tested` qua mọi lần đăng nhập)

```ts
new Client({
  http?: {
    headers?: Record<string, string>;      // trộn đè lên header giả lập trình duyệt
    agent?: string | object | null;        // proxy: 'http://user:pass@host:port'
  };
  captchaSolver?: (captcha: CaptchaError, userAgent: string) => Promise<string>;
  captchaRetryLimit?: number;              // mặc định 3
  autoAcceptAgreements?: boolean;          // mặc định false
  ws?: {
    properties?: Record<string, unknown>;  // super-properties trong identify
    capabilities?: number;                 // mặc định 161789
    client_state?: Record<string, unknown>;
  };
});
```

`intents` là tuỳ chọn và bị bỏ qua — payload identify của user account không có
trường intents.

```js
const client = new Client({
  http: { agent: 'http://user:pass@1.2.3.4:8080' },
  captchaSolver: async captcha => solveWith2Captcha(captcha.captcha_sitekey),
});
```

`autoAcceptAgreements` tự chấp nhận Điều khoản dịch vụ mới nhân danh chủ tài
khoản — đó là hành động pháp lý, nên **mặc định tắt** (bản v13 làm im lặng).

> Các giá trị mặc định trong `SelfbotDefaults.js` — `client_build_number`,
> `capabilities`, user agent, danh sách cipher TLS — lấy từ bản v13 và **chưa
> được kiểm chứng** với Discord hiện tại. Nếu tài khoản bắt đầu bị gắn cờ, đây là
> chỗ kiểm tra đầu tiên.

Ví dụ: [`examples/Proxy.js`](../examples/Proxy.js)

---

## 2. Đăng nhập

Nguồn: [`src/client/ClientActions.js`](../src/client/ClientActions.js),
[`src/util/RemoteAuth.js`](../src/util/RemoteAuth.js),
[`src/util/totp.js`](../src/util/totp.js) · Trạng thái: **tested**

```ts
client.login(token: string): Promise<string>;
client.logout(): Promise<void>;
client.QRLogin(options?: { printQR?: boolean }): Promise<string>;
client.passLogin(login: string, password: string, options?: PassLoginOptions): Promise<string>;
client.sessionId: string | null;

interface PassLoginOptions {
  mfaSecret?: string | null;       // secret base32, mã 2FA được sinh giúp
  mfaCode?: () => Promise<string>; // hoặc tự cấp mã
  login?: boolean;                 // mặc định true: đăng nhập luôn bằng token vừa lấy
}
```

```js
// Quét mã QR bằng app Discord trên điện thoại
const token = await client.QRLogin({ printQR: true });

// Email + mật khẩu, 2FA sinh từ secret base32
await client.passLogin('a@b.com', 'password', { mfaSecret: 'BASE32SECRET' });
```

`passLogin` rủi ro nhất: Discord soi kỹ đăng nhập bằng mật khẩu và hay trả về
captcha. Cấu hình `captchaSolver` trước khi dựa vào nó.

Muốn luồng QR mà không cần `Client`, dùng thẳng `RemoteAuth`:

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

Sự kiện: `ready`, `pending(user)`, `finish(token)`, `cancel`, `closed`,
`error(error)`, `debug(message)`.

Ví dụ: [`examples/QRLogin.js`](../examples/QRLogin.js),
[`examples/PasswordLogin.js`](../examples/PasswordLogin.js)

---

## 3. Quan hệ bạn bè

Nguồn: [`src/managers/RelationshipManager.js`](../src/managers/RelationshipManager.js)
· Trạng thái: **tested** (phía đọc, thêm `setNickname` đã ghi rồi trả lại)

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

Cache được nạp từ `READY`, nên đã có dữ liệu trước khi gọi `fetch()`.

```js
client.on('ready', () => {
  console.log(`${client.relationships.friendCache.size} bạn bè`);
  console.log(`${client.relationships.blockedCache.size} đã chặn`);
});

await client.relationships.setNickname('123456789', 'Bob');
```

`RelationshipType`: `None: 0`, `Friend: 1`, `Blocked: 2`, `PendingIncoming: 3`,
`PendingOutgoing: 4`, `Implicit: 5`, `Suggestion: 6`.

> Gửi, chấp nhận, xoá lời mời kết bạn **không được cài đặt**. Ở v13 cả bốn
> method đều ném `'Risky action, not finished yet.'` ngay dòng đầu, nên không có
> gì để port.

Link mời kết bạn nằm ở `ClientUser` — xem [mục 8](#8-tài-khoản-và-hồ-sơ).

---

## 4. Phiên đăng nhập

Nguồn: [`src/managers/SessionManager.js`](../src/managers/SessionManager.js),
[`src/structures/Session.js`](../src/structures/Session.js) · Trạng thái:
**tested** (phía đọc)

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

`session.createdAt` / `createdTimestamp` vẫn chạy nhưng `@deprecated`: giá trị
thật là `approx_last_used_time`, không phải thời điểm tạo.

---

## 5. Ghi chú

Nguồn: [`src/managers/UserNoteManager.js`](../src/managers/UserNoteManager.js)
· Trạng thái: **tested** (phía đọc, thêm `updateNote` đã ghi rồi trả lại)

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
await client.notes.updateNote('123456789', 'gặp ở hội thảo');
await client.notes.updateNote('123456789', null); // xoá
```

---

## 6. Cài đặt

Nguồn: [`src/managers/ClientUserSettingManager.js`](../src/managers/ClientUserSettingManager.js),
[`src/managers/GuildSettingManager.js`](../src/managers/GuildSettingManager.js)
· Trạng thái: **tested** (phía đọc, thêm `setTheme`, `toggleCompactMode`,
`setCustomStatus`, `addRestrictedGuild`/`removeRestrictedGuild` và
`Guild#settings.edit` đã ghi rồi trả lại trên tài khoản thật)

> **`client.settings` không tự tươi lại.** Discord giờ đẩy setting tài khoản dưới
> dạng `USER_SETTINGS_PROTO_UPDATE` (protobuf) mà fork không giải mã; handler
> `USER_SETTINGS_UPDATE` dạng JSON đang có thì không bao giờ bắn. Đổi setting ở
> thiết bị khác thì object này vẫn giữ giá trị cũ cho tới khi bạn gọi `fetch()`
> hoặc `edit()`. Setting theo guild không bị ảnh hưởng —
> `USER_GUILD_SETTINGS_UPDATE` vẫn về dạng JSON và vẫn được xử lý.

### Cài đặt tài khoản

```ts
client.settings: ClientUserSettingManager;

class ClientUserSettingManager {
  get raw(): Record<string, unknown>;   // toàn bộ, kể cả key chưa map
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

Trường chỉ đọc đã map: `locale`, `theme`, `activityDisplay`,
`allowDMsFromGuild`, `displayImage`, `linkedImageDisplay`, `autoplayGIF`,
`previewLink`, `animatedEmoji`, `allowTTS`, `compactMode`, `convertEmoticons`,
`DMScanLevel`, `developerMode`, `afkTimeout`, `stickerAnimationMode`,
`showEmojiReactions`, `customStatus`, `disableDMfromGuilds`. Thứ chưa map vẫn nằm
trong `.raw`.

```js
await client.settings.fetch();
console.log(client.settings.theme, client.settings.locale);

await client.settings.setCustomStatus({ text: 'brb', emoji: '🕐', expires: Date.now() + 3.6e6 });
await client.settings.setCustomStatus(null); // xoá
```

### Cài đặt theo từng guild

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

Trường đã map: `suppressEveryone`, `suppressRoles`, `muteScheduledEvents`,
`messageNotifications`, `flags`, `mobilePush`, `muted`, `hideMutedChannels`,
`channelOverrides`, `notifyHighlights`, `version`.

Nạp từ khối `user_guild_settings` trong `READY`, nên có sẵn không cần fetch.

```js
const g = client.guilds.cache.get('123456789');
console.log(g.settings.muted, g.settings.messageNotifications);
await g.settings.edit({ muted: true });
```

---

## 7. Thanh toán và boost

Nguồn: [`src/managers/BillingManager.js`](../src/managers/BillingManager.js),
[`src/structures/GuildBoost.js`](../src/structures/GuildBoost.js) · Trạng thái:
**tested** (cả ba hàm fetch), **unit** (`subscribe`/`unsubscribe`)

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

`boost.guild` ở v13 viết nhầm thành `guilld` nên getter đó không bao giờ gọi
được. Lỗi chính tả này không được alias.

Đổi mã Nitro thì dùng `client.redeemNitro()` — xem
[mục 8](#8-tài-khoản-và-hồ-sơ).

---

## 8. Tài khoản và hồ sơ

Nguồn: [`src/structures/ClientUserActions.js`](../src/structures/ClientUserActions.js),
[`src/client/ClientActions.js`](../src/client/ClientActions.js) · Trạng thái:
**unit**, trừ bộ ba lời mời kết bạn và `authorizedApplications()` là **tested**

> Bốn hàm sửa hồ sơ **chưa test được trên tài khoản thật**. `PATCH /users/@me` trả
> về thử thách hCaptcha, nên không ghi được gì trừ khi client có
> [`captchaSolver`](#1-tuỳ-chọn-client). Thư viện xử lý đúng — nó ném `400` ra
> ngoài chứ không giả vờ là đã sửa xong — nhưng tài khoản thì không đổi.

> `fetchBurstCredit()` đã bị **xoá**. `GET /users/@me/burst-credits` trả `404 code 0`
> trơn trên cả API v9 lẫn v10 — route không còn, không phải vấn đề quyền hay Nitro
> (`/users/@me/premium-usage` trên cùng tài khoản trả lỗi có mã `10084`). Không biết
> route thay thế, nên xoá hẳn thay vì để một hàm luôn ném lỗi.

### Hồ sơ

```ts
client.user.setGlobalName(globalName?: string | null): Promise<this>;
client.user.setPronouns(pronouns?: string | null): Promise<this>;
client.user.setAboutMe(bio?: string | null): Promise<this>;
client.user.setAccentColor(color?: ColorResolvable | null): Promise<this>;
client.user.setHypeSquad(house: number | 'Leave' | 'Bravery' | 'Brilliance' | 'Balance'): Promise<void>;
client.user.setSamsungActivity(packageName: string, action?: 'START' | 'UPDATE' | 'STOP'): Promise<this>;
client.user.stopRinging(channel: ChannelResolvable): Promise<void>;
```

`client.user.edit()` nhận thêm `password`, `bio`, `pronouns`, `globalName`,
`accentColor` ngoài các option của upstream. Đổi email, mật khẩu hay username
thì bắt buộc có `password`.

```js
await client.user.setAboutMe('xin chào');
await client.user.setHypeSquad('Bravery');
```

### Link mời kết bạn

```ts
client.user.createFriendInvite(): Promise<Invite>;
client.user.fetchFriendInvites(): Promise<Collection<string, Invite>>;
client.user.revokeAllFriendInvites(): Promise<void>;
```

v13 gọi cái ở giữa là `getAllFriendInvites()`.

### Lời mời, ứng dụng, Nitro

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

// Link CDN của attachment sẽ hết hạn; hàm này lấy link mới
const [{ refreshed }] = await client.refreshAttachmentURL(oldUrl);
```

---

## 9. Group DM và cuộc gọi

Nguồn: [`src/structures/GroupDMChannel.js`](../src/structures/GroupDMChannel.js),
[`src/structures/CallState.js`](../src/structures/CallState.js) · Trạng thái:
**unit**

> **Đã test** với tài khoản thật, kèm một account thứ hai cho phần cần người khác:
> `create`, `setName`, `setIcon`, `createInvite`, `fetchInvites`, `deleteInvite`,
> `delete`, `addUser`, `removeUser`, `fetchOwner`, `ring`, `stopRinging`,
> `CallState.setRTCRegion`, và các event `channelRecipientAdd`,
> `channelRecipientRemove`, `callCreate`, `callUpdate`, `callDelete`. Riêng
> `setOwner` và `edit({ owner })` vẫn **chưa test**: nhường quyền chủ nhóm không
> lấy lại được.

> **`ring()` không tạo được cuộc gọi.** Không có cuộc gọi nào đang chạy thì Discord
> trả `{}` và không xảy ra gì cả — không `CALL_CREATE`, không ai đổ chuông. Cuộc
> gọi sinh ra khi gửi voice state update trỏ vào kênh, đúng thứ client chính thức
> làm khi bạn bấm nút gọi; sau đó `ring()` mới có tác dụng. Fork không có method
> cho bước đầu tiên đó, nên phải tự gửi payload gateway:
>
> ```js
> client.ws.shards
>   .first()
>   .send({ op: 4, d: { guild_id: null, channel_id: groupDm.id, self_mute: true, self_deaf: true } });
> // đợi callCreate, rồi:
> await groupDm.ring();
> ```
>
> Nghe được tiếng lại là chuyện khác — phần âm thanh đi qua voice gateway và đang
> bị chặn, xem [mục 13](#13-voice-video-go-live).

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
  // cùng send, sendTyping, createMessageCollector, awaitMessages
}
```

Tên cũ của v13 `getInvite()`, `fetchAllInvite()`, `removeInvite()` đổi thành
`createInvite()`, `fetchInvites()`, `deleteInvite()`.

```js
const gdm = client.channels.cache.get('123456789');
await gdm.setName('nhóm chat');
await gdm.addUser('987654321');
await gdm.ring(); // gọi tất cả
await client.user.stopRinging(gdm);
```

Cuộc gọi đến qua sự kiện, không có manager riêng:

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
client.on('callCreate', call => console.log('có cuộc gọi', call.ringing.size));
```

Ví dụ: [`examples/GroupDM.js`](../examples/GroupDM.js)

---

## 10. Trạng thái hiển thị

Nguồn: [`src/structures/RichPresence.js`](../src/structures/RichPresence.js),
[`src/structures/ClientPresence.js`](../src/structures/ClientPresence.js) ·
Trạng thái: **tested** — cả ba builder đã phát trên phiên thật mà gateway không
ngắt. Presence không có ack, nên hiển thị thực tế trên máy người khác vẫn chưa
chứng minh được

Cả ba builder giờ là object thuần — không còn nhận `client` như v13. Chúng dùng
chung một lớp cơ sở:

```ts
abstract class BaseActivityBuilder {
  name: string;
  type: ActivityType;
  toJSON(): Record<string, unknown>; // thứ truyền vào setPresence()
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
const status = new CustomStatus().setState('đang code').setEmoji('💻');
client.user.setPresence({ activities: [status.toJSON()] });
```

Muốn trạng thái tồn tại lâu và tự hết hạn thì dùng
`client.settings.setCustomStatus()` ở [mục 6](#6-cài-đặt): presence gắn với
phiên, còn setting gắn với tài khoản.

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

`getExternal()` đẩy một URL ảnh bất kỳ lên proxy của Discord và trả về
`external_asset_path` để truyền vào `setAssetsLargeImage()`. Không có nó thì
asset phải là ảnh đã đăng ký sẵn trên application.

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

> `SpotifyRPC` mang flags và application id hardcode từ bản v13, **chưa kiểm
> chứng** với Discord hiện tại.

Ví dụ: [`examples/RichPresence.js`](../examples/RichPresence.js)

---

## 11. WebEmbed

Nguồn: [`src/structures/WebEmbed.js`](../src/structures/WebEmbed.js) · Trạng
thái: **tested** — link dựng ra đã gửi lên kênh thật và Discord unfurl thành
embed đúng tiêu đề

User account không gửi được embed thật. `WebEmbed` giả lập bằng cách dựng một
link mà dịch vụ render biến thành OpenGraph preview, rồi Discord tự bung ra trong
tin nhắn.

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
  toString(): string; // link để gửi đi
  static hiddenEmbed: string; // tiền tố zero-width để giấu link thô
  static DEFAULT_BASE_URL: string;
}
```

```js
const embed = new WebEmbed().setTitle('Hello').setColor('Red').setImage('https://i.imgur.com/x.png');
await channel.send(`${WebEmbed.hiddenEmbed}${embed}`);
```

`baseURL` mặc định là `https://webembed-sb.onrender.com/embed`, **dịch vụ bên thứ
ba** thừa kế từ bản v13: mỗi embed dựng ra là một lần nội dung của bạn đi qua
server của người khác, và nó có thể biến mất bất cứ lúc nào. Nếu bận tâm thì tự
host rồi truyền `baseURL`.

Ví dụ: [`examples/WebEmbed.js`](../examples/WebEmbed.js)

---

## 12. Gửi interaction như user

Nguồn: [`src/util/InteractionSender.js`](../src/util/InteractionSender.js),
[`src/structures/ChannelInteractionActions.js`](../src/structures/ChannelInteractionActions.js),
[`src/structures/MessageInteractionActions.js`](../src/structures/MessageInteractionActions.js)
· Trạng thái: **tested** cho `searchApplicationCommands()` và `sendSlash()`;
`clickButton`, `selectMenu`, modal submit, option kiểu attachment vẫn là **unit**

> Với kênh trong **guild**, `searchApplicationCommands()` đọc index lệnh của guild
> chứ không dùng `/channels/:id/application-commands/search`. Route search đó trả
> `200` kèm danh sách rỗng ở mọi kênh guild — kể cả guild có hàng trăm lệnh, bất kể
> `query`, `application_id` hay version API — nên xây trên nó thì `sendSlash` không
> bao giờ tìm thấy lệnh. Kênh DM và group DM vẫn đi route search.

> `clickButton` và `selectMenu` vẫn chưa chứng minh được với bot thật: câu trả lời
> bộ smoke nhận về không có component nào. Trỏ `SMOKE_INTERACTION_COMMAND` vào một
> lệnh mà bot trả về kèm nút để thử chúng.

User account không _nhận_ được interaction, nhưng _gửi_ được: chạy slash command
của bot khác, bấm nút, chọn select menu của nó.

Trên mọi channel gửi được text:

```ts
channel.searchApplicationCommands(options?: {
  query?: string;
  limit?: number;
  applicationId?: Snowflake;
}): Promise<unknown>;

channel.sendSlash(bot: UserResolvable, commandName: string, ...args: unknown[]): Promise<Message | unknown>;
```

Trên `Message`:

```ts
message.clickButton(button: string | number, timeout?: number): Promise<Message | unknown>;
message.selectMenu(menu: string | number, values?: readonly string[], timeout?: number): Promise<Message | unknown>;
```

```js
// Subcommand viết luôn trong tên, tối đa "command group subcommand"
await channel.sendSlash('botUserId', 'ping');
await channel.sendSlash('botUserId', 'role add', '@user', 'Admin');

const reply = await channel.sendSlash('botUserId', 'help');
await reply.clickButton('next_page'); // theo customId
await reply.selectMenu(0, ['option_value']); // theo chỉ số
```

`args` truyền theo vị trí, đúng thứ tự Discord khai báo option — không có dạng
truyền theo tên. Option kiểu `Attachment` nhận thẳng file; file được upload trước
rồi gửi chỉ số thay cho nó.

`clickButton` và `selectMenu` resolve khi bot trả lời, hoặc reject sau `timeout`
(mặc định 5000ms). Chúng ném lỗi với component đang disabled, và với link button
— loại này không có `custom_id` nên không bấm được qua API. String select nhận cả
**label**, không chỉ value.

Upload file trong interaction đi qua
[`src/util/AttachmentUpload.js`](../src/util/AttachmentUpload.js):

```ts
requestUploadSlots(
  client: Client,
  channelId: Snowflake,
  files: readonly { name: string; data: Buffer | Uint8Array }[],
): Promise<UploadSlot[]>;
```

Ví dụ: [`examples/SlashCommand.js`](../examples/SlashCommand.js)

---

## 13. Voice, video, Go Live

Nguồn: [`src/client/voice/`](../src/client/voice) · Trạng thái: **ported**

> **Voice chạy được.** Cả năm check smoke đều pass với kênh thật: vào kênh, phát,
> mở stream nhận, mở kết nối Go Live, rời kênh.
>
> Để tới đây phải sửa hai chỗ. Từ tháng 3/2026 Discord bắt buộc mã hoá đầu cuối cho
> mọi voice call không phải stage, và trả lời IDENTIFY bằng
> `4017 E2EE/DAVE protocol required`; stack giờ bọc `@snazzah/davey`, đúng binding
> MLS native mà `@discordjs/voice` dùng, nói được frame nhị phân của DAVE, chạy đủ
> bắt tay epoch và transition, và mã hoá đầu cuối audio **bên trong** lớp mã hoá
> transport sẵn có. Sau đó tới `4006 Session is no longer valid`, và cái này là lỗi
> của lib: chỗ parse endpoint cắt mất cổng, nên
> `c-hkg12-….discord.media:8443` Discord trả về biến thành kết nối vào cổng 443 của
> một tiến trình voice khác, tiến trình chưa từng nghe tới session của ta.
>
> Ở một mình trong kênh thì nhóm DAVE không bao giờ tới epoch, nên `session.ready`
> vẫn là `false` và audio chỉ đi dưới lớp mã hoá transport — không có ai khác trong
> nhóm để mã hoá cho.
>
> **`@snazzah/davey` là `optionalDependency` và thiếu nó thì voice không chạy.**
> `npm i @snazzah/davey`. Thiếu, `joinChannel` ném ra một câu nói rõ tên gói chứ
> không để bạn tự đi mò 4017. Voice còn cần hai thứ mà lib **cố tình không** bundle,
> vì đó là lựa chọn của người dùng: `ffmpeg` trong `PATH`, và một binding Opus
> (`@discordjs/opus`, hoặc `opusscript` nếu không build được native). `prism-media`
> tự tìm cái nào có.
>
> Video và Go Live **chưa** được mã hoá đầu cuối. Chỉ audio thôi.

> Toàn bộ phần này chép nguyên từ bản v13 và **chưa bao giờ chạy với voice
> channel thật**. Mọi file load được, phần thuần tuý có test — bảng codec, dựng
> SDP, bitfield, những chỗ v13 dùng enum chuỗi còn v14 dùng số — nhưng UDP, đóng
> gói RTP, bắt tay voice gateway và mã hoá chỉ chứng minh được khi chạy thật. Coi
> đây là "đã port", không phải "chạy được".

```ts
client.voice: ClientVoiceManager;

manager.joinChannel(channel, config?: {
  selfMute?: boolean;
  selfDeaf?: boolean;
  selfVideo?: boolean;
}): Promise<VoiceConnection>;

class VoiceConnection extends EventEmitter {
  receiver: VoiceReceiver;
  playAudio(resource, options?): AudioDispatcher;   // đường dẫn, URL hoặc stream
  playVideo(resource, options?): VideoDispatcher;
  createStreamConnection(): Promise<StreamConnection>;  // Go Live: bắt đầu phát
  joinStreamConnection(user: UserResolvable): Promise<StreamConnectionReadonly>;  // xem người khác phát
  setSpeaking(value): void;
  setVideoCodec(value): void;
  setVideoStatus(value): void;
  disconnect(): void;
}
```

`StreamConnection` bản thân nó là một `VoiceConnection`, nên phát vào đó y hệt.

```js
const connection = await client.voice.joinChannel(channel, { selfDeaf: false });

const dispatcher = connection.playAudio('./music.mp3');
dispatcher.on('finish', () => console.log('xong'));

const stream = await connection.createStreamConnection();
stream.playVideo('./video.mp4');
```

Nhận audio:

```js
const opusStream = connection.receiver.createStream(user, { mode: 'opus', end: 'silence' });
```

Ai đang nói:

```js
client.on('guildMemberSpeaking', (member, speaking) => {
  if (speaking.has('Speaking')) console.log(member.user.username);
});
```

`SpeakingBitField.Flags`: `Speaking: 1`, `Soundshare: 2`, `PrioritySpeaking: 4`.

Ví dụ: [`examples/Voice.js`](../examples/Voice.js)

---

## 14. Sự kiện

Nguồn: [`src/util/Events.js`](../src/util/Events.js) · Trạng thái: hỗn hợp

Thêm vào so với upstream:

| Sự kiện                    | Tham số                                                    | Trạng thái |
| -------------------------- | ---------------------------------------------------------- | ---------- |
| `relationshipAdd`          | `(userId, shouldNotify)`                                   | unit       |
| `relationshipRemove`       | `(userId, type, nickname)`                                 | unit       |
| `relationshipUpdate`       | `(userId, oldData, newData)`                               | unit       |
| `userNoteUpdate`           | `(userId, oldNote, newNote)`                               | unit       |
| `callCreate`               | `(call: CallState)`                                        | unit       |
| `callUpdate`               | `(call: CallState)`                                        | unit       |
| `callDelete`               | `(call: CallState)`                                        | unit       |
| `channelRecipientAdd`      | `(channel: GroupDMChannel, user)`                          | unit       |
| `channelRecipientRemove`   | `(channel: GroupDMChannel, user)`                          | unit       |
| `interactionModalCreate`   | `(modal)`                                                  | unit       |
| `userRequiredActionUpdate` | `(action, message)` — captcha, ToS, xác minh số điện thoại | unit       |
| `voiceChannelStatusUpdate` | `(oldChannel, newChannel)`                                 | unit       |
| `applicationCommandCreate` | `(command: ApplicationCommand)`                            | unit       |
| `applicationCommandUpdate` | `(command: ApplicationCommand)`                            | unit       |
| `applicationCommandDelete` | `(command: ApplicationCommand)`                            | unit       |
| `guildMemberSpeaking`      | `(member, speaking: SpeakingBitField)`                     | ported     |

`oldData` / `newData` của `relationshipUpdate` có dạng `{ type, nickname, since }`.

Chạy dài hạn thì phải nghe `userRequiredActionUpdate`: đó là cách Discord báo tài
khoản đang bị chặn sau captcha hoặc ToS mới.

---

## 15. Tiện ích

### TOTP

Nguồn: [`src/util/totp.js`](../src/util/totp.js) · Trạng thái: **unit**

```ts
generateTOTP(secret: string, options?: { timestamp?: number; digits?: number; step?: number }): string;
decodeBase32(input: string): Buffer;
```

Dùng bởi `passLogin({ mfaSecret })`; export ra để tự sinh mã khi cần.

### Bitfield

Nguồn: [`src/util/`](../src/util) · Trạng thái: **unit**

| Class                       | Flags                                                              |
| --------------------------- | ------------------------------------------------------------------ |
| `SpeakingBitField`          | `Speaking: 1`, `Soundshare: 2`, `PrioritySpeaking: 4`              |
| `PremiumUsageFlagsBitField` | `PremiumDiscriminator: 1`, `AnimatedAvatar: 2`, `ProfileBanner: 4` |
| `PurchasedFlagsBitField`    | `NitroClassic: 1`, `Nitro: 2`, `GuildBoost: 4`, `NitroBasic: 8`    |

### Enum

Nguồn: [`src/util/UserEnums.js`](../src/util/UserEnums.js)

`RelationshipType`, `HypeSquadHouse` (`Leave: 0`, `Bravery: 1`, `Brilliance: 2`,
`Balance: 3`), `SamsungActivityAction` (`START`, `UPDATE`, `STOP`).

### Route

Nguồn: [`src/util/UserRoutes.js`](../src/util/UserRoutes.js) · Trạng thái:
**ported**

```ts
UserRoutes: Record<string, (...args: string[]) => string>;
```

Toàn bộ endpoint chỉ dành cho user mà fork này gọi, dưới dạng hàm dựng path.
Export ra để tự gọi thứ chưa được bọc:

```js
const { UserRoutes } = require('@trickstarcandina/discordjs-selfbot');
await client.rest.get(UserRoutes.settings());
```

> Phần lớn route lấy từ bản v13 và **chưa kiểm chứng**. Nếu một lệnh trả 404 hoặc
> 403 code `40001`, khả năng cao route đó chỉ dành cho bot hoặc đã đổi chỗ.

---

## Không nằm ở đây

- **Mọi thứ của upstream** — [discord.js.dev](https://discord.js.dev).
- **Khác biệt v13 → v14** — [`MIGRATION.vi.md`](../MIGRATION.vi.md), gồm lớp tương
  thích, codemod, và những tên đổi nghĩa mà không báo lỗi.
- **File upstream nào bị sửa và vì sao** — [`UPSTREAM.vi.md`](../UPSTREAM.vi.md).
- **Gửi lời mời kết bạn, chặn, huỷ kết bạn** — chưa cài đặt, xem
  [mục 3](#3-quan-hệ-bạn-bè).
