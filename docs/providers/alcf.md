# ALCF (Argonne) inference provider

clio-coder can use Argonne's ALCF inference gateway — the **Sophia** and
**Metis** clusters — as a model provider. The clusters serve open-weight models
(GPT-OSS, Llama 4, …) over an OpenAI-compatible API, authenticated with a
short-lived **Globus** access token.

This is a publicly offered service: anyone with an eligible Globus identity in
an `anl.gov` / `alcf.anl.gov` (or affiliated) domain can use it. You start with
no token — `clio auth login alcf` mints one.

## One-time setup

### 1. Log in with Globus

```
clio auth login alcf
```

This prints a Globus authorization URL. Open it (the terminal will offer to
launch your browser; if there is no local browser — e.g. you are on an SSH
login node — copy the URL into a browser on any machine). Log in with your
ALCF / `anl.gov` identity. Globus then shows an **authorization code** — copy
it and paste it back into the terminal.

clio exchanges the code for an access + refresh token and stores them. The
token auto-refreshes; you will not need to log in again until the refresh token
itself expires. No localhost callback is used, so the flow works identically on
a laptop or over SSH.

### 2. Add the cluster endpoint(s)

Each cluster is a separate endpoint on the `alcf` runtime:

```
# Sophia (vLLM framework)
clio configure add sophia \
  --runtime alcf \
  --url https://inference-api.alcf.anl.gov/resource_server/sophia/vllm/v1 \
  --model openai/gpt-oss-120b \
  --max-tokens 4096

# Metis (FastCoE "api" framework)
clio configure add metis \
  --runtime alcf \
  --url https://inference-api.alcf.anl.gov/resource_server/metis/api/v1 \
  --model gpt-oss-120b \
  --max-tokens 4096
```

Notes:

- The endpoint's `oauthProfile` defaults to `alcf`, so it shares the token from
  step 1 — no per-endpoint auth needed.
- `--max-tokens 4096` keeps requests within the gateway's limits (the model
  knowledge base advertises larger ceilings, but the gateway is conservative).
- Sophia serves `openai/`-prefixed model ids; Metis serves bare ids. The wire
  id is sent literally (no LiteLLM-style prefix rewriting).

### 3. Use it

```
clio --model sophia/openai/gpt-oss-120b
# or
clio --model metis/gpt-oss-120b
```

`clio targets` shows the endpoints and, once logged in, a live probe lists the
models actually loaded on each cluster (from the gateway's
`list-endpoints` + `/jobs` catalog).

## Which models are available?

ALCF model availability depends on which gateway jobs are running, so the live
model list changes over time. The runtime ships a static fallback list
(GPT-OSS, Llama 4 Maverick/Scout) for offline resolution; the authoritative
list comes from the live probe after you log in.

## How it works (for maintainers)

- **Auth:** `src/engine/alcf-oauth.ts` — a pi-ai `OAuthProviderInterface`
  (id `alcf`) implementing the Globus paste-the-code PKCE flow, token refresh,
  and gateway-resource-server token selection. Registered at boot via
  `registerClioOAuthProviders()`.
- **Runtime:** `src/domains/providers/runtimes/cloud/alcf.ts` — an
  `openai-completions` runtime (`auth: "oauth"`) that reuses the generic
  OpenAI-compatible chat synthesis and adds ALCF-specific discovery
  (`list-endpoints` + `/jobs`, cluster→framework routing). Registered in
  `runtimes/builtins.ts`.
- **Models:** `src/domains/providers/models/cloud-models/alcf.yaml` — capability
  metadata for the Llama 4 models (GPT-OSS is covered by the existing
  `openai-gpt-oss` family entry).
- **Token plumbing:** the resolved bearer reaches chat through the normal
  `providers.auth.resolveForTarget()` path and reaches discovery probes through
  `ProbeContext.authToken`.

See [`alcf-globus-plan.md`](alcf-globus-plan.md) for the full design rationale.
