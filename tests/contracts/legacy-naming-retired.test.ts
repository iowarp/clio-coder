import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { readSettings, SettingsValidationError, validateSettings } from "../../src/core/config.js";
import { createMuxRuntime } from "../../src/domains/mux/contract.js";
import type { MuxClient } from "../../src/domains/mux/socket-client.js";
import { validateKeybindings } from "../../src/interactive/keybinding-manager.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// The read-time naming layer is gone: a released `clio-*` value in the user
// settings file is an ordinary schema error that names the path, the value it
// found and the canonical values it accepts. Nothing rewrites it silently.
test("user settings refuse released naming values with an error naming the canonical value", async (t) => {
	const home = await isolateClioEnv("clio-legacy-naming-");
	t.after(() => home.restore());
	const file = join(home.dir, "config", "settings.yaml");
	mkdirSync(join(home.dir, "config"), { recursive: true });
	const cases = [
		{
			yaml: "version: 2\ntargets:\n  - { id: local, runtime: lmstudio, lifecycle: clio-managed }\n",
			path: /targets\[0\]\.lifecycle: expected one of user-managed \| clio-coder-managed, got "clio-managed"/u,
		},
		{
			yaml: "version: 2\nintegrations:\n  externalAgents:\n    defaults: { toolGovernance: clio-policy }\n",
			path:
				/integrations\.externalAgents\.defaults\.toolGovernance: expected one of clio-coder-policy .*got "clio-policy"/u,
		},
		{
			yaml:
				"version: 2\nintegrations:\n  externalAgents:\n    entries:\n      - { id: peer, command: peer, toolGovernance: clio-policy }\n",
			path:
				/integrations\.externalAgents\.entries\[0\]\.toolGovernance: expected one of clio-coder-policy .*got "clio-policy"/u,
		},
	];
	for (const { yaml, path } of cases) {
		writeFileSync(file, yaml);
		throws(
			() => readSettings(),
			(error: unknown) => {
				ok(error instanceof SettingsValidationError, String(error));
				match(error.message, path);
				return true;
			},
		);
	}
});

test("a released clio.* keybinding id is kept verbatim and reported as an unknown action", () => {
	const result = validateSettings({ version: 2, interface: { keybindings: { "clio.exit": "ctrl+x" } } });
	deepStrictEqual(result.issues, []);
	deepStrictEqual(result.settings.interface.keybindings, { "clio.exit": "ctrl+x" });
	const checked = validateKeybindings(result.settings.interface.keybindings);
	deepStrictEqual(checked.valid, {});
	deepStrictEqual(
		checked.invalid.map((entry) => entry.id),
		["clio.exit"],
	);
});

// The pane layer used to write the released `clio_owner=clio:mux` token next to
// the canonical one. It now writes only the canonical token and still reads the
// released one, so a pane a 0.4 session left open is found and adopted.
test("mux panes carry only the canonical owner token and still adopt a released one", async () => {
	const reported: Array<Record<string, string | null>> = [];
	const client = {
		async snapshot() {
			return {
				panes: [
					{
						paneId: "released",
						tabId: "t1",
						workspaceId: "w1",
						tokens: { clio_owner: "clio:mux", role: "watch" },
					},
				],
			};
		},
		async paneCurrent() {
			return { paneId: "self", tabId: "t1", workspaceId: "w1" };
		},
		async paneSplit() {
			return { paneId: "opened", tabId: "t1", workspaceId: "w1" };
		},
		async paneRename() {},
		async paneReportMetadata(request: { tokens: Record<string, string | null> }) {
			reported.push(request.tokens);
		},
		async paneSendText() {},
		async paneClose() {},
	} as unknown as MuxClient;
	const runtime = createMuxRuntime({
		client,
		detection: {
			mode: "guest",
			socketPath: null,
			server: { version: "0.8.2", protocol: 21 },
			self: { paneId: "self", tabId: "t1", workspaceId: "w1" },
			candidates: [],
			reason: "fixture",
			refused: false,
		},
	});

	const opened = await runtime.contract.openUtilityPane({ argv: [], cwd: "/repo", label: "utility" });
	strictEqual(opened?.paneId, "opened");
	strictEqual(reported.length, 1);
	strictEqual(reported[0]?.clio_coder_owner, "clio-coder:mux");
	strictEqual(Object.hasOwn(reported[0] ?? {}, "clio_owner"), false, "the released owner token is never written");

	const adopted = await runtime.contract.adoptPane({ purpose: "watch", label: "watch" });
	strictEqual(adopted?.paneId, "released");
});
