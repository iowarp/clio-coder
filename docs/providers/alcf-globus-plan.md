# Implementation Plan: ALCF / Globus provider for clio-coder

Status: **implemented** — see [`alcf.md`](alcf.md) for user setup. All
components below are built; typecheck/lint/build are clean and 22 contract
tests pass (`tests/contracts/alcf-oauth.test.ts`,
`tests/contracts/alcf-runtime.test.ts`). Deviation from this plan:
`@globus/sdk` was dropped in favour of a hand-rolled PKCE flow — pi-ai's own
Anthropic provider establishes that exact pattern in-tree (fetch + PKCE, no
SDK), and `@globus/sdk` is browser-oriented and was not a dependency. The one
remaining manual step is a live login against real Globus plus a real chat
call, which needs an eligible Globus identity and cannot run in CI.

Target: add Argonne ALCF inference (Sophia + Metis) as a first-class provider,
authenticated via Globus, for public users who start with no token.

## Context

ALCF exposes vLLM-backed, OpenAI-compatible model servers on the public
internet behind one gateway (`https://inference-api.alcf.anl.gov`). Access
requires a short-lived Globus access token tied to an `anl.gov` /
`alcf.anl.gov` (or affiliated) identity. The prior art is `clio-agent`
(Python), whose `src/clio_agent/providers/argonne_auth.py`,
`providers/registry.py`, and `scripts/list_alcf_models.py` we port from.

The key architectural insight: **the entire Globus apparatus exists only to
deposit a bearer token on the system.** Everything downstream is plain
`Authorization: Bearer <token>` against an OpenAI-compatible endpoint.
clio-coder's auth layer already separates "collect the token" (`login`) from
"hold + refresh it" (`AuthStorage`) from "use it" (`getApiKey`), so all
Globus-specific code collapses into one `OAuthProviderInterface`.

## Locked decisions

- **Globus plumbing:** the official `@globus/sdk` (lower-level PKCE +
  token-exchange helpers; NOT its browser-oriented `AuthorizationManager`).
- **Login UX:** paste-the-code. Show URL -> Enter to open (or paste link into
  any browser) -> log in -> paste the returned **code** -> CLI exchanges it
  for tokens. No localhost / loopback server (it breaks over SSH, which ALCF
  users rely on).
- **Token storage:** clio-coder's native `AuthStorage` (YAML). Users start
  with no token; no reuse of `~/.globus`.
- **Coverage:** Sophia + Metis, one runtime, per-endpoint URL.
- **Wire protocol:** OpenAI-compatible (`openai-completions`). No
  double-`openai/` prefix hack (that was a LiteLLM quirk; pi-ai sends the
  model id literally).

## How the login flow works (reference)

Two halves, only the second was ever in question:

1. **Outbound** (get the user to the login page): print the authorize URL;
   Enter opens the local browser; if there is no local browser, the user
   pastes the URL into a browser on any machine.
2. **Return** (get the one-time **code** back to the terminal): Globus
   displays the code on its own page; the user pastes it into the terminal.
   The CLI then exchanges the code (PKCE) for access + refresh tokens.

The user only ever handles a short-lived **code**; the CLI derives and stores
the **tokens** and auto-refreshes them. localhost is deliberately NOT used:
it would require the browser and the CLI to be on the same machine, which is
false over SSH.

## Pre-flight verification (do FIRST, before coding)

The only items not yet pinned down without installed deps / live docs:

1. `npm install`, then read pi-ai's exact types in
   `node_modules/@earendil-works/pi-ai`: `OAuthProviderInterface`,
   `OAuthCredentials`, `OAuthLoginCallbacks`. The login-callback shape decides
   how the paste prompt is surfaced (a callback that returns the pasted code
   vs. a device-code-only model). If pi-ai's callbacks cannot express "prompt
   for a pasted code," register the provider but drive `login()` through our
   own terminal prompt.
