# Handoff: Feishu autonomous IM bot runtime

Date: 2026-08-24 (Asia/Shanghai)

## Objective and user intent

Continue the single-owner Feishu personal-assistant bot. The owner expects a natural-language
request such as “what do I need to handle?” to be answered by reviewing today's user-visible
private and group messages and inferring unresolved actions. The runtime should autonomously
choose relevant read-only Lark skills and evidence sources; the host must not use keyword-based
tool routing.

The action-item interpretation is currently a semantic default in the runtime prompt/rules, not a
hard-coded command route. The owner has explicitly questioned this distinction, so preserve it:
the host supplies the goal, identity, safety boundary, and current time; the agent chooses tools,
sources, and follow-up inspections.

## Authoritative artifacts

Do not restate their contents; read these before changing behavior:

- Architecture, operations, configuration, and security boundary:
  [`im_bot/README.md`](../im_bot/README.md)
- Project/runtime policy:
  [`im_bot/AGENTS.md`](../im_bot/AGENTS.md) and
  [`im_bot/runtime/AGENTS.md`](../im_bot/runtime/AGENTS.md)
- Runtime prompt and Codex subprocess integration:
  [`im_bot/src/codex.mjs`](../im_bot/src/codex.mjs)
- Listener, owner gate, queue, reply fallback, and auth-refresh lifecycle:
  [`im_bot/src/service.mjs`](../im_bot/src/service.mjs)
- Lark CLI integration: [`im_bot/src/lark.mjs`](../im_bot/src/lark.mjs)
- Configuration: [`im_bot/src/config.mjs`](../im_bot/src/config.mjs)
- Tests: [`im_bot/test/`](../im_bot/test/)
- Earlier requirements and platform/framework research: [`docs/`](../docs/)

## Current verified state

- The macOS launchd service `com.local.im-data-collection.im-bot` is running and its event
  consumer reports `ready`.
- The implementation is owner-only, P2P input-only, read-only inside Codex, and replies through
  the host as the bot. User-scoped Lark reads use `--as user`.
- The former `classifyRoute`/`task_only` keyword router was removed. The dynamic prompt now
  supplies an exact Asia/Shanghai `todayStart` and `now`, an action-item evidence standard, and
  an explicit agent-led capability-selection rule.
- Critical rules now live in the actual Codex working directory (`im_bot/runtime/AGENTS.md`) as
  well as the dynamic prompt; previously only the parent `AGENTS.md` existed and was not guaranteed
  to load from `-C im_bot/runtime`.
- A time-bounded, empty-query `lark-cli im +messages-search --as user` request for today's messages
  succeeded, confirming that cross-chat retrieval does not require fixed keywords. The account has
  the message-search/read scopes needed for this flow.
- `npm test` passes all 10 tests and `npm run check` reports the Lark bot, user identity, event
  subscription, and Codex CLI as ready.
- The Codex subprocess timeout was raised from 240,000 ms to 600,000 ms (10 minutes) in source,
  example configuration, documentation, and tests. The service was reinstalled afterward.
- A post-change request completed successfully in about 321 seconds, so the new timeout is active.
  That run consumed approximately 530k input tokens (about 445k cached), 7.4k output tokens, and
  reported four transient Codex reconnect errors. This is now the main reliability/cost concern.

## Authorization status

- The host verifies/refreshes the current user token outside the Codex sandbox at startup, before
  requests, and periodically. Recent verification was valid.
- Calendar event read access is still missing. The only required additional scope found was
  `calendar:calendar.event:read`.
- A minimal device-authorization flow was started, but the owner did not confirm completion and its
  short-lived verification data has expired. Do not reuse or expose the old URL/device code. Start
  a fresh minimal flow if calendar access is still wanted, display its URL and PNG QR code, then
  finalize the device flow only after the owner confirms authorization.
- No application secret, access token, refresh token, user ID, chat ID, message ID, or personal
  message content is included in this handoff. Credentials remain in the local Lark CLI store, not
  in project source.

## Known issues and recommended next work

1. Measure why a simple action-summary request loads hundreds of thousands of input tokens. The
   likely contributors are the full Codex global context/skill catalog, exhaustive message pages,
   repeated tool context, and reconnect/retry behavior. Preserve autonomous planning while reducing
   irrelevant runtime context.
2. Add stage-level timing and sanitized Codex failure diagnostics. The current host logs only
   `Codex runtime failed`, and users receive a generic error for timeout, tool failure, or malformed
   output alike.
3. Consider a distinct timeout-facing reply and retry policy; do not silently rerun requests because
   the bot reply is an external write and deduplication semantics matter.
4. Re-test the exact owner request through Feishu while watching
   `im_bot/logs/launchd.out.log`. Validate that the answer cites human-readable sender/chat/time
   evidence, distinguishes definite actions from possible follow-ups, and does not expose IDs.
5. Complete and verify minimal calendar authorization only if the owner still wants calendar as an
   optional evidence source. Do not request a broad domain bundle.

## Suggested skills

- `lark-im`: review message search, pagination, chat/thread context, and human-readable evidence.
- `lark-event`: maintain and diagnose the real-time `im.message.receive_v1` consumer.
- `lark-shared`: inspect user-vs-bot auth state and run the minimal calendar authorization flow.
- `lark-calendar`: verify `calendar:calendar.event:read` and use calendar only when agent reasoning
  finds it relevant.
- `openai-docs`: check official Codex non-interactive runtime, `AGENTS.md`, context, configuration,
  and performance guidance before changing how `codex exec` is launched.

## Useful commands

Run from `im_bot/`:

```bash
npm test
npm run check
npm run service:status
tail -n 100 logs/launchd.out.log
tail -n 100 logs/launchd.err.log
```

Do not run `lark-cli auth login/logout` or `auth status --verify` from inside the sandboxed Codex
runtime. Authorization orchestration belongs to the host/operator session.
