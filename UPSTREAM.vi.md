[English](./UPSTREAM.md) | **Tiếng Việt**

# Upstream base

|               |                                            |
| ------------- | ------------------------------------------ |
| Repo          | https://github.com/discordjs/discord.js    |
| Branch        | `v14`                                      |
| Commit        | `88ff1bda586b146cb2c799c58c4534657b1a3255` |
| Version       | `14.28.0`                                  |
| Đường dẫn lấy | `packages/discord.js/{src,typings}`        |

## Nâng cấp

Nhánh `upstream-vendor` chỉ chứa `src/` và `typings/` **nguyên bản, chưa patch**. Nó là merge base:
git so bản gốc cũ với bản gốc mới rồi tự áp lại patch selfbot, thay vì bắt tay dán lại từng file.

    git clone --filter=blob:none https://github.com/discordjs/discord.js ../discord.js  # lần đầu
    git -C ../discord.js fetch --tags                  # cập nhật bản clone upstream
    git fetch origin upstream-vendor:upstream-vendor   # script cần nhánh này ở local
    ./scripts/sync-upstream.sh <version>               # ghi commit mới lên upstream-vendor
    git merge upstream-vendor                          # git tự áp lại patch
    npm view discord.js@<version> dependencies         # chỉnh package.json cho khớp, rồi npm install
    npm test                                           # lưới an toàn
    git push origin upstream-vendor                    # đẩy merge base mới lên
    # cập nhật bảng phía trên + bảng file bị sửa phía dưới

`<version>` là số phiên bản, ví dụ `14.28.0`: discord.js gắn tag cho mỗi bản phát hành đúng bằng số
phiên bản. Ref git nào khác cũng dùng được.

Conflict chỉ nổ ở file upstream sửa đúng dòng fork đã sửa — đúng danh sách trong bảng dưới. Thử với
`origin/main` (đã là nhánh v15 đang phát triển, thay đổi rất lớn): 358 file đổi, git tự merge 339,
chỉ 19 file phải xử tay. Nâng cấp trong dòng v14 sẽ ít hơn nhiều.

Ba điều dễ vấp:

- Sync xong phải push `upstream-vendor`. Clone repo chỉ lấy `main`, người sau fetch về đúng thứ đang
  có trên remote; nếu nó vẫn là bản cũ, lần sync của họ gắn commit mới lên đó và git so từ mốc sai,
  áp lại những thay đổi `main` đã có.
- Đừng commit lên `upstream-vendor` bằng `git commit` thường. Hook `pre-commit` chạy lint-staged, nó
  format lại mã gốc và làm hỏng đúng thứ nhánh này cần giữ nguyên xi. Script dùng `git commit-tree`
  nên không dính hook; nhánh này cũng không có `test/` để `node --test` chạy.
- Script không đụng cây làm việc, chạy lúc đang sửa dở cũng được.

## Danh sách file upstream đã bị sửa

Mọi sửa đổi lên file upstream phải ghi vào đây kèm lý do một dòng.

