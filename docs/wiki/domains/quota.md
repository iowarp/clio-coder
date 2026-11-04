---
title: "Quota and account usage"
summary: "How Clio reads subscription usage windows from provider accounts, caches the results, and journals and presents them. Read this when a quota figure looks wrong, when adding a provider adapter, or when changing how usage reaches the footer, banner, or telemetry."
sources:
  - "src/domains/quota/index.ts"
  - "src/domains/quota/cache.ts"
  - "src/domains/quota/observed.ts"
  - "src/domains/quota/reading.ts"
  - "src/domains/quota/presentation.ts"
  - "src/domains/quota/anthropic-usage.ts"
  - "src/domains/quota/codex-usage.ts"
  - "src/domains/quota/claude-code-provider.ts"
  - "src/domains/quota/antigravity-provider.ts"
symbols:
  - "createQuotaCache"
  - "noteQuotaRead"
  - "observedQuota"
  - "noteAnthropicStreamQuota"
  - "noteCodexStreamQuota"
  - "quotaReadingFromMessage"
  - "journalAccountQuota"
  - "journalPolledQuota"
  - "foldDuplicateAccounts"
  - "footerQuotaSegment"
  - "fetchAnthropicUsage"
  - "fetchCodexUsage"
  - "createClaudeCodeQuotaProvider"
  - "createAntigravityQuotaProvider"
tests:
  - "tests/contracts/quota-claude-code-provider.test.ts"
  - "tests/contracts/quota-views.test.ts"
  - "tests/contracts/quota-presentation.test.ts"
invariants:
  - "Within a quota cache, a snapshot younger than the TTL is served without calling the provider's fetch; an expired entry triggers one provider read (src/domains/quota/cache.ts:createQuotaCache)."
  - "A failed read does not erase the last good snapshot for the process observer; the stored snapshot is kept and marked stale (src/domains/quota/observed.ts:noteQuotaRead)."
  - "A quota reading is journaled only when its account fingerprint differs from the last journaled reading for the same provider and target (src/domains/quota/reading.ts:journalAccountQuota)."
  - "A window whose usedPct is not a finite number between 0 and 100 is dropped from a journaled reading (src/domains/quota/reading.ts:readingWindows)."
  - "The anthropic-max and claude-code snapshots for one account are folded into one entry only when their windows match in key, scope, reset time, and percentage (src/domains/quota/presentation.ts:foldDuplicateAccounts)."
  - "The Claude Code adapter does not issue a usage request when the stored access token is already expired per its own record (src/domains/quota/claude-code-provider.ts:createClaudeCodeQuotaProvider)."
validate:
  - "pnpm run test:file -- tests/contracts/quota-claude-code-provider.test.ts"
  - "pnpm run test:file -- tests/contracts/quota-views.test.ts"
---

# Quota and account usage

The quota area reads how much of a subscription window a provider account has used, keeps the newest reading for each account in process memory, journals changed readings to telemetry, and renders them in the footer, the welcome banner, and the usage overlays. A reader needs this page when a quota percentage, reset time, or staleness marker is surprising, when adding support for a new account type, or when changing how usage is folded or presented.

## What this area does

The area has three layers.

1. **Provider adapters** fetch a `UsageSnapshot` for one credential. Two Anthropic adapters and one Codex adapter share request and parsing code. Antigravity has its own adapter. Each adapter reads a credential the operator's CLI already stores and never writes it.
2. **Caches and observers** hold the newest reading. `createQuotaCache` in `src/domains/quota/cache.ts` serves reads within a TTL and spends one provider read otherwise. `src/domains/quota/observed.ts` is a process-wide map that every cache reports into, so the memory budget can read quota without spending a read of its own.
3. **Readings and presentation.** `src/domains/quota/reading.ts` converts snapshots and per-call observations into `QuotaReading` events and journals them. `src/domains/quota/presentation.ts` holds pure string and severity helpers for footers and banners.

