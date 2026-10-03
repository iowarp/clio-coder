# ALCF Inference Provider

The [configuration guide](../guide/configuration-and-targets.md) walks through choosing an ALCF target.

Clio can use Argonne's ALCF inference gateway as an OpenAI-compatible target backed by Globus OAuth. The runtime id is `alcf` (tier `cloud`, API family `openai-completions`, auth `oauth`); each configured target points at one gateway cluster URL, such as Sophia or Metis.

## Login

The login flow is SSH-friendly and needs no localhost callback. `clio-coder auth login alcf` prints a Globus authorize URL and asks you to paste back the displayed authorization code. A full redirect URL, a `code=` query string or the bare code are all accepted.

[`alcf-oauth.ts`](../../src/engine/alcf-oauth.ts) implements the Globus native-app PKCE flow with the `S256` challenge, `access_type=offline` and a `session_required_single_domain` of `anl.gov,alcf.anl.gov`. The token response must carry a gateway grant and a refresh token, or the login fails. Clio treats the access token as expired five minutes before the server's expiry. The refresh is a Globus `refresh_token` grant that keeps the previous refresh token when the response omits a new one.

The credential is stored under the provider id `alcf` in `credentials.yaml` in the config directory, mode `0600`, through `openAuthStorage()`. Storage and refresh are Clio's own, the same path every OAuth runtime uses, as described in [auth](../guide/configuration-and-targets.md#auth).

## Configure

Authenticate first:

```bash
clio-coder auth login alcf
```

The interactive `configure` wizard asks for the gateway URL. `offeredUrlFor` in [configure-target.ts](../../src/cli/configure-target.ts) leaves it blank for ALCF, and `gatewayUrlGuidance` shows a Sophia example plus a note that the correct URL and model depend on the cluster or resource. Supply the cluster URL explicitly. The wizard's reachability line for ALCF reads `ALCF catalog reachable; inference URL not checked`.

Then register one or both cluster targets:

```bash
clio-coder configure \
  --id alcf-sophia \
  --runtime alcf \
  --url https://inference-api.alcf.anl.gov/resource_server/sophia/vllm/v1 \
  --model openai/gpt-oss-120b \
  --max-tokens 4096

clio-coder configure \
  --id alcf-metis \
  --runtime alcf \
  --url https://inference-api.alcf.anl.gov/resource_server/metis/api/v1 \
  --model gpt-oss-120b \
  --max-tokens 4096
```

Sophia uses the `vllm` framework in the URL and serves `openai/`-prefixed model ids. Metis uses `api` and serves bare model ids. The runtime reads the cluster from the `/resource_server/<cluster>/` segment of the URL and picks the framework from it: `api` for `metis`, `vllm` for every other cluster. Clio sends the configured wire model id literally and does not rewrite it.

Set a target as the chat default when you are ready:

```bash
clio-coder targets use alcf-sophia
clio-coder targets --probe
clio-coder models --target alcf-sophia
```

## Discovery

`clio-coder targets --probe` calls [alcf.ts](../../src/domains/providers/runtimes/cloud/alcf.ts) `discover` with the resolved bearer token in `ProbeContext.authToken`, so authenticated discovery does not reach into auth storage. The probe reads the gateway catalog at `https://inference-api.alcf.anl.gov/resource_server/list-endpoints` for the models of the target's cluster and framework, then adds the models of running jobs from `/resource_server/<cluster>/jobs`. The jobs read is enrichment only and a failure there does not fail the probe. A probe reports one of these failures:

| Condition | Error |
| --- | --- |
| The target has no `url` | `ALCF target has no url` |
| The URL lacks a `/resource_server/<cluster>/` segment | `cannot determine ALCF cluster from url ...` |
| No token | `ALCF requires Globus auth; run clio-coder auth login alcf.` |
| The catalog is unreachable | `ALCF endpoint catalog unreachable: ...`, with a prompt to log in again on a 401 |

Live model availability depends on which gateway jobs are running. When the cluster reports no models the probe succeeds and notes that the gateway may have no running jobs. The runtime's static `knownModels` list (`openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `gpt-oss-120b`, `meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` and `meta-llama/Llama-4-Scout-17B-16E-Instruct`) is only a fallback for offline resolution, and its first entry is the curated default model.

## Model facts and cost

Capability flags come from the live probe, the target's `capabilities`, and a [model profile](../guide/configuration-and-targets.md#model-profiles) when one matches. The gpt-oss ids match the packaged `openai-gpt-oss` profile. The runtime descriptor declares chat, tools and reasoning, no vision, and a 32,768 token window placeholder that resolution never promotes to a serving window; set `capabilities.contextWindow` on the target or rely on a discovered limit. The Llama 4 entries in [`cloud-models/alcf.yaml`](../../src/domains/providers/models/cloud-models/alcf.yaml) have no matching profile, so their capability fields are not read.

ALCF reports no per-token price. A target's cost provenance is `unknown` until it declares `pricing`, as [pricing and cost provenance](../guide/configuration-and-targets.md#pricing-and-cost-provenance) describes.

## Implementation Notes

The runtime uses these components:

- [alcf-oauth.ts](../../src/engine/alcf-oauth.ts) implements the Globus PKCE paste-code OAuth flow.
- [oauth.ts](../../src/engine/oauth.ts) registers the Clio-owned OAuth provider through the engine boundary, next to the Pi-provided Anthropic, OpenAI Codex and GitHub Copilot flows.
- [alcf.ts](../../src/domains/providers/runtimes/cloud/alcf.ts) implements Sophia and Metis discovery and reuses the generic OpenAI-compatible chat synthesis.
- `ProbeContext.authToken` carries a resolved stored, API or OAuth bearer into live probes.
- ALCF rejects non-standard `chat_template_kwargs` request fields. The runtime marks synthesized models with `clioCoder.chatTemplateKwargsUnsupported`, and the OpenAI-compatible engine adapter reads that marker and omits the family-derived `chat_template_kwargs`. The accepted top-level `reasoning_effort` is independent of the marker.
