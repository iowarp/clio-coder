---
title: "Domains quota"
summary: "How Clio reads Anthropic, Codex, and Antigravity subscription usage into shared snapshots, caches them with a 5-minute TTL instead of a background timer, and feeds the footer, welcome banner, and usage overlay."
sources:
  - "src/domains/quota/registry.ts"
  - "src/domains/quota/service.ts"
  - "src/domains/quota/cache.ts"
  - "src/domains/quota/types.ts"
  - "src/domains/quota/presentation.ts"
  - "src/domains/quota/summary-feed.ts"
  - "src/domains/quota/anthropic-max-provider.ts"
  - "src/domains/quota/claude-code-provider.ts"
  - "src/domains/quota/codex-provider.ts"
  - "src/domains/quota/antigravity-provider.ts"
  - "src/domains/quota/anthropic-usage.ts"
  - "src/interactive/interactive-presentation.ts"
symbols:
  - "createQuotaService"
  - "createQuotaCache"
  - "createQuotaSummaryFeed"
  - "buildQuotaProviders"
  - "fetchAnthropicUsage"
  - "footerQuotaSegment"
  - "quotaSummaryLine"
  - "localQuotaSnapshot"
  - "foldDuplicateAccounts"
tests:
  - "tests/contracts/quota-presentation.test.ts"
  - "tests/contracts/quota-tui.test.ts"
  - "tests/contracts/quota-local-target.test.ts"
  - "tests/contracts/quota-views.test.ts"
invariants:
  - "A usage read is spent only because a surface looked at a snapshot; there is no background timer."
  - "A provider failure never throws out of the service; it is reported as a snapshot status that surfaces render."
  - "Snapshots with status no_credentials are dropped from read() results, so absent accounts never render."
  - "A fresh snapshot inside the TTL suppresses further reads, and a failed read falls back to the last good snapshot marked stale."
  - "With a relocated Clio home, the claude-code, codex, and antigravity adapters are excluded unless CLAUDE_CONFIG_DIR, CODEX_HOME, or ANTIGRAVITY_HOME is set."
validate:
  - "pnpm run test:file -- tests/contracts/quota-presentation.test.ts"
---

# Domains quota

## What this area does

The quota domain turns provider subscription usage into a uniform, read-only
snapshot model and serves it to presentation surfaces without blocking the
render path. Four adapters read the accounts Clio can see: the Anthropic OAuth
credential Clio herself holds (`anthropic-max`), the Claude Code CLI's stored
login (`claude-code`), the Codex CLI's stored login (`codex`), and the
Antigravity (`agy`) CLI's token file (`antigravity`). A TTL cache sits between
adapters and callers so repeated looks do not spend repeated reads, and a set
of pure helpers in `presentation.ts` fold those snapshots into footer segments,
a welcome-banner line, and severity words.

The module's stated design constraint is lazy refresh: `src/domains/quota/service.ts`
opens with "Refresh stays lazy, as the decision log requires: no background
timer," and `src/domains/quota/cache.ts` repeats it, "Per the quota decision
log there is no standalone background timer." The only refresh triggers in
source are a caller invoking `read()` and the summary feed scheduling an
off-frame read after a surface's `peek()`.

## Ownership map

| Path | Role |
| --- | --- |
| `src/domains/quota/types.ts` | `UsageSnapshot`, `UsageWindow`, `QuotaProvider` contract, `parseRetryAfterSeconds`, `formatPlan` |
| `src/domains/quota/registry.ts` | `buildQuotaProviders()` assembles the four adapters in display order |
| `src/domains/quota/service.ts` | `createQuotaService()` with `peek()`, `read()`, `detected()` |
| `src/domains/quota/cache.ts` | `createQuotaCache()`, `DEFAULT_QUOTA_CACHE_TTL_MS = 5 * 60_000` |
| `src/domains/quota/anthropic-usage.ts` | `fetchAnthropicUsage()` shared by the two Anthropic adapters |
| `src/domains/quota/anthropic-max-provider.ts` | `createAnthropicMaxQuotaProvider()` reads Clio's own auth storage |
| `src/domains/quota/claude-code-provider.ts` | `createClaudeCodeQuotaProvider()` reads Claude Code's token file |
| `src/domains/quota/codex-provider.ts` | `createCodexQuotaProvider()` reads Codex's `auth.json` |
| `src/domains/quota/antigravity-provider.ts` | `createAntigravityQuotaProvider()` reads the `agy` token file |
| `src/domains/quota/presentation.ts` | severity, folding, `footerQuotaSegment`, `quotaSummaryLine`, `localQuotaSnapshot` |
| `src/domains/quota/summary-feed.ts` | `createQuotaSummaryFeed()` synchronous render-path reader |
| `src/interactive/interactive-presentation.ts` | composes the feed into welcome banner, footer, and fleet dock |

