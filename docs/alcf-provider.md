# ALCF Inference Provider

Clio can use Argonne's ALCF inference gateway as an OpenAI-compatible target
backed by Globus OAuth. The runtime id is `alcf`; each configured target points
at one gateway cluster URL, such as Sophia or Metis.

The login flow is SSH-friendly. `clio auth login alcf` opens a Globus authorize
URL and asks you to paste back the displayed authorization code. Clio stores the
resulting OAuth refresh/access credential in its normal credential store and
refreshes it through the same provider auth path used by other OAuth runtimes.

## Configure

Authenticate first:

```bash
clio auth login alcf
```

Then register one or both cluster targets:

```bash
clio configure \
  --id alcf-sophia \
  --runtime alcf \
  --url https://inference-api.alcf.anl.gov/resource_server/sophia/vllm/v1 \
  --model openai/gpt-oss-120b \
  --max-tokens 4096

clio configure \
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
clio targets use alcf-sophia
clio targets --probe
clio models --target alcf-sophia
```

## Implementation Notes

The implementation is intentionally inside Clio Coder rather than downstream
scientific apps:

- `src/engine/alcf-oauth.ts` implements the Globus PKCE paste-code OAuth flow.
- `src/engine/oauth.ts` registers the Clio-owned OAuth provider through the
  engine boundary.
- `src/domains/providers/runtimes/cloud/alcf.ts` implements Sophia/Metis
  discovery and reuses the generic OpenAI-compatible chat synthesis.
- `ProbeContext.authToken` carries a resolved stored/API/OAuth bearer into live
  probes so authenticated model discovery does not reach into auth storage.
- ALCF rejects non-standard `chat_template_kwargs` request fields. The runtime
  marks synthesized models with `clio.chatTemplateKwargsUnsupported`, and the
  OpenAI-compatible engine adapter omits that field while still sending the
  accepted top-level `reasoning_effort`.

Live model availability depends on which gateway jobs are running. The static
model list is only a fallback for offline resolution; `clio targets --probe`
uses the ALCF catalog and jobs endpoints after authentication.
