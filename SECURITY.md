**English** | [Tiếng Việt](./SECURITY.vi.md)

# Security

This library holds a **user token**: whoever has it owns the account — messages,
friends, payment methods. Every rule below exists to keep that token, and the
requests it signs, out of anyone else's control.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository (Security → Report a vulnerability). Never paste a real token,
not even an expired one, into a report.

## Commands

| Command                             | What it checks                                                                     | Where it runs                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| `npm run audit:prod`                | Known advisories in **runtime** dependencies, `moderate` and up                    | release, weekly, local                          |
| `npm run audit:all`                 | Known advisories in all dependencies, `high` and up                                | release, weekly, local                          |
| `npm run audit:signatures`          | Registry signatures and provenance of every installed package                      | release, weekly (needs sigstore network access) |
| `npm run check:package`             | What `npm publish` would upload: allowlisted paths only, no `.env`, keys or tokens | release, weekly, local                          |
| `node --test test/security.test.js` | The regressions listed under _Fixed_ below, plus no token in any tracked file      | every commit (husky), release                   |
| `npm run security`                  | All of the above except signatures, in one go                                      | local, before tagging                           |

## Routine

**Every commit** — husky `pre-commit` runs `node --test`, which includes
`test/security.test.js`. A commit that adds a real Discord token to any tracked
file fails here.

**Every week** — `.github/workflows/security.yml` runs the audits, the signature
check and CodeQL (`security-and-quality`, config in `.github/codeql/`). Dependabot
opens PRs for npm packages and GitHub Actions. The daily `stats.yml` is the only
workflow with write access: it runs no `npm ci` and only pushes the `stats` branch. A new advisory against a dependency
shows up here even when no line of our code changed.

**Every release** — `publish.yml` refuses to publish unless, in this order: tag
matches `package.json`, lint, unit tests, TypeScript, `audit:prod`, `audit:all`,
`audit:signatures`, `check:package` all pass. Before pressing _Publish release_:

1. `npm run security` locally and read the output, not just the exit code.
2. Read `git diff <last tag>..HEAD -- package-lock.json`: every new or changed
   package is code that will run with the user's token in memory. New
   `install`/`postinstall` scripts deserve a look (`npm query ':attr(scripts, [postinstall])'`).
3. `git log <last tag>..HEAD -p | grep -E '[MNO][\w-]{23,27}\.[\w-]{6}\.'` should
   print nothing.
4. Confirm `scripts/smoke/results.md` holds only names, dates and PASS/FAIL.
5. After publishing, `npm view @trickstarcandina/discordjs-selfbot dist.attestations`
   should show provenance.

**When upstream discord.js moves** — run the audits again after
`git merge upstream-vendor`; upstream may raise dependency floors (e.g. `undici`)
that we must match.

## Fixed

| Issue                                                             | Impact                                                                                                                                                                                                                                                                            | Fix                                                                                               |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Route parameters in `UserRoutes` were concatenated raw            | `client.redeemNitro('../../invites/<code>#')` sent an **authenticated `POST /invites/<code>`** (joins a server). Gift snipers feed message content straight into this method, so anyone able to post a message could steer the account. Same for every other `UserRoutes` builder | Every parameter goes through `segment()`: `encodeURIComponent`, keeping `@`; `.`/`..`/empty throw |
| `acceptInvite` passed unmatched input to upstream `Routes.invite` | Same class: `GET` and `POST` to an attacker-chosen path with the token                                                                                                                                                                                                            | Code must match `^[\w-]{2,255}$`                                                                  |
| `undici` ≤ 6.29.0 (runtime)                                       | Five advisories, DoS and response splitting (GHSA-3wwx-pv8p-q78v, GHSA-r53p-7pc4-xj5r, GHSA-rfgv-xxqx-mfg5, GHSA-4qv8-2p9j-2685, GHSA-xjj6-f33q-929c)                                                                                                                             | Floor raised to `^6.29.1`                                                                         |
| `brace-expansion`, `js-yaml` (dev only)                           | DoS in lint tooling                                                                                                                                                                                                                                                               | `npm audit fix`                                                                                   |
| `RemoteAuth` threw inside the socket listener                     | A malformed packet or failed decryption was an uncaught exception that killed the process                                                                                                                                                                                         | Caught; emitted as `error`, `connect()` rejects                                                   |
| `RemoteAuth.connect(client)` when `client.login` failed           | Unhandled rejection, promise hung forever                                                                                                                                                                                                                                         | `connect()` rejects with the login error                                                          |
| `Recorder.destroy` matched ffmpeg by command line                 | Could `kill` another process (a second Recorder, or another program's ffmpeg) with the same arguments                                                                                                                                                                             | Match on pid/ppid only (`findOwnFFmpeg`)                                                          |
| `uploadToSlot` accepted any URL scheme                            | File contents could go out over plain `http`                                                                                                                                                                                                                                      | Only `https:`                                                                                     |
| `Recorder` ran ffmpeg with `-y`                                   | An output path pointing at an existing file silently replaced it                                                                                                                                                                                                                  | Throws unless `{ overwrite: true }`; ffmpeg gets `-n` otherwise                                   |
| `authorizeURL` copied every query parameter into the body         | A crafted link could set body fields such as `authorize` or `location_context`                                                                                                                                                                                                    | Only OAuth2 parameters are copied; extra fields go through `options`                              |
| `http.headers` could set `authorization`                          | A config built from outside data could send requests with another token                                                                                                                                                                                                           | `authorization` is dropped from `http.headers`                                                    |
| GitHub Actions pinned by tag                                      | A moved or hijacked tag would run in the publish job, which can push to npm                                                                                                                                                                                                       | Pinned by commit SHA; checkout no longer keeps the token; publish jobs skip the shared cache      |

## Known risks, not fixed

These are documented rather than changed, because changing them alters behaviour
that callers may rely on.

- **ffmpeg input is passed through.** `playAudio(input)` / `playVideo(input)` hand
  `input` to `ffmpeg -i` (no shell, so no command injection). If an application
  passes a URL taken from chat, ffmpeg will happily open `file:`, `concat:` or
  internal-network URLs. Applications must allowlist `https:` URLs themselves.
  `inputFFmpegArgs`/`outputFFmpegArgs` are raw ffmpeg arguments — never fill them
  from user input.
- **`authorizeURL` takes `permissions` and `scope` from the URL.** That is the
  point of the method, but it means the URL alone decides what gets granted —
  only call it on URLs you trust.
- **Upstream `Routes` (discord-api-types) do not encode parameters either.** Ids
  that come from Discord payloads are safe; strings from users are not. Resolve
  them through a manager (`fetch`, `resolveId`) first.
- **CodeQL `paths-ignore` excludes `test/` and `scripts/smoke/`**, which only hold
  fake credentials. `src/` is scanned fully.

## Handling tokens

- Tokens live in `.env` (git-ignored) and nowhere else. `.env.example` holds
  empty values only.
- `Client#_censoredToken` is what reaches the `debug` event; never log
  `client.token`.
- A token that was ever committed, pasted in an issue, or printed in CI is
  compromised: change the account password (that invalidates every token), then
  rewrite history if needed.