The quota domain has no index module; consumers import its modules directly.
The domain's own contract, stated in `src/domains/quota/types.ts`, is that
adapters stay pure data plumbing: "no UI, no dispatch admission, no credential
writes."

## The snapshot model

`UsageSnapshot` (`src/domains/quota/types.ts`) carries one provider's facts at
one instant: `providerId`, `displayName`, a `QuotaStatus`
(`"ok" | "no_credentials" | "expired" | "error" | "loading"`), a list of
`UsageWindow`, optional `credits`, `plan`, `message`, `retryAfterSeconds`, a
`stale` flag, and an ISO 8601 `fetchedAt`. Windows carry a stable `key`
(`"session"` or `"weekly"` for the shared columns, `weekly_scoped.<name>` for
per-model Anthropic scopes, `group.<n>.<key>` and `model.<name>` for
Antigravity), a `usedPct` of 0–100, an ISO `resetsAt`, a compact `short` label,
an optional `scope`, a provider-supplied `severity`, and an `active` flag.
Timestamps are strings, not `Date`, so a snapshot stays cloneable across the
worker and transport boundaries.

`QuotaProvider` requires `id`, `displayName`, `detect()` (credential present,
no network), and `fetch()` (returns a snapshot and never throws, by contract).

## Provider adapters

### Registry and home-relocation gating

`buildQuotaProviders()` (`src/domains/quota/registry.ts`) returns the adapters
in display order: `anthropic-max`, then `claude-code`, `codex`, `antigravity`,
each wrapped in a guard:

```ts
...(!isClioHomeRelocated() || process.env.CLAUDE_CONFIG_DIR?.trim() ? [createClaudeCodeQuotaProvider()] : []),
```

`isClioHomeRelocated()` (`src/core/xdg.ts:114`) is true when any of the four
`CLIO_CODER_{CONFIG,DATA,STATE,CACHE}_DIR` roles differs from the platform
default. Under a relocated home the external adapters are omitted because their
default credential paths would point at the operator's real home; setting the
matching env var (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `ANTIGRAVITY_HOME`) keeps
them. The `anthropic-max` adapter is never gated this way, because its
credential lives in Clio's own storage. The file also marks a reserved slot:
"The copilot adapter attaches here once its credential shape is confirmed."

### Anthropic adapters and the shared endpoint

Both Anthropic adapters call `fetchAnthropicUsage(token, { fetch, timeoutMs })`
(`src/domains/quota/anthropic-usage.ts`), a GET on
`https://api.anthropic.com/api/oauth/usage` with an `anthropic-beta:
oauth-2025-04-20` header. The endpoint has shipped two window shapes and can
send both at once; `limits[]` wins because only it carries `severity`,
`is_active`, and per-model scope, with `five_hour`/`seven_day` flat buckets as
fallback. HTTP 401/403 maps to `"expired"`, 429 to `"error"` with
`retryAfterSeconds` parsed from the `Retry-After` header, anything else to
`"error"`. The `spend` block becomes `credits` when `enabled` is true.

`createAnthropicMaxQuotaProvider()` (`src/domains/quota/anthropic-max-provider.ts`)
reads Clio's own stored OAuth record: `openAuthStorage().get("anthropic")`
(`src/domains/providers/auth/storage.ts`), which unlike `resolveApiKey` does
not renew an expiring credential as a side effect. A quota read must never
mutate an authentication record, the file says. If the token's `expiresAtMs`
is past, it returns `"expired"` with advice ("the next turn refreshes it" when
a refresh token exists), skipping the network entirely.

`createClaudeCodeQuotaProvider()` (`src/domains/quota/claude-code-provider.ts`)
reads Claude Code's own `~/.claude/.credentials.json` (or
`$CLAUDE_CONFIG_DIR/.credentials.json`), parsing the `claudeAiOauth` record.
Its `expiryMessage()` distinguishes two cases from the record alone: an expired
access token with a live refresh token means "run the claude command once to
refresh it"; without a usable refresh token the advice is to sign in again. It
is the only Anthropic adapter that stamps a `plan` field, via
`formatPlan(credentials.subscriptionType)`.

