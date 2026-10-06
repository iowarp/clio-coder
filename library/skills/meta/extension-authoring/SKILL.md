---
name: extension-authoring
description: Builds, tests, and debugs Clio Coder api 2 extensions with declared capabilities and host-rendered views. Not for instruction-only skills; use skill-authoring.
triggers:
  - build a Clio extension
  - add an extension hook
  - create an extension workspace
  - debug extension reload
version: 0.1.0
license: Apache-2.0
allowed-tools:
  - read
  - grep
  - write
  - edit
  - bash
clio-coder:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/library/skills/meta/extension-authoring
  audit: pass
  model-size: large
---

# Extension Authoring

Write and test the package; the operator approves capability consent, installs
and publishes it. Do not answer consent on their behalf or modify installed
package bytes. Use a draft or `.clio-coder/dev/extensions/<id>/`.

1. **Choose the boundary.** Use a command for an explicit request, an observation
   for passive updates, an awaited hook for a gate, and a tool for a callable
   handler. The current gateway does not yet admit api 2 `runtime.tools`.
   Read [manifest and state](references/manifest-and-state.md) before declaring
   capabilities. Explain the read roots, executable authority, content access,
   update frequency and possible refusals the operator will be approving.
2. **Create the package.** `clio-coder extensions init <id> --template status`
   scaffolds a dev package; the other templates are `hook`, `panel`, `tool` and
   `workspace`. Declare `runtime.api: 2` in `clio-coder-extension.yaml` and a
   default-exported factory in a `.ts` or `.mjs` entrypoint. Import public types
   with `import type { ExtensionApiV2 } from "@iowarp/clio-coder/extensions"`.
   Keep one runtime file or use explicit relative `.ts` imports: Node strips
   types without bundling, so `./helper.js` does not resolve `helper.ts`.
   Use erasable syntax: no enums, parameter properties or runtime namespaces.
3. **Implement event in, data out.** Register exactly the declared command,
   observation, hook and tool names. Return plain bounded data for Clio to draw;
   never push terminal output or retain mutable module state. Put session state
   in `ctx.state`, cross-session records in `ctx.store`, and use versioned writes
   when calls can race. Respect `ctx.signal`; see the storage limits in the
   manifest reference. For gates, consult the exact effect table and failure
   policies in [hooks](references/hooks.md).
4. **Build the view and interaction.** Read [views and interviews](references/views-and-interviews.md)
   for node shapes, surface budgets, tones, workspace skins and leader keys.
   Start an interview only from a command, an action or a tool; register its
   answer handler and handle cancellation. Observations must not take focus.
5. **Verify the loop.** Follow [dev and tests](references/dev-and-tests.md):
   validate registration, exercise handlers through the public test kit, and
   have the operator approve the dev envelope in the TUI. Verify updates, idle
   reload and mute/unmute. Report the actual checks and remaining limitations.
   Give the operator the explicit install command after the package is ready;
   do not silently install or publish it.

When working in the Clio repository, inspect `examples/extensions/git-pulse/`
for Git ticks, watches and snapshots, `examples/extensions/peer-guard/` for
shared expiring path claims, or `library/plugins/materio/runtime/` for a full
workspace. These are examples to adapt, not capabilities granted by this skill.
