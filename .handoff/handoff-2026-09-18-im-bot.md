# Handoff: Feishu Office Assistant Runtime (im_bot)

**Date:** 2026-09-18
**Workspace:** `/home/wangjy/im_bot` (Linux server; this is a remote box reached over SSH — the bot service runs here 24/7 via `nohup`)
**Repo state:** clean at commit `154e4df` (restructure: remove legacy codex runtime, hoist pi_runtime to repo root)

## Project summary

A personal Feishu (Lark) office assistant: an agent runtime (`@earendil-works/pi-agent-core`) that autonomously picks skills/tools to answer questions and generate daily work briefs from the authorized user's Feishu data (messages, calendar, tasks). Multi-user mode: each user OAuth-authorizes the app; per-owner memory isolation in one SQLite DB (`var/office-memory.db`, all tables partitioned by `owner_key`, WAL mode).

Key architecture docs (do not duplicate here): `README.md`, `docs/runtime.md`, `docs/memory.md` in the repo root.

Model: DMall AI Router (`https://ai-router.dmall.com/v1`), currently **`deepseek-v4.1-flash-ali-new`** (switched from `gpt-5.6-luna` because that upstream was unstable/slow). Config in `.env` (not committed). Service: `npm run listen` from repo root; logs append to `bot.log`.

## Current operational state

- Service running (check with `ps aux | grep "main.ts listen"`; restart pattern: kill, then `(setsid nohup npm run listen >> bot.log 2>&1 < /dev/null &)` from `/home/wangjy/im_bot` — plain `nohup` without `setsid`/`< /dev/null` sometimes hangs the shell tool).
- Two WS consumers must show ready in `bot.log` on startup: `event_consumer_state: ready` AND `card_action_consumer_ready`. Both connections register handlers for both `im.message.receive_v1` and `card.action.trigger` (Feishu load-balances events across an app's connections).
- Memory warmer: startup +30s (7-day lookback) then daily at 07:30/12:30/23:00 (14-day rolling), per authorized user.
- OAuth callback server on port 37731 (public base URL configured in `.env`).
- Tests: `npm run verify` (typecheck + 62 unit tests + build). All green as of last commit.

## What was fixed this session (see git log for details)

1. **Card action consumer never started in multi-user mode** (Feishu error 200672): `startCardActionConsumer` early-returned on `!this.owner`. Also fixed v2 card event field mapping (`adaptCardActionEvent`, exported from `src/tenant/openapi-gateway.ts`).
2. **Reply dedup collision**: `replyKey()` used truncated base64, so "processing" and "final" replies for the same message produced identical Feishu uuids — final replies were silently swallowed server-side. Now uses SHA-256 `replyIdempotencyKey` from `src/infra/safety.ts`.
3. **Upstream model error retries**: `IM_BOT_PI_UPSTREAM_RETRIES` (default 3) in `src/agent/pi-runtime.ts`; matches `API error (NNN)` with 408/409/429/5xx plus phrase-based transient-overload detection (`isTransientOverloadMessage`) for statusless errors like "Our servers are currently overloaded".
4. **Owner-isolation race**: gateway read APIs now take explicit `ownerOpenId` per call (`resolveReadOwner`); warmer and message processing no longer share mutable `activeOwnerOpenId`. Regression tests in `test/owner-isolation.test.ts`.
5. **Chat/sender display names**: message sync APIs return IDs only; added `resolveDisplayNames()` (im.chats.get + im.chats.members, user token) + `OfficeMemory.backfillDisplayNames()` + integration in `ContextPreparer`. Fixes briefs showing "未命名群聊｜未知发送人".
6. **Sync speedup**: `fetchMessages` hydration now 10-way concurrent (30 msgs ≈ 1.2s vs ~45-60s serial); display-name resolution parallel per chat. Verified live.
7. **Repo restructure** (commit `154e4df`): deleted legacy codex runtime from parent dir, hoisted `pi_runtime/*` to `/home/wangjy/im_bot` root. All paths derive from source location, no config changes needed.

## Known open items / next steps

- **Fact extraction is now the brief bottleneck** (~100s of the ~2min brief): proposed but NOT implemented — make semantic extraction async (reply first from messages, extract facts after). User was told to ask for this if wanted.
- Thinking level still `IM_BOT_PI_THINKING=high` in `.env`; with the fast flash model this may be pointless overhead. Consider `medium`/`low` if briefs feel slow. Not yet benchmarked.
- Model `deepseek-v4.1-flash-ali-new` — watch for quality regressions vs gpt-5.6-luna in brief quality; switch back is a one-line `.env` change + restart.
- Server has no `sqlite3` CLI; use `node:sqlite` (`DatabaseSync`) probes for DB inspection. There are throwaway probe examples in this conversation's history; write new ones under `/tmp/opencode/` and clean up after.
- `.env` uses `IM_BOT_PI_OAUTH_PUBLIC_BASE_URL=http://10.12.6.143:37731` (server LAN IP) — fine internally.
- Upstream router reliability is variable (intermittent 503/504/overload). Retries (item 3 above) absorb most of it.

## Environment facts

- Node v24.20.0 via nvm; npm scripts from package.json (`listen`, `verify`, `once`, `demo`, etc.)
- `npm run check` (single-user lark-cli path) fails on this server with ENOENT — expected, no lark-cli installed; multi-user OpenAPI path is what runs.
- No systemd/launchd on this box — plain nohup + manual restart.
- User communicates in Chinese; prefers concise, evidence-driven answers with log/code references (file:line). Always run `npm run verify` before declaring work done, and restart the service after code changes.

## Suggested skills

Call the Skill tool for these when continuing:

- **diagnosing-bugs** — for any new "bot didn't reply / replied wrong / error code" report; the established loop is: read `bot.log` timeline, reproduce with a minimal read-only probe script under `/tmp/opencode/`, fix, add regression test, `npm run verify`, restart service.
- **implement** — for the pending fact-extraction-async work or other feature requests.
- **handoff** — at the end of the next long session, same as this one.
- **grilling / wait-what** — if the user challenges a technical claim (e.g. the WS load-balancing explanation) and clarification is needed.

## Sensitive-info notes

`.env` (not committed) holds the app secret and is readable only on the server; API key lives in `var/pi-auth/auth.json` (0600). Never print these in full — probe scripts should read them programmatically. User token records are in `var/tenant-user-tokens.json` (0600). Owner open_ids appearing in logs are internal identifiers, safe to reference by hash/prefix.