### Codex adapter

`createCodexQuotaProvider()` (`src/domains/quota/codex-provider.ts`) reads
`$CODEX_HOME/auth.json` or `~/.codex/auth.json` for `tokens.access_token` and
`tokens.account_id`, then GETs `https://chatgpt.com/backend-api/wham/usage`
with `User-Agent: codex-cli` and, when present, a `ChatGPT-Account-Id` header.
`rate_limit.primary_window` maps to key `session` (label "5h") and
`secondary_window` to `weekly`, but `windowKey()` reclassifies by the
`limit_window_seconds` value: 86400 seconds or more means weekly. Credits come
from the `credits` block: `unlimited: true` renders "Unlimited", and a
`has_credits` balance renders the raw string. 401/403 is `"expired"`.

### Antigravity adapter

`createAntigravityQuotaProvider()` (`src/domains/quota/antigravity-provider.ts`)
reads `$ANTIGRAVITY_HOME/antigravity-oauth-token` or
`~/.gemini/antigravity-cli/antigravity-oauth-token`. It is deliberately
narrower than a general OAuth client: there is no token refresh, because
"Refreshing would mean POSTing another product's refresh token to Google with
client credentials scraped out of the agy binary." A stored token within 60
seconds (`EXPIRY_SKEW_MS`) of expiry is treated as already expired, and the
message tells the operator to run `agy` once.

