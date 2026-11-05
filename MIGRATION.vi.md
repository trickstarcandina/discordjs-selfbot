[English](./MIGRATION.md) | **Tiếng Việt**

# Chuyển từ `discord.js-selfbot-v13`

Thư viện này dựng trên `discord.js@14.28.1`, thay cho `discord.js-selfbot-v13`
(nền `discord.js@13.17.1`, đã archive).

Lớp tương thích **bật mặc định**, nên phần lớn code cũ chạy được ngay. Tài liệu
này liệt kê chính xác phần nào không chạy được và phải sửa thế nào.

## Chạy codemod trước

```sh
# Xem trước, không ghi
node scripts/codemod-v13-to-v14.mjs ../repo-cua-ban/src

# Ghi thật
node scripts/codemod-v13-to-v14.mjs ../repo-cua-ban/src --write
```

Nó sửa được phần lớn mục 1 và 2 dưới đây, và **báo** những chỗ nó không dám
đoán. Đây là công cụ hỗ trợ dựa trên regex, không phải trình kiểm chứng — đọc
lại diff trước khi commit.

## 1. So sánh chuỗi ở phía đọc

Đây là thay đổi ảnh hưởng rộng nhất và là thứ lớp tương thích **không** cứu được.

```js
// v13
if (channel.type === 'GUILD_TEXT') {
}

// v14
const { ChannelType } = require('discord-api-types/v10');
if (channel.type === ChannelType.GuildText) {
}
```

Ở v14, `channel.type` trả về **số**. Muốn giữ chuỗi thì phải ép toàn bộ nội bộ
discord.js quay về string enum — 99 chỗ `ChannelType` trên 18 file, 84 chỗ
`AuditLogEvent`, 70 chỗ `MessageType`. Làm vậy là mất khả năng merge fix từ
upstream, tức mất chính lý do chuyển sang v14.

Áp dụng cho mọi enum: `type`, `style`, `verificationLevel`, `premiumTier`,
`nsfwLevel`, `status`, `privacyLevel`, `entityType`, `membershipState`...

Muốn viết ít nhất thì dùng `Constants` kiểu v13, vẫn còn:

```js
const { Constants } = require('@trickstarcandina/discordjs-selfbot');
if (channel.type === Constants.ChannelTypes.GUILD_TEXT) {
}
```

## 2. Tên tồn tại ở cả hai phiên bản nhưng khác nghĩa

Không alias được, vì ở v14 những tên này đã mang nghĩa khác. Dùng tên cũ là
**hỏng thật**, không phải chỉ lỗi thời.

| Tên                     | Ở v13 là                  | Ở v14 là                            | Đổi sang                      |
| ----------------------- | ------------------------- | ----------------------------------- | ----------------------------- |
| `TextInputComponent`    | builder ô nhập            | model ô nhập đã gửi                 | `TextInputBuilder`            |
| `CommandInteraction`    | interaction slash command | lớp cha của mọi command interaction | `ChatInputCommandInteraction` |
| `SelectMenuInteraction` | interaction select menu   | lớp cha của mọi select menu         | `StringSelectMenuInteraction` |
| `MessageFlags`          | lớp BitField              | enum của API                        | `MessageFlagsBitField`        |
| `UserFlags`             | lớp BitField              | enum của API                        | `UserFlagsBitField`           |
| `ActivityFlags`         | lớp BitField              | enum của API                        | `ActivityFlagsBitField`       |
| `ApplicationFlags`      | lớp BitField              | enum của API                        | `ApplicationFlagsBitField`    |
| `ChannelFlags`          | lớp BitField              | enum của API                        | `ChannelFlagsBitField`        |
| `GuildMemberFlags`      | lớp BitField              | enum của API                        | `GuildMemberFlagsBitField`    |
| `RoleFlags`             | lớp BitField              | enum của API                        | `RoleFlagsBitField`           |
| `AttachmentFlags`       | lớp BitField              | enum của API                        | `AttachmentFlagsBitField`     |
| `ThreadMemberFlags`     | lớp BitField              | enum của API                        | `ThreadMemberFlagsBitField`   |

## 3. Phần chạy được ngay, không cần sửa

### Tên lớp

