# Handoff: Feishu Pi Agent Runtime — warming, welcome card, reliability

Date: 2026-09-12
Workspace: `im_bot/pi_runtime` (uncommitted changes on top of commit `19da6da`)
Prior context: conversation history feature (committed), memory/graph pipeline (committed, see `docs/memory.md` for architecture)

## What this session did (uncommitted work)

All changes are working tree only — the user has not committed yet. A ready-to-use commit message was drafted in the last session exchange (ask the user or re-derive from `git diff`). Summary:

1. **MemoryWarmer** (`src/agent/memory-warmer.ts`, new) — fixed-time daily warm-up (Shanghai tz, default `07:30,12:30,23:00` via `IM_BOT_PI_MEMORY_WARM_SCHEDULE`) + initial run 30s after startup. Shares the `ContextPreparer` pipeline with the online path (request cache + semantic-update mutex). Schedule validated at launchd install (`scripts/launchd.mjs validateConfig`) and runtime constructor. First completed run fires `onWarmedOnce`.
2. **Welcome card + card quick-tasks** (`src/agent/welcome-card.ts`, new) — Card 2.0 welcome card sent to owner after first warm-up; "今天的工作简报" button triggers via `card.action.trigger` consumer (dedicated long-connection, backoff restart, disable-after-5-failures without killing messaging). Button clicks validated against owner + prompt whitelist, then flow through the normal message pipeline with `replyToMessageId` targeting the card message.
3. **Auth retry** — `verifyUserAuthWithRetry` (3x, 2s/4s linear backoff) on the message path; absorbs transient lark-cli `--verify` flakiness.
4. **Critical fix: millisecond timestamps** — Feishu messages-search rejects any `.SSS` in ISO timestamps. `splitWindow`, `coverageFor` missingRanges, and warmer ranges now serialize to second precision. This was the root cause of all large-window sync failures.
5. **Extraction priority fix** — online `enrich` now takes an optional time window and extracts in-window (freshest first) before falling back to globally-oldest pending; warmer keeps oldest-first drain. Wired via `ContextPreparerOptions.prioritizeRequestWindow` (set in `memory-tools.ts`, not in warmer).
6. **Welcome card throttling** (latest change) — Feishu idempotency key now includes process start time (`welcome-card-${processStartTime}` in `lark-cli.ts`) so every restart may deliver; local throttle via `var/welcome-card.json` (`lastSentAt`, atomic write, default 15min via `IM_BOT_PI_WELCOME_CARD_THROTTLE_MINUTES`). Concurrency-guarded by `welcomeCardSendInFlight`.
7. **Docs restructure** — README slimmed to overview/usage/architecture index; `docs/memory.md` (incl. full knowledge-graph schema) and `docs/runtime.md` (message lifecycle, config reference) added; behavior-contract JSDoc on 6 core entry points.
8. **Ops** — `scripts/backfill-pending.mjs` (one-off pending drain; used once, stopped at user request); `.env` local changes (not committed, gitignored): `IM_BOT_PI_TIMEOUT_MS=1200000`, `IM_BOT_PI_MEMORY_WARM_MAX_CHUNKS=30`.

Tests: 20 → 39, all green (`npm run verify`).

## Current runtime state (live system)

- Service running via launchd (`com.local.im-data-collection.pi-bot`), logs at `logs/launchd.out.log`.
- Graph DB (`var/office-memory.db`): ~408 facts / 617 entities / 3079 edges; messages span 2026-08-28 → today. ~900-1500 pending messages remain (9/05-09, 9/11-12 range), draining at 30 chunks/warm-cycle by background schedule.
- The user has verified: welcome card arrives after warm-up completes; card button triggers the brief pipeline.
- Two brief-generation runs timed out (10min limit) before the timeout was raised to 20min in `.env`; system.md now has brief-workflow efficiency guidance (limit skills loaded, cap retrieval passes). Not yet re-verified after these changes — **the 20min timeout + efficiency guidance has not been confirmed by a successful button-triggered brief yet**.

## Known open issues / next steps

1. **Brief generation performance**: 16 turns / 44 tool calls / ~$0.07 per run and near the timeout ceiling. If it still times out, next lever is a dedicated slim toolset for brief tasks or trimming the daily-work-brief skill's required sources. Check `logs/launchd.out.log` for `message_processed` durations.
2. **`card.action.trigger` console subscription** is required (user has done it; `lark-cli event consume card.action.trigger --max-events 1 --timeout 10s` verifies). Also note the lark-cli event bus daemon can orphan (socket missing) — `lark-cli event status` shows it, kill the PID to recover.
3. **`Unknown` entities are 38%** of the entity table — extraction prompt could be tightened to classify or drop meaningless concept words.
4. **No retention/cleanup** for old data by design so far; if ever needed, prefer gzip-compressing `memory_raw_records` over deleting (replay value). See discussion in session; nothing implemented.
5. **Commit the work** — 24 dirty files; commit message drafted in prior exchange.
6. lark-cli 1.0.80 → 1.0.95 update available (not related to any current issue).

## Key facts about the codebase (non-obvious)

- Online extraction quota: `IM_BOT_PI_MEMORY_MAX_CHUNKS` (default 3) vs warmer `IM_BOT_PI_MEMORY_WARM_MAX_CHUNKS` (default 10; user set 30 locally).
- All `.env` config is read once at process start; no hot reload — restart required (launchd install script re-installs+restarts).
- The bot's own P2P chat is `assistant_control` — excluded from memory ingestion (guards.ts); conversation history is in-memory only (8 turns, 60min idle reset), lost on restart.
- `USER_MESSAGE_JSON` text is untrusted task data per `runtime/system.md` and repo `AGENTS.md`; read-only MVP — no writes to external state, host sends replies.
- SQLite is WAL + busy_timeout 5000; single-process assumption.
- lark-cli commands in `runReadOnlyCli` are gated by self-declared Risk level (only `Risk: read` allowed).

## Suggested skills

Call the Skill tool for these when relevant:

- **lark-im** — for card interactions, `+messages-send`/`+messages-reply` semantics, `card.action.trigger` consumer details (reference: `~/.agents/skills/lark-im/references/lark-im-card-action-reply.md` and `references/card/`).
- **lark-event** — before touching event consumers (`event consume`, daemon status, bounded runs).
- **lark-shared** — required prerequisite before any lark-cli command work; auth/identity rules.
- **diagnosing-bugs** — for the pending brief-timeout verification or any new runtime failure.
- **implement** — for the open items above (brief toolset slimming, entity classification tightening) once the user asks.

Do NOT call lark-* skills for pure codebase work; the repo's own `runtime/skills/` mirror is what the agent runtime loads.

## Verification commands

```bash
cd im_bot/pi_runtime
npm run verify          # typecheck + tests + build (39 tests)
node scripts/launchd.mjs status
grep -E "message_processed|memory_warmer_run_completed|welcome_card" logs/launchd.out.log | tail
sqlite3 var/office-memory.db "SELECT COUNT(*) FROM memory_messages m WHERE m.learning_eligible=1 AND NOT EXISTS (SELECT 1 FROM memory_chunk_messages cm JOIN memory_chunks c ON c.id=cm.chunk_id WHERE cm.message_id=m.id AND cm.message_revision=m.revision AND cm.role='primary' AND c.status='completed');"  # pending count
```

## Sensitivity

No secrets in this doc. Keys live in `var/pi-auth/auth.json` (0600, gitignored); owner/bot open IDs appear in logs but are internal handles, not secrets. Do not commit `.env`, `var/`, or `logs/`.