2. Confirm `@globus/sdk` exposes Node-usable PKCE + token-exchange primitives
   (PKCE via Web Crypto; Node 18+). Confirm the manual-code redirect
   (`redirect_uri = https://auth.globus.org/v2/web/auth-code`) is supported.
3. Confirm refresh-token issuance params for the Globus native/public client,
   and the token-per-resource-server extraction (pick the token whose
   `resource_server === GATEWAY_CLIENT_ID`).

## Component A - Globus OAuth provider

**New file:** `src/engine/oauth/globus-provider.ts` (engine boundary - the
only place allowed to value-import `@globus/sdk` and pi-ai).

Implements pi-ai's `OAuthProviderInterface`:

```
id   = "globus"
name = "Globus (ALCF)"
login(callbacks): Promise<OAuthCredentials>     // paste-the-code PKCE flow
refreshToken(creds): Promise<OAuthCredentials>  // grant_type=refresh_token
getApiKey(creds): string                        // gateway-scoped access token
```

Ported constants (verbatim from clio-agent `argonne_auth.py`, so ALCF's own
ecosystem stays compatible):

```
AUTH_CLIENT_ID    = 58fdd3bc-e1c3-4ce5-80ea-8d6b87cfb944
GATEWAY_CLIENT_ID = 681c10cc-f684-4540-bcd7-0b4df3bc26ef
GATEWAY_SCOPE     = https://auth.globus.org/scopes/681c10cc-f684-4540-bcd7-0b4df3bc26ef/action_all
ALLOWED_DOMAINS   = anl.gov, alcf.anl.gov   -> session_required_single_domain
```

`login()` steps: generate PKCE verifier/challenge -> build authorize URL
(gateway scope + refresh + `session_required_single_domain`) -> print URL /
open browser -> read pasted code from terminal -> exchange at
`https://auth.globus.org/v2/oauth2/token` -> return `{access, refresh,
expires}` selecting the **gateway resource-server's** token.

**Wire-in:** `src/engine/oauth.ts` already exports
`registerEngineOAuthProvider`. Add `registerClioOAuthProviders()` (new
`src/engine/oauth/index.ts` or fold into the existing module) that registers
the Globus provider; call it once at boot from the providers domain
`extension.ts start()`, alongside `registerClioApiProviders()` /
`registerBuiltinRuntimes()`.

## Component B - ALCF runtime descriptor

**New file:** `src/domains/providers/runtimes/cloud/alcf.ts`. Register in
`runtimes/builtins.ts`.

```
id: "alcf", displayName: "ALCF Inference (Globus)"
kind: "http", tier: "cloud", apiFamily: "openai-completions", auth: "oauth"
defaultCapabilities: { chat, tools, reasoning (gpt-oss), contextWindow, maxTokens: 4096 }
synthesizeModel: -> synthesizeOpenAICompatModel(...)   // model id sent literally
probe / probeModels: custom (see below)
```

**Custom discovery** (porting `scripts/list_alcf_models.py`):

- Parse cluster from `endpoint.url` (`/sophia/` vs `/metis/`);
  `framework = cluster === "metis" ? "api" : "vllm"`.
- `probe`: GET `https://inference-api.alcf.anl.gov/resource_server/list-endpoints`
  with `Bearer` -> `clusters[cluster].frameworks[framework].models`
  (liveness + catalog in one call).
- `probeModels`: same catalog, annotated by best-effort GET
  `.../resource_server/{cluster}/jobs` (`running[].Models`, comma-separated).
  Jobs failure must NOT fail discovery.
- The bearer comes from auth resolution (oauth), not an env var.

## Component C - endpoint seeding (the two public clusters)

There is no shipped "default endpoint catalog"; endpoints are created via
`clio configure` (writes `settings.endpoints`). `clio-managed` lifecycle is
about local servers clio launches, not remote ones. Sophia and Metis are
fixed public URLs, so the runtime should advertise them and `configure`
should seed both after Globus login.