`src/domains/quota/index.ts` is the barrel. It re-exports the observer functions, `QuotaReading`, and the journaling helpers. Its exports are `anthropicQuotaNotice`, `codexStreamSnapshots`, `noteAnthropicStreamQuota`, `noteCodexStreamQuota`, `observedAnthropicQuota`, `observedCodexQuota`, `observedQuota`, `onAnthropicQuotaChange`, `journalAccountQuota`, `quotaReadingFingerprint`, and `quotaReadingFromMessage`.

## Provider adapters

Adapter factories return a `QuotaProvider` with `detect()` and `fetch()`. `fetch()` returns a `UsageSnapshot` with a `status` of `ok`, `expired`, `no_credentials`, or `error`.

- `createClaudeCodeQuotaProvider` in `src/domains/quota/claude-code-provider.ts` reads `claudeAiOauth` from Claude Code's credential file via `parseClaudeCredentials`. Before any network call, `expiryMessage` checks the stored `expiresAt`. A token that has expired with a usable refresh token produces the message to run the `claude` command once. An expired token with no usable refresh token asks the operator to sign in again. Both return `status: "expired"` without a request.
- `fetchAnthropicUsage` in `src/domains/quota/anthropic-usage.ts` sends a GET with a bearer token and the OAuth beta header to `ANTHROPIC_USAGE_URL`. A 401 or 403 returns `expired`, a 429 returns `error` with the parsed `Retry-After`, and any other non-200 returns `error`. The `limits[]` array is preferred over the flat `five_hour` and `seven_day` buckets when it yields at least one window. Credits come from a `spend` block only when `enabled` is true.
- `fetchCodexUsage` in `src/domains/quota/codex-usage.ts` sends a GET to `CODEX_USAGE_URL` with the caller's identity headers and an optional `ChatGPT-Account-Id`. It classifies `primary_window` and `secondary_window` by `limit_window_seconds`: values of at least 86,400 seconds become `weekly`, and anything else becomes `session`.
- `createAntigravityQuotaProvider` in `src/domains/quota/antigravity-provider.ts` reads the agy CLI's token file and does not refresh tokens. It tries three endpoints in order. Each endpoint calls `loadCodeAssist`, then `retrieveUserQuotaSummary` when a project is present, and falls back to `fetchAvailableModels`. An auth failure on one endpoint moves to the next, and the adapter reports `expired` only when no endpoint returned windows and at least one returned an auth failure.

Each adapter takes injectable `fetch`, `timeoutMs`, `now`, and `readCredentials`, which is how the contract tests run without a network.

## Caching and the process observer

`createQuotaCache` keeps one entry per provider id. `resolve(provider)` returns the cached snapshot while `now() - storedAtMs < ttlMs`. Otherwise it calls `provider.fetch()`, then reports the result to the observer through `noteQuotaRead` and journals it through `journalPolledQuota`. When the fetch fails and an earlier entry exists, the journaled snapshot keeps the previous windows and is marked `stale: true`.

`noteQuotaRead` in `src/domains/quota/observed.ts` stores the snapshot for each provider id. An `ok` read replaces the entry. A failed read keeps the previous `snapshot`, records the new one as `latest`, and sets `retryUntilMs` from `retryAfterSeconds` when the value is finite. `observedQuota(providerId, nowMs)` reports the reading with `stale` set when the snapshot is marked stale or older than the cache TTL that stored it.

Stream observations are kept separately. `noteCodexStreamQuota` and `noteAnthropicStreamQuota` keep entries keyed by target and account scope, with `STREAM_QUOTA_TTL_MS` (five minutes). `noteAnthropicStreamQuota` ignores an observation older than one already stored for the same key. `onAnthropicQuotaChange` registers listeners that run when an Anthropic rate-limit status changes; listener exceptions are swallowed so that persistence still happens.

## Readings and journaling

`quotaReadingFromMessage(message, runtimeId, targetId)` in `src/domains/quota/reading.ts` produces a reading from a settled model message. It handles two runtimes. For `openai-codex` it reads `codexQuota` and maps it through `codexStreamSnapshot`, setting `source: "stream-event"`. For `anthropic-max` it reads `anthropicResponse` through `parseAnthropicHeaders` and sets `source: "response-headers"`. It returns `null` unless at least one window survives and `observedAt` is a UTC ISO instant.