| File                                                                                                             | Lý do                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/client/BaseClient.js`                                                                                       | Dùng `createSelfbotREST()` thay `new REST()`                                                                                                                                                                                  |
| `src/util/Options.js`                                                                                            | Thêm default cho user account: `intents: 0`, `ws.properties`, `ws.capabilities`, `ws.client_state`, `ws.buildStrategy`, `http`, `captchaSolver`, `captchaRetryLimit`                                                          |
| `src/client/Client.js`                                                                                           | Cắm `SelfbotShardingStrategy` vào `options.ws.buildStrategy`; thêm manager `relationships`, `sessions`, `notes`, `settings`, `billing`; trộn `ClientActions` vào prototype (một dòng)                                         |
| `src/client/websocket/handlers/index.js`                                                                         | Đăng ký handler `RELATIONSHIP_*`, `USER_NOTE_UPDATE`, `USER_SETTINGS_UPDATE`, `USER_GUILD_SETTINGS_UPDATE`, `CALL_*`, `CHANNEL_RECIPIENT_*`, `INTERACTION_MODAL_CREATE`                                                       |
| `src/client/websocket/handlers/READY.js`                                                                         | Guard `data.application` (user token không nhận field này); seed relationships, notes, session hash, user settings, guild settings                                                                                            |
| `src/structures/ClientPresence.js`                                                                               | `_parse` đẩy nguyên payload của builder selfbot và giữ `emoji`; upstream chỉ giữ `type/name/state/url` vì bot không phát được emoji, asset, button, party                                                                     |
| `src/structures/ClientUser.js`                                                                                   | Trộn `ClientUserActions` vào prototype (một dòng `Object.assign`); ghi đè `edit` vì bản upstream destructure đúng `{ username, avatar, banner }` nên vứt im lặng `password`, `bio`, `pronouns`, `global_name`, `accent_color` |
| `src/structures/MessageReaction.js`, `BaseInteraction.js`, `CommandInteraction.js`, `AutocompleteInteraction.js` | Guard `client.application` — tài khoản người dùng không có, upstream giả định luôn có                                                                                                                                         |
| `src/client/actions/Entitlement{Create,Update,Delete}.js`, `handlers/SUBSCRIPTION_{CREATE,UPDATE,DELETE}.js`     | Bỏ qua event khi không có application, thay vì ném                                                                                                                                                                            |
| `src/structures/Guild.js`                                                                                        | Thêm manager `settings` (setting thông báo của client user cho guild)                                                                                                                                                         |
| `src/util/Channels.js`                                                                                           | `createChannel` dựng `GroupDMChannel` thay `PartialGroupDMChannel` (user account dùng group DM đầy đủ)                                                                                                                        |
| `src/managers/UserManager.js`                                                                                    | `fetch` đi qua `/users/:id/profile`; `GET /users/:id` là route bot-only, token người dùng ăn 403 code 40001                                                                                                                   |
| `src/managers/MessageManager.js`                                                                                 | `_fetchSingle` đi qua route liệt kê kèm `around`; `GET /channels/:id/messages/:messageId` là route bot-only, token người dùng ăn 403 code 20002                                                                               |
| `src/client/actions/ThreadListSync.js`                                                                           | Chịu được payload không có `threads` lẫn `members`; tài khoản người dùng nhận đúng dạng đó ngay sau khi subscribe guild, upstream đọc thẳng cả hai                                                                            |
| `src/structures/Invite.js`                                                                                       | `_patch` chịu được `channel: null`; lời mời kết bạn không trỏ tới kênh nào, upstream đọc thẳng `data.channel.id`                                                                                                              |
| `src/structures/Message.js`                                                                                      | Trộn `MessageInteractionActions` vào prototype (một dòng)                                                                                                                                                                     |
| `src/structures/interfaces/TextBasedChannel.js`                                                                  | `applyToClass` gắn thêm `ChannelInteractionActions`                                                                                                                                                                           |
| `src/client/voice/**`                                                                                            | Thay toàn bộ bằng stack voice kiểu v12 của selfbot-v13; v14 không có voice trong core                                                                                                                                         |
| `src/util/Events.js`                                                                                             | Thêm `GuildMemberSpeaking`, `RelationshipAdd/Remove/Update`, `UserNoteUpdate`, `CallCreate/Update/Delete`, `ChannelRecipientAdd/Remove`, `InteractionModalCreate`                                                             |
| `typings/index.d.ts`                                                                                             | `intents` thành optional; nối thêm khối `//#region Selfbot` ở cuối file dùng declaration merging, nên phần thêm không đụng vào nơi khai báo gốc                                                                               |
| `src/index.js`                                                                                                   | Bật compat layer ở cuối file; export phần selfbot: `RelationshipType`, `Session`, `UserRoutes`, các manager mới                                                                                                               |
| `src/client/WebhookClient.js`                                                                                    | Bỏ `valid-jsdoc` khỏi một comment `eslint-disable`: ESLint 9 đã gỡ rule này và báo lỗi khi disable rule không tồn tại                                                                                                         |
