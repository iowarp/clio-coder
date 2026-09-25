# ALCF Inference Provider

The [configuration guide](../guide/configuration-and-targets.md) walks through choosing an ALCF target.

Clio can use Argonne's ALCF inference gateway as an OpenAI-compatible target
backed by Globus OAuth. The runtime id is `alcf`; each configured target points
at one gateway cluster URL, such as Sophia or Metis.

The login flow is SSH-friendly. `clio-coder auth login alcf` opens a Globus authorize
URL and asks you to paste back the displayed authorization code. Clio stores the
resulting OAuth refresh/access credential in `providers.auth` persisted through `openAuthStorage()`,
refreshed through the same provider auth path used by other OAuth runtimes.

## Configure

Authenticate first:

```bash
clio-coder auth login alcf
```

The interactive `configure` wizard asks for the gateway URL. `offeredUrlFor`
in [configure-target.ts](../../src/cli/configure-target.ts) leaves it blank
for ALCF, and `gatewayUrlGuidance` shows a Sophia example plus a note that
the correct URL and model depend on the cluster or resource. Supply the
cluster URL explicitly.

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

Sophia currently uses `vllm` in the URL and serves `openai/`-prefixed model ids.
Metis currently uses `api` in the URL and serves bare model ids. Clio sends the
configured wire model id literally and does not rewrite it.

Set a target as the chat default when you are ready:

```bash
clio-coder targets use alcf-sophia
clio-coder targets --probe
clio-coder models --target alcf-sophia
```

## Implementation Notes

The implementation is intentionally inside Clio Coder rather than downstream
scientific apps:

- [alcf-oauth.ts](../../src/engine/alcf-oauth.ts) implements the Globus PKCE paste-code OAuth flow.
- [oauth.ts](../../src/engine/oauth.ts) registers the Clio-owned OAuth provider through the
  engine boundary.
- [alcf.ts](../../src/domains/providers/runtimes/cloud/alcf.ts) implements Sophia/Metis
  discovery and reuses the generic OpenAI-compatible chat synthesis.
- `ProbeContext.authToken` carries a resolved stored/API/OAuth bearer into live
  probes so authenticated model discovery does not reach into auth storage.
- ALCF rejects non-standard `chat_template_kwargs` request fields. The runtime
  marks synthesized models with `clioCoder.chatTemplateKwargsUnsupported`, and
  the OpenAI-compatible engine adapter reads that marker and omits
  `chat_template_kwargs`. The accepted top-level `reasoning_effort` is
  independent of the marker.

Live model availability depends on which gateway jobs are running. The static
model list is only a fallback for offline resolution; `clio-coder targets --probe`
uses the ALCF catalog and jobs endpoints after authentication.