`MessageEmbed`, `MessageAttachment`, `MessageActionRow`, `MessageButton`,
`MessageSelectMenu`, `MessageSelectOption`, `Modal`, `Channel`,
`BaseCommandInteraction`, `ContextMenuInteraction`, `Permissions`, `Intents`,
`SystemChannelFlags` — đều là alias trỏ thẳng tới lớp v14, nên `instanceof` vẫn
đúng cả hai chiều.

### Tên quyền và cờ

```js
// Cả hai cách viết đều chạy
channel.permissionsFor(member).has('SEND_MESSAGES');
channel.permissionsFor(member).has('SendMessages');
new Permissions(['SEND_MESSAGES', 'ManageGuild']);
```

Kể cả những tên bị đổi hẳn: `MANAGE_EMOJIS_AND_STICKERS`, `USE_PUBLIC_THREADS`,
`USE_PRIVATE_THREADS`, `START_EMBEDDED_ACTIVITIES`, `USE_VAD`.

Lưu ý: `toArray()` trả về **tên kiểu v14**. Code nào so sánh kết quả `toArray()`
với chuỗi kiểu v13 vẫn phải sửa.

### Chuỗi enum ở phía ghi

Chạy được tại các điểm sau:

- `guild.channels.create()` / `.edit()` — `type`, `videoQualityMode`
- `client.guilds.create()` và `guild.edit()` — `verificationLevel`,
  `defaultMessageNotifications`, `explicitContentFilter`
- `guild.scheduledEvents.create()` / `.edit()` — `privacyLevel`, `entityType`, `status`
- `guild.stageInstances.create()` / `.edit()` — `privacyLevel`
- `client.user.setActivity()` / `setPresence()` — `type` của activity

Ngoài danh sách này thì chưa phủ. Truyền chuỗi không dịch được sẽ đi thẳng tới
API để API tự báo lỗi, chứ không bị đổi thành `undefined`.

### Method đã đổi tên

`embed.addField(name, value, inline)`, `channel.isText()`, `channel.isVoice()`
vẫn dùng được.

## 4. Thay đổi riêng của phần selfbot

| v13                                | Ở đây                             | Lý do                                                                                            |
| ---------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `session.createdAt`                | `session.lastUsedAt`              | Giá trị là `approx_last_used_time`, không phải thời điểm tạo. Tên cũ giữ làm alias `@deprecated` |
| `boost.guilld`                     | `boost.guild`                     | Bản v13 gõ thừa một chữ `l` nên getter đó không ai gọi tới được                                  |
| `clientUser.getAllFriendInvites()` | `clientUser.fetchFriendInvites()` | Theo quy ước `fetch*` của discord.js                                                             |
| `new CustomStatus(client)`         | `new CustomStatus()`              | Không còn kế thừa `Activity` nên không cần `client`                                              |
| `new RichPresence(client)`         | `new RichPresence()`              | Như trên                                                                                         |
| `channel.getInvite()`              | `channel.createInvite()`          | Nó tạo lời mời chứ không phải lấy                                                                |
| `channel.fetchAllInvite()`         | `channel.fetchInvites()`          | Theo quy ước số nhiều của discord.js                                                             |
| `channel.removeInvite()`           | `channel.deleteInvite()`          | Theo quy ước `delete*`                                                                           |

### Đã bỏ, không port

`relationship.sendFriendRequest()`, `.addFriend()`, `.addBlocked()`,
`.deleteRelationship()` — cả bốn ở bản v13 đều `throw` ngay dòng đầu
(`'Risky action, not finished yet.'`), port sang chỉ là chép code chết.

## 5. TypeScript

`intents` không còn bắt buộc:

```ts
const client = new Client({}); // hợp lệ
```

Toàn bộ phần selfbot đã có khai báo type: `client.relationships`, `.settings`,
`.sessions`, `.notes`, `.billing`, cùng `WebEmbed`, `CustomStatus`,
`RichPresence`, `SpotifyRPC`, `Session`, `CallState`, `GuildBoost`.

## 6. Đăng nhập

Ngoài token, giờ có thêm hai cách:

```js
// Quét mã QR bằng ứng dụng Discord trên điện thoại
await client.QRLogin();

// Email và mật khẩu, tự sinh mã 2FA từ secret base32
await client.passLogin('a@b.vn', 'mat-khau', { mfaSecret: 'BASE32SECRET' });
```

`passLogin` rủi ro hơn dùng token: Discord soi kỹ đăng nhập bằng mật khẩu và hay
chặn bằng captcha. Cấu hình `captchaSolver` trước nếu cần.