- Sophia -> `url: https://inference-api.alcf.anl.gov/resource_server/sophia/vllm/v1`,
  `auth.oauthProfile: "globus"`, `defaultModel: openai/gpt-oss-120b`
- Metis  -> `url: https://inference-api.alcf.anl.gov/resource_server/metis/api/v1`,
  `auth.oauthProfile: "globus"`, `defaultModel: gpt-oss-120b`

**Design choice at implementation:** either (a) add a lightweight "suggested
endpoints" concept the `clio configure` ALCF path reads, or (b) hardcode the
two seed descriptors in the configure flow when the user picks the `alcf`
runtime / connects Globus. Recommend (b) first (smaller, no schema change);
promote to (a) if a second multi-endpoint provider appears.

## Component D - model knowledge base

Add ALCF model metadata so capabilities resolve without probing. The existing
`openai-gpt-oss` family entry in
`src/domains/providers/models/local-models/clio-local-coding-targets.yaml`
already covers GPT-OSS. Add entries (or a small ALCF KB file) for
`Llama-4-Maverick-...` and `Llama-4-Scout-...` (context windows, tools, no
vision). Wire through the existing `FileKnowledgeBase` loader.

## CLI / auth surface

- `clio auth login globus` (+ logout/status) should route through
  `ProvidersContract.auth.login("globus", callbacks)` -> `AuthStorage.login`
  -> our provider. Verify the existing `src/cli/auth.ts` device-code callback
  rendering works for the paste flow, or add a paste-prompt branch.
- `clio configure` ALCF path seeds the endpoints (Component C).

## Task sequence

1. **Pre-flight (see above):** install deps, read pi-ai OAuth types, confirm
   `@globus/sdk` Node usage + refresh + resource-server token selection.
   *Gate: `login()` design confirmed.*
2. **Globus provider (A)** + boot registration. **Test:** unit-test
   `getApiKey` / resource-server selection and `refreshToken` request shaping
   with mocked HTTP; one manual end-to-end `login` against real Globus.
3. **ALCF runtime (B)** + builtins registration. **Test:** unit-test
   cluster->framework parsing and catalog/jobs parsing with fixture payloads.
4. **Endpoint seeding + configure (C)** and **auth CLI.** **Test:** `clio
   configure` creates both endpoints with `oauthProfile: globus`;
   `providers.list()` shows them; `probeEndpoint` returns live models.
5. **Knowledge base (D).** **Test:** capabilities resolve for
   `openai/gpt-oss-120b` and Llama-4 without a probe.
6. **Integration:** end-to-end chat turn against Sophia and Metis; token
   auto-refresh (force-expire a stored cred, confirm silent refresh).

## Key risks / watch-items

- **pi-ai `OAuthProviderId` may be a closed union** - registering `"globus"`
  could need a cast or a widened wrapper signature. Low risk;
  `registerEngineOAuthProvider` exists for exactly this.
- **Token-per-resource-server selection** - the single most likely
  correctness bug; must pick the gateway token, not the top-level one.
- **Refresh-token issuance** - must confirm the native/public client issues
  refresh tokens, else users re-login constantly.
- **`@globus/sdk` browser-orientation** - if Node ergonomics for the
  manual-code flow are poor, fall back to a ~120-line hand-rolled PKCE +
  token POST (contingency, not plan of record).
- **Per-model `max_tokens`** - clio-agent capped ALCF at 4096; carry that
  default so requests are not rejected.

## References

- clio-agent prior art: `../clio-agent/src/clio_agent/providers/argonne_auth.py`,
  `providers/registry.py`, `scripts/list_alcf_models.py`.
- Globus JS SDK: https://github.com/globus/globus-sdk-javascript ,
  https://www.npmjs.com/package/@globus/sdk
- Globus Auth developer guide: https://docs.globus.org/api/auth/developer-guide/
