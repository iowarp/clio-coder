# Dev loop, test kit and promotion

1. Scaffold or write a package under `.clio-coder/dev/extensions/<id>/`. Start
   the TUI in that project, or run the TUI slash command `/extensions dev <folder>`
   to name another local package. This is a slash command, not a CLI subcommand.
   A dev package must be api 2 and contain no `hooks.yaml`.
2. The operator sees a Clio-drawn capability question (default **Not now**).
   Approval lasts for this session. The runtime loads from a private copy, not
   directly from the editing tree. Headless runs, ACP and workers never load dev
   packages. Do not press approval or bypass the question for the operator.
3. Save source. A 250 ms debounce queues reload at the next idle boundary;
   active turns/commands/overlays postpone it. Same or covered envelopes reload
   without a question. Growth asks again and lists what grew; see the manifest
   reference for the current comparison's gaps. Watch the visible output to
   confirm that the new runtime actually loaded.
4. Use `/extensions mute <id>` to unload it for the session and
   `/extensions unmute <id>` to restore it. These also work for installed
   runtimes; the session overlay does not change installed enabled flags.
5. Run `clio-coder extensions validate <path>`: it checks the manifest/envelope,
   skins and exact registrations by starting a private runtime copy. This runs
   startup code under declared permissions, not just a static YAML check. It
   does not execute all handlers or prove their safety.
6. Run `clio-coder extensions test <path>`. Tests named `**/*.test.ts` use the
   running Clio install's public implementation. Import the test kit from
   `@iowarp/clio-coder/extensions/testing`; do not reach into `src/`.

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createExtensionTestHost } from "@iowarp/clio-coder/extensions/testing";

test("command draws its card", async () => {
  const host = await createExtensionTestHost(fileURLToPath(new URL("../", import.meta.url)));
  try {
    assert.equal((await host.command("show")).card?.t, "text");
  } finally {
    await host.dispose();
  }
});
```

Supply `{workspace,sessionId,options}` when a handler needs fixture
context. Host methods: `command`, `observe`, `hook`, `tool`, `action`, `interview`,
`leave`, `tick`, `advance`, `dispose`; `state` and `store` are inspectable.
`observe` of `workspace_enter` or `workspace_leave` moves the snapshot's
`activeWorkspace` as the live host does, and `leave()` leaves the active
workspace and delivers `workspace_leave`. `advance(ms)`
advances Date inside handlers and delivers due declared ticks; deadlines still
use real timers. Create fixture files in an owned temp directory and clean up.
Test hosts have isolated stores: seed a peer's claim explicitly when testing
cross-owner behavior, and separately verify live coordination if required.

At readiness, report validation, tests, live behavior, access and known limits.
The operator promotes a standalone package with
`clio-coder extensions install <path> --project` or `--user`, and publishes only
after reviewing it. Installed copies are digest checked; edit a draft/dev source
and have the operator reinstall changes, rather than editing installed bytes.
The CLI's `init` templates are status/hook/panel/tool/workspace; git-pulse and
peer-guard are repository examples, not additional template choices. No `pack`
or `promote` CLI command is promised here.