`journalAccountQuota(reading)` keys its last-journaled fingerprint by `[provider, targetId]`. It emits a `quota.read` telemetry event only when `quotaReadingFingerprint` differs from the stored value. For `source: "poll"`, the fingerprint includes `observedAt`, so each fresh poll is treated as a new observation. For other sources, the fingerprint covers `limitReached`, status, plan, credits, message, retry seconds, stale flag, and each window's key, percentage, and reset time truncated to the minute.

The turn runtime is the main caller of the message path. In `src/session-control/turn-runtime.ts`, after a model call settles, `quotaReadingFromMessage` runs on the message. The result is attached to the settlement and `journalAccountQuota` is called when the call facts exist. `src/session-control/turn-persistence.ts` calls `noteCodexStreamQuota` and `noteAnthropicStreamQuota` as stream observations arrive.

`src/entry/orchestrator.ts` imports `observedQuota` and uses it when computing route quota for a dispatch decision.

## Presentation

`src/domains/quota/presentation.ts` is pure. It does not import terminal or theme code.

- `snapshotSeverity` returns the worst severity across a snapshot's windows and any Anthropic rate-limit status.
- `foldDuplicateAccounts` collapses `anthropic-max` and `claude-code` entries that report the same account. `sameAccount` requires both to be `ok`, to have the same non-empty window list with matching keys, scopes, reset times within one second, and percentages within half a point. When a twin has a `rateLimit`, that snapshot wins. Otherwise the one carrying a plan label survives.
- `footerQuotaSegment` builds the compact footer text. Weekly is the shared column, the session window is shown as `5h` only when present, and a binding scoped window is appended when it is neither of those.
- `quotaSummaryLine` appends the free local row built by `localQuotaSnapshot`.

The interactive layer consumes these helpers through `src/interactive/quota-view.ts` and `src/interactive/usage-overlay.ts`. `src/domains/quota/summary-feed.ts` is imported by the interactive presentation and usage overlay.

## Tests

- `tests/contracts/quota-claude-code-provider.test.ts` covers the Claude Code adapter. Its first case feeds a `limits[]` response that includes a `weekly_scoped` Opus entry, a `weekly_all` entry with a string `percent` of `"41.5"`, a `session` entry marked active, and an `All Models` scoped entry that must be dropped. It asserts that windows come back in `session`, `weekly`, `weekly_scoped.opus` order with `usedPct` 88, 41.5, and 12, that `credits` equals `$12.50 / $50.00` at 25%, and that the request URL and `Authorization` and `anthropic-beta` headers match the constants. A second case covers the flat `five_hour` and `seven_day` fallback. The file also imports `createQuotaCache` and `buildQuotaProviders`; those cases were not read.
- `tests/contracts/quota-views.test.ts` covers presentation. Its `foldDuplicateAccounts` test with two different provider ids keeps both entries. Its `quotaReadingFromSnapshot` import is used by the test file for reading construction.
- `tests/contracts/quota-presentation.test.ts` imports the presentation helpers and `createQuotaService`. It was located by search and not read in detail.

Searches covered `tests/` by module path. Codex, Antigravity, and Anthropic-max contract tests also import this area's modules; their assertions were not inspected.

## Things to watch when editing

- The observer and the cache are separate stores. `createQuotaCache` holds its own entries, and `src/domains/quota/observed.ts` holds a process-wide map that the cache writes into through `noteQuotaRead`. Changing the cache's freshness rule does not change the observer's rule unless the TTL passed to `noteQuotaRead` is also changed.
- A failed poll keeps the previous `snapshot` in the observer, but `latest` records the failure. Callers that need the failure should read `latest` through `observedQuota`'s source rather than assume the last snapshot is current.
- Fingerprints deliberately differ by source. A poll fingerprint includes `observedAt`; a stream or header fingerprint does not. Changing that rule changes how often identical readings are journaled.
- `foldDuplicateAccounts` relies on window key, scope, and reset time matching. A provider that reports a different key or reset time for the same account is not folded.
- Adapters must not write the credential files they read. The Antigravity adapter states that it does not refresh tokens, and the Claude Code adapter states that it reads Claude Code's file without writing it.
