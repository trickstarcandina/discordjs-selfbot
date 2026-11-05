**English** | [Tiếng Việt](./UPSTREAM.vi.md)

# Upstream base

|            |                                            |
| ---------- | ------------------------------------------ |
| Repo       | https://github.com/discordjs/discord.js    |
| Branch     | `v14`                                      |
| Commit     | `e19a9bd35d535bff1ce92473a39ef9b2dc05aa53` |
| Version    | `14.28.1`                                  |
| Taken from | `packages/discord.js/{src,typings}`        |

## Upgrading

The `upstream-vendor` branch holds `src/` and `typings/` **pristine, unpatched**.
It is the merge base: git diffs the old upstream against the new one and reapplies
the selfbot patches itself, instead of you pasting them back file by file.

    git clone --filter=blob:none https://github.com/discordjs/discord.js ../discord.js  # once
    git -C ../discord.js fetch --tags                  # refresh the upstream clone
    git fetch origin upstream-vendor:upstream-vendor   # the script needs it as a local branch
    ./scripts/sync-upstream.sh <version>               # write a commit onto upstream-vendor
    git merge upstream-vendor                          # git reapplies the patches
    npm view discord.js@<version> dependencies         # align package.json, then npm install
    npm test                                           # safety net
    git push origin upstream-vendor                    # publish the new merge base
    # update the table above and the divergence table below

`<version>` is the release, e.g. `14.28.0`: discord.js tags each release with the
bare version. Any other git ref works too.

Conflicts only occur where upstream touched a line the fork had already changed —
exactly the files in the table below. A dry run against `origin/main` (already the
v15 development line, so a worst case): 358 files changed, git merged 339, only 19
needed hands. Upgrades within the v14 line will be far smaller.

Three things to watch:

- `upstream-vendor` must be pushed after every sync. A clone only gets `main`, so
  the next person fetches whatever the remote holds; if it is still the old
  release, their sync parents the new commit on it and git diffs from the wrong
  base, reapplying changes `main` already has.
- Do not commit to `upstream-vendor` with a plain `git commit`. The `pre-commit`
  hook runs lint-staged, which reformats the pristine sources — destroying the one
  thing that branch exists to preserve. The script uses `git commit-tree` so no
  hook fires; the branch also has no `test/` for `node --test` to run.
- The script never touches the working tree, so it is safe to run mid-edit.

## Modified upstream files

Every change to an upstream file must be recorded here with a one-line reason.

| File                                                                                                             | Reason                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/client/BaseClient.js`                                                                                       | Use `createSelfbotREST()` instead of `new REST()`                                                                                                                                                                                                   |
| `src/util/Options.js`                                                                                            | Add user-account defaults: `intents: 0`, `ws.properties`, `ws.capabilities`, `ws.client_state`, `ws.buildStrategy`, `http`, `captchaSolver`, `captchaRetryLimit`                                                                                    |
| `src/client/Client.js`                                                                                           | Wire `SelfbotShardingStrategy` into `options.ws.buildStrategy`; add the `relationships`, `sessions`, `notes`, `settings` and `billing` managers; mix `ClientActions` into the prototype (one line)                                                  |
| `src/client/websocket/handlers/index.js`                                                                         | Register the `RELATIONSHIP_*`, `USER_NOTE_UPDATE`, `USER_SETTINGS_UPDATE`, `USER_GUILD_SETTINGS_UPDATE`, `CALL_*`, `CHANNEL_RECIPIENT_*` and `INTERACTION_MODAL_CREATE` handlers                                                                    |
| `src/client/websocket/handlers/READY.js`                                                                         | Guard `data.application` (a user token never receives it); seed relationships, notes, the session hash, user settings and guild settings — the last of which arrives as `{ version, partial, entries }`, not an array                               |
| `src/structures/ClientPresence.js`                                                                               | `_parse` forwards the selfbot builder payload whole and keeps `emoji`; upstream keeps only `type/name/state/url` because bots cannot broadcast emoji, assets, buttons or party data                                                                 |
| `src/structures/ClientUser.js`                                                                                   | Mix `ClientUserActions` into the prototype (one `Object.assign`); override `edit`, whose upstream version destructures exactly `{ username, avatar, banner }` and so silently drops `password`, `bio`, `pronouns`, `global_name` and `accent_color` |
| `src/structures/MessageReaction.js`, `BaseInteraction.js`, `CommandInteraction.js`, `AutocompleteInteraction.js` | Guard `client.application` — user accounts have none, upstream assumes it is always there                                                                                                                                                           |
| `src/client/actions/Entitlement{Create,Update,Delete}.js`, `handlers/SUBSCRIPTION_{CREATE,UPDATE,DELETE}.js`     | Skip the event when there is no application, instead of throwing                                                                                                                                                                                    |
| `src/structures/Guild.js`                                                                                        | Add the `settings` manager (the client user's notification settings for that guild)                                                                                                                                                                 |
| `src/util/Channels.js`                                                                                           | `createChannel` builds a `GroupDMChannel` rather than `PartialGroupDMChannel` (user accounts get full group DMs)                                                                                                                                    |
| `src/managers/UserManager.js`                                                                                    | `fetch` goes through `/users/:id/profile`; `GET /users/:id` is bot-only and a user token gets 403 code 40001                                                                                                                                        |
| `src/managers/MessageManager.js`                                                                                 | `_fetchSingle` goes through the list route with `around`; `GET /channels/:id/messages/:messageId` is bot-only and a user token gets 403 code 20002                                                                                                  |
| `src/client/actions/ThreadListSync.js`                                                                           | Tolerate a payload with no `threads` and no `members`; a user account gets one that shape right after subscribing to a guild, and upstream reads both straight                                                                                      |
| `src/structures/Invite.js`                                                                                       | `_patch` tolerates `channel: null`; friend invites point at no channel and upstream reads `data.channel.id` straight                                                                                                                                |
| `src/structures/Message.js`                                                                                      | Mix `MessageInteractionActions` into the prototype (one line)                                                                                                                                                                                       |
| `src/structures/interfaces/TextBasedChannel.js`                                                                  | `applyToClass` also attaches `ChannelInteractionActions`                                                                                                                                                                                            |
| `src/client/voice/**`                                                                                            | Replaced wholesale with the v12-style voice stack from the v13 selfbot; v14 has no voice in core                                                                                                                                                    |
| `src/util/Events.js`                                                                                             | Add `GuildMemberSpeaking`, `RelationshipAdd/Remove/Update`, `UserNoteUpdate`, `CallCreate/Update/Delete`, `ChannelRecipientAdd/Remove`, `InteractionModalCreate`                                                                                    |
| `typings/index.d.ts`                                                                                             | Make `intents` optional; append a `//#region Selfbot` block using declaration merging, so the additions never touch the original declarations                                                                                                       |
| `src/index.js`                                                                                                   | Enable the compatibility layer at the end of the file; export the selfbot surface: `RelationshipType`, `Session`, `UserRoutes`, the new managers                                                                                                    |
| `src/client/WebhookClient.js`                                                                                    | Drop `valid-jsdoc` from an `eslint-disable` comment: ESLint 9 removed that rule and errors on a disable for an unknown rule                                                                                                                         |
