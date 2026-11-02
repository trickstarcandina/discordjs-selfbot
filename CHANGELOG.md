# Changelog

Every entry below was found by running the library against a real Discord account,
not by reading code. Where a claim is not proven, it says so.

## 0.3.0

A security release. Three of the fixes change behaviour that code may rely on, so
read **Breaking** before upgrading.

### Breaking

- Node.js 22.12 or newer is required. Node 20 reached end of life on 2026-04-30
  and no longer gets security fixes.
- `receiver.createVideoStream(user, path)` throws when `path` already exists,
  instead of overwriting it. Pass `{ overwrite: true }` as the third argument for
  the old behaviour. A stream output is unaffected.
- `authorizeURL` only copies OAuth2 parameters from the URL into the body. Send
  anything else through `options`.
- `authorization` in `client.options.http.headers` is ignored; the token only
  comes from `login()`.

### Security

- `UserRoutes` encodes every parameter. `redeemNitro` fed with message content
  could be made to send an authenticated request to another endpoint, e.g.
  `'../../invites/<code>#'` joined a server. See [`SECURITY.md`](./SECURITY.md).
- `acceptInvite` rejects anything that is not a bare invite code.
- `undici` raised to `^6.29.1` for five advisories.
- `RemoteAuth` no longer crashes the process on a malformed packet, and
  `connect(client)` rejects instead of hanging when `client.login` fails.
- `Recorder.destroy` only kills the ffmpeg process it spawned.
- `uploadToSlot` refuses non-`https` upload URLs.
- The three **Breaking** changes above: a recording no longer silently replaces a
  file, an OAuth2 link can no longer smuggle extra fields into the body, and
  options built from outside data can no longer send requests with another token.
- GitHub Actions are pinned by commit SHA.
- Releases now also run `npm audit`, `npm audit signatures` and a check of the
  tarball contents before publishing; a weekly workflow runs the audits and CodeQL.

### Changed

- `discord-api-types` raised to `^0.38.57` and `ws` to `^8.22.0`.
- The npm package no longer ships the `typings/*.test-d.ts` type tests.

**Not proven:** every change above is covered by unit tests, but none has yet
been run against a real account.

## 0.2.1

No library code changed since 0.2.0 — `src/` and `typings/` are byte for byte the
same. Releases publish themselves from now on.

- Pressing **Publish release** on GitHub runs lint, the unit tests and the
  TypeScript checks, then publishes to npmjs and to GitHub Packages as two
  independent jobs.
- npmjs authenticates through OIDC trusted publishing rather than a stored token,
  so there is no long-lived credential to leak, and npm attaches provenance
  linking the tarball to the commit that built it.
- The pipeline refuses to publish when the git tag and `package.json` version
  disagree.

## 0.2.0

### Voice works

Voice was ported wholesale from the v13 fork and had never once run. It does now:
`joinChannel`, `playAudio`, `createStreamConnection`, `receiver.createStream` and
`disconnect` all pass against a real channel. Five separate faults stood in the way.

- **DAVE end-to-end encryption is implemented.** Discord has required it on every
  non-stage voice call since March 2026 and answered the IDENTIFY with
  `4017 E2EE/DAVE protocol required`. The stack now wraps
  [`@snazzah/davey`](https://www.npmjs.com/package/@snazzah/davey) — the same native
  MLS binding `@discordjs/voice` uses — speaks DAVE's binary frames, runs the epoch
  and transition handshake, and encrypts audio inside the existing transport
  encryption rather than instead of it.
- **The voice endpoint keeps its port.** `setTokenAndEndpoint` threw away everything
  after the colon, which was right when Discord appended a useless `:80` and wrong
  now that it hands out `:8443`. Dropping the port connected the websocket to port
  443 of a different voice process, which had never heard of our session and closed
  with `4006`. This was the last wall.
- **The DAVE session is created before the first MLS frame.** The voice server sends
  the external sender and proposals before it announces the epoch, so building the
  session inside `prepareEpoch` was too late.
- **Other people's voice states no longer hijack the connection.**
  `ClientVoiceManager` acted on every `VOICE_STATE_UPDATE` in the channel: someone
  else leaving ran `_disconnect()` on your connection, and someone else joining
  overwrote your `sessionId` with theirs.
- **A user account can reach the voice gateway at all.** `joinChannel` gated on
  `channel.joinable`, which asks `guild.members.me` — and a user token's `READY`
  never seeds the client's own member, so it was `false` for every channel.
- **The IDENTIFY carries `channel_id`**, required from gateway v9 and sent by every
  real client, and no longer carries the Go Live `streams`/`video` payload on plain
  voice connections.

**Not proven:** nobody has listened to the audio, and alone in a channel the DAVE
group never reaches an epoch, so `encryptOpus` and `decrypt` have never run against
Discord. Video and Go Live are not end-to-end encrypted.

### Added

- `@snazzah/davey` as an `optionalDependency`. Voice cannot connect without it;
  `joinChannel` throws a sentence naming the package rather than letting you
  discover `4017` yourself.
- TypeScript can finally see the voice API. `typings` only carried upstream's
  `ClientVoiceManager`, so `client.voice.joinChannel()` did not exist as far as
  `tsc` was concerned. `VoiceConnection`, `VoiceReceiver`, `DAVESession` and
  `VoiceStatus` are now exported and typed.
- `BaseActivityBuilder` is exported. `CustomStatus` and `RichPresence` extend it and
  the typings declared it, but nothing exported it.

### Fixed

- **Every request went out with a bot `User-Agent`.** `@discordjs/rest` appends its
  own after the headers it is given, and the key differed in case from the
  lowercase one the shim sets, so both were sent and Discord read the last.
  `POST /users/@me/invites` answered `204` with an empty body instead of creating an
  invite.
- **A user token cannot fetch a single message.**
  `GET /channels/:id/messages/:id` answers `403 code 20002`; `MessageManager` now
  goes through the list route and still throws `10008` when the message is gone.
- **Any `CHANNEL_UPDATE` for a group DM killed the client.** `recipients` was an
  own read-only accessor, so `Base#_clone()` threw. Renaming a group DM from any
  client would have done it.
- **`Invite` could not represent a friend invite** — they carry `channel: null`.
- **Guild application commands** are found through the guild command index; the
  channel search route returns nothing for them.
- `THREAD_LIST_SYNC` no longer crashes on a payload without `threads` or `members`.

### Performance

- Importing the library no longer loads `werift-rtp` and `prism-media`. Both are
  only reachable once RTP packets or audio actually flow. Measured over five runs:
  244.4ms → 229.9ms to require, 721 → 652 modules, 95.4MB → 93.9MB RSS.

### Removed

- `user.fetchBurstCredit()`. `GET /users/@me/burst-credits` answers a bare `404` on
  a live account on both API v9 and v10; the route is gone.

### Known gaps

- Account settings arrive as `USER_SETTINGS_PROTO_UPDATE`, a protobuf payload this
  fork does not decode, so `client.settings` goes stale when something else changes
  it. `fetch()` and `edit()` still work.
- Four profile writes (`setAboutMe`, `setPronouns`, `setGlobalName`,
  `setAccentColor`) need a `captchaSolver`; `PATCH /users/@me` answers with hCaptcha.
- Interaction components (`clickButton`, `selectMenu`, modal submit) are implemented
  and unit tested, but no bot reply with components has been found to run them
  against.

See [`scripts/smoke/results.md`](./scripts/smoke/results.md) for what has and has
not been run against a real account.

## 0.1.0

Initial rebuild of `discord.js-selfbot-v13` on top of `discord.js@14`, with a v13
compatibility layer and codemod. Never published.