The fetch loops over three endpoints in order
(`daily-cloudcode-pa.googleapis.com`, its sandbox, then
`cloudcode-pa.googleapis.com`). Per endpoint, `collect()` first POSTs
`v1internal:loadCodeAssist` to discover the `cloudaicompanionProject` and
`currentTier`, then prefers `v1internal:retrieveUserQuotaSummary` when a
project exists and the summary yields windows. The fallback is
`v1internal:fetchAvailableModels`, which reports per-model quotas for names
starting with `gemini`, `claude`, `gpt`, `image`, or `imagen`. Summary groups
are preserved in order with Gemini groups sorted first; windows from the
second group onward get keys prefixed `group.<index>.`. A 401/403 on any
endpoint is remembered as `sawAuthFailure` and wins at the end ("Sign in with
Antigravity again"), while transport errors roll into the last message.

## Lazy refresh through the cache and service

`createQuotaCache()` (`src/domains/quota/cache.ts`) keeps one entry per
provider (`Map<string, { snapshot, storedAtMs }>`) with a clock injected for
tests. Its methods:

- `read(providerId)` returns the snapshot only inside the TTL.
- `readLastGood(providerId)` returns the snapshot regardless of age, copying
  it with `stale: true` when expired.
- `write(snapshot)` stores a new last-good value with the current clock.
- `clear(providerId?)` drops one entry or all.
- `resolve(provider)` is the refresh entry point: fresh cache hits return
  immediately; otherwise `provider.fetch()` runs, an `"ok"` result is written,
  and a failed result falls back to the cached entry marked `stale` with the
  failure's message preferred. A failure with no prior entry passes through.

`createQuotaService()` (`src/domains/quota/service.ts`) owns the provider list
(default `buildQuotaProviders()`) and a cache
(default `createQuotaCache()` with the 5-minute TTL). Its three methods:

- `peek()` serves `cache.readLastGood()` for every provider, so a first paint
  never spends a read; expired entries come back marked `stale`.
- `read()` fans out `cache.resolve(provider)` to all providers concurrently
  with `Promise.all` "because they are independent accounts, and a slow one
  must not hold up the others." A thrown provider error is caught per provider
  and converted to an `"error"` snapshot, and the result filters out
  `no_credentials` entries.
- `detected()` runs every provider's `detect()` concurrently and returns the
  ones holding usable credentials, without spending a usage read.

The service also appends the local-inference row. `includeLocal` defaults to
"any configured target whose runtime tier is `local-native`" (read once at
construction from `readSettings().targets` and `getRuntimeRegistry()`), and
`localRuntimeLabel` overrides the display name. The local row is built by
`localQuotaSnapshot()` (`src/domains/quota/presentation.ts`): provider id
`"local"`, empty windows, `credits: { display: "$0.00", usedPct: null }`,
`plan: "Local"`, and the message "no subscription window consumed". Its
comment says the saved-quota figure is deliberately absent because proving it
needs per-target token attribution this slice does not collect.

### Render-path flow

The interactive session wires the pieces in
`src/interactive/interactive-presentation.ts`. It creates the feed once:

```ts
const quotaSummary = createQuotaSummaryFeed({
	onUpdate: () => { footer?.refresh(); requestRender(); },
});
```

The feed (`src/domains/quota/summary-feed.ts`) is the bridge that makes a
synchronous render path safe. `peek()` answers from the last reading
immediately; when that reading is missing or older than `QUOTA_SUMMARY_TTL_MS`
(5 minutes), it schedules `refresh()`, which returns synchronously while a
detached `void Promise.resolve().then(...)` chain runs `service.read()`. The
`inFlight` flag deduplicates concurrent refreshes, and `onUpdate` fires only
when `JSON.stringify(nextSnapshots) !== JSON.stringify(snapshots)`, which is
how a repaint is requested. `dispose()` sets a flag that makes refresh and
onUpdate inert, called from the teardown path before other subscriptions go.
The welcome dashboard receives `getQuotaSummary: () => quotaSummary.peek()`
(the comment at `interactive-presentation.ts:270` says "the banner reads a
string and never awaits a provider"), the fleet dock and footer receive
`getQuotaSnapshots: () => quotaSummary.peekSnapshots()`.

```mermaid
sequenceDiagram
    participant R as Welcome banner / footer
    participant F as QuotaSummaryFeed
    participant S as QuotaService
    participant C as QuotaCache
    participant P as QuotaProvider(s)

    R->>F: peek()
    alt no reading or read older than 5m
        F-->>R: null or last line
        F-)F: schedule refresh() (off frame)
        F->>S: read()
        loop per provider, concurrently
            S->>C: resolve(provider)
            alt cached entry fresh
                C-->>S: cached snapshot
            else expired or absent
                C->>P: fetch()
                alt ok
                    P-->>C: snapshot
                    C-->>S: snapshot (written as last good)
                else failed and prior entry exists
                    P-->>C: failed snapshot
                    C-->>S: stale-marked last good
                else failed and no prior entry
                    P-->>C: failed snapshot
                    C-->>S: failed snapshot
            end
        end
        S-->>F: snapshots (no_credentials dropped, local appended)
        F->>F: quotaSummaryLine() + change detection
        F--)R: onUpdate() -> footer.refresh(), requestRender()
    else reading still warm
        F-->>R: cached line
    end
```

## Presentation helpers

`severityForPct()` (`src/domains/quota/presentation.ts`) classifies a window
at 60% caution, 80% warning, 95% critical, else normal. `windowSeverity()`
prefers the provider's own word when it is one of the four recognized
severities ("Anthropic sends its own `severity` and that is preferred");
`snapshotSeverity()` returns the worst window.

`primaryWindow()` picks the window closest to biting, by severity rank then by
higher `usedPct`. `foldDuplicateAccounts()` folds `anthropic-max` and
`claude-code` snapshots that describe the same account: both must be `"ok"`,
carry the same number of windows with matching keys, scopes, and `usedPct`
within 0.5, and `resetsAt` equal or within 1 second of each other (the live
endpoint adds per-response milliseconds). When folded, the snapshot carrying a
`plan` label survives.

`footerQuotaSegment()` renders one compact segment per account: the `session`
window as "5h X% used", the `weekly` window as "wk X% used", plus the
`primaryWindow` when it is a scoped window neither of those (the binding limit),
or falls back to the primary window's `short`/`label` when the provider names
neither column. Accounts are joined with " · " and display names shortened to
their first word. `quotaSummaryLine()` appends the local row's credit display
("Local $0.00") after the paid segments, so free local inference is visible
rather than omitted.

The interactive layer colors and renders these strings: `src/interactive/quota-view.ts`
(`renderQuotaAccounts`, `routeWeeklyQuota`, `workerQuotaLabel`, `quotaMeter`)
is consumed by the footer status page (`src/interactive/footer/pages.ts`), the
usage overlay (`src/interactive/usage-overlay.ts`), and the dispatch board
(`src/interactive/dispatch-board.ts`).

## Enforced boundaries and lifecycle

- **No network on the render path.** `QuotaSummaryFeed.peek()` and the welcome
  dashboard's `getQuotaSummary()` supplier are synchronous; the feed defers the
  actual read to a detached promise, documented in
  `src/domains/quota/summary-feed.ts` as keeping "the decision log's lazy
  refresh rule: a read happens because a surface was looked at, never on a
  timer."
- **Provider failures degrade, never throw.** `service.read()` catches per
  provider and returns an `"error"` snapshot; the feed's `.catch()` leaves the
  previous line standing because reaching it means "something outside the
  adapters broke, and the banner should not start flickering because of it."
- **Credential isolation.** The registry gates external adapters on
  `isClioHomeRelocated()` and the env-var overrides; each file-based adapter
  also returns `null` from its default path when relocated and the override is
  unset.
- **Read-only credentials.** `anthropic-max` uses `AuthStorage.get()` instead
  of `resolveApiKey()` to avoid a refresh side effect; the three external
  adapters read files and never write them; `antigravity` explicitly refuses
  to refresh tokens.
- **Failure precedence in Antigravity.** Auth failures on any endpoint
  override transport errors across the endpoint loop, and the first endpoint
  whose windows are non-empty ends the loop.
- **Snapshot staleness is preserved.** `cache.readLastGood()` and the
  `resolve()` fallback both set `stale: true`, and surfaces render it
  ("STALE · last good reading" in `src/interactive/quota-view.ts`).

## Extension seams

- **New provider adapter.** Implement `QuotaProvider` (`id`, `displayName`,
  `detect`, `fetch`) with failure reported as snapshot status, then add the
  factory call in `buildQuotaProviders()` (`src/domains/quota/registry.ts`) at
  the desired display position. The copilot comment marks the intended next
  slot. A relocated-home guard following the existing pattern keeps tests and
  relocated deployments isolated.
- **New shared Anthropic surface.** `fetchAnthropicUsage()` already centralizes
  the endpoint and both window shapes; a new adapter on the same account
  supplies its own token and stamps its own `providerId`/`displayName`, as the
  two existing adapters do.
- **New compact surface.** Add a helper in `src/domains/quota/presentation.ts`
  operating on `UsageSnapshot[]`; keep it free of terminal and theme imports
  so the interactive layer decides color, as the module header requires.
- **Fold rules.** If a third credential can sit on an Anthropic account,
  `foldDuplicateAccounts()`'s hardcoded `{"anthropic-max", "claude-code"}` set
  is the place to widen.

## Focused tests

`tests/contracts/quota-presentation.test.ts` (run with
`pnpm run test:file -- tests/contracts/quota-presentation.test.ts`):

- "classifies severity by threshold and prefers the provider's own word":
  asserts `severityForPct(60)` = caution, 80 warning, 95 critical, and that a
  window with `severity: "normal"` at 99% stays normal while an unrecognized
  word falls back to the threshold.
- "reports a snapshot's worst window as its severity": a mixed 3%/88% snapshot
  is warning; an empty window list is normal.
- "picks the window closest to biting as the compact one": a weekly-only Codex
  snapshot returns the weekly window as primary.
- "folds two credentials that report the same account, keeping the labelled one":
  identical anthropic-max/claude-code windows fold to one entry, the
  claude-code snapshot with `plan: "Max"` surviving.
- "keeps genuinely different accounts apart": claude-code, codex, and
  antigravity snapshots stay three.
- "builds a compact footer segment, showing 5h only where a provider reports one":
  asserts the exact string
  `"Claude 5h 6% used/wk 9% used · Codex wk 76% used · Antigravity 5h 0% used/wk 73% used"`,
  establishing that Codex's weekly-only account gets no 5h column.
- "reads every provider concurrently and appends the free local row": with two
  fake providers and `includeLocal: true`, the first `read()` spends one fetch
  per provider, drops the `no_credentials` provider, and appends `local`; a
  second `read()` spends zero fetches for the good provider but one for the
  absent one, "since signing in must take effect."
- "survives a provider that throws instead of returning a snapshot": the broken
  provider yields an `"error"` snapshot with the thrown message, and
  `detected()` returns empty.
- "peeks without spending a read": `peek()` returns empty before any read and
  still spends zero fetches.

`tests/contracts/quota-tui.test.ts`:

- "quota feed shares one lazy read, refreshes detail-only changes, and stops on disposal":
  a fake service with `ttlMs: 100` and an injected clock; the first `peek()`
  returns null and schedules exactly one read; after the read,
  `onUpdate` fired once; advancing the clock 101ms and making all snapshots
  `stale` fires a second read and a second update "even when the percentage
  summary is unchanged"; `dispose()` then suppresses further reads.
- "welcome subscriptions stay in the field list and wrap without dropping accounts or local cost":
  renders `createWelcomeDashboard` at widths 40–220 and asserts every account
  and "Local $0.00" survive, in field order Targets → Subscriptions → Fleet.
- "footer keeps unassociated accounts out of compact rows and supplies all accounts to Status":
  the compact footer row contains none of the account names, while the expanded
  status page shows "Claude Code (Max) ... 5h 6% ... Weekly 9%", "Codex (Pro)
  ... Weekly 76%", and "Local AI ... $0.00".
- "footer producer follows selected runtime changes instead of picking the busiest account":
  the selected runtime "claude" shows "weekly 91% left" and no other account;
  switching to a local target removes quota rows entirely.

`tests/contracts/quota-local-target.test.ts`: with an isolated env
and empty provider list, configuring a target with runtime `openrouter` yields
no local row from `peek()`/`read()`, switching the same target to runtime
`ollama` yields exactly one `local` snapshot, and `includeLocal: false` forces
empty.

`tests/contracts/quota-views.test.ts`:

- "reset labels include a countdown, local wall time, timezone, and an honest elapsed state":
  `quotaResetLabel` renders "in 1h 0m" with wall clock and timezone, "in 2d 2h"
  for longer durations, and "Reset time passed · awaiting provider update" for
  a past instant.
- "meters show consumed capacity consistently and remain bounded": 0% is all
  empty glyphs, 120% and -10% both clamp to full width.
- "equal percentages across providers never merge unrelated accounts": codex
  vs antigravity stay two; claude-code vs anthropic-max fold to one even when
  `resetsAt` drifts by 70ms, but not when one side is `null`.
- "worker quota joins only known local credential owners and does not claim a per-worker share":
  `workerQuotaLabel` links `antigravity-code` to the Antigravity account, says
  "unavailable for remote credentials" for a remote node, and "not linked" for
  runtimes without a local credential owner.
- "weekly badges select the model's own group and never infer another account's quota":
  `routeWeeklyQuota` matches a gemini model to the Gemini group and claude/gpt
  models to the other group on Antigravity, returns null for unknown models,
  remote nodes, unrelated runtimes, expired accounts, and model-scope-only
  windows, and prefixes "STALE · " when the account is stale.

## Things to watch when editing

- **The two Anthropic adapters share one endpoint.** New window shapes must be
  handled in `anthropic-usage.ts` for both adapters to see them; the
  `limits[]`-over-flat-buckets precedence is intentional because only the array
  carries severity, active, and scope.
- **`limits[]` is preferred when non-empty** even if flat buckets are also
  present, per the observed double-serving; adding a third shape needs the same
  precedence care.
- **The 1-second `resetsAt` tolerance in `foldDuplicateAccounts()`** exists
  because the live endpoint adds per-response milliseconds; tightening it
  re-splits the same account into two budgets, and the 0.5% `usedPct`
  tolerance covers the same drift.
- **Antigravity has no refresh on purpose.** Adding one means POSTing a
  refresh token to Google with credentials scraped from the `agy` binary,
  which the file comments reject; the 60-second expiry skew is the only
  softening.
- **The Antigravity endpoint list is an ordered fallback**, and auth failure
  on a later endpoint is recorded even if earlier endpoints succeeded
  silently; reordering changes which error wins.
- **`includeLocal` is resolved once at `createQuotaService()` construction**,
  from live settings; a target added at runtime is not picked up until a new
  service exists (the summary feed keeps one service for the session).
- **`service.read()` drops `no_credentials` but `service.peek()` does not**:
  `peek()` returns every last-good snapshot as-is (status included), so a raw
  consumer can see `no_credentials` entries, while a fresh `read()` never does.
  The feed's string line is unaffected either way, because
  `footerQuotaSegment()` skips snapshots whose status is not `"ok"`.
- **The cache is in-memory and per-service-instance**; the file says persisting
  across sessions is a later concern. There is no eviction besides `clear()`.
- **The local row's `$0.00` is a display constant**, not a measurement; do not
  add cost accounting expectations to `localQuotaSnapshot` without the
  per-target attribution the comment says is missing.


