import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { HEADLESS_PERMISSION_DENIED_REASON } from "../../src/core/headless-permission.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { dispatchCouncilThroughRegistry } from "../../src/interactive/council-dispatch.js";
import { createRegistry } from "../../src/tools/registry.js";

/**
 * `/council` invokes dispatch with no turn. The turn's denial memory must not
 * hold a declined council in a bucket that never resets, or every later
 * council in the session is refused without being asked.
 */
test("a council declined once is asked again the next time", async () => {
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: process.cwd() }), autonomy: () => "default" });
	registry.register({
		name: ToolNames.Dispatch,
		description: "stub dispatch",
		parameters: Type.Object({}, { additionalProperties: true }),
		baseActionClass: "dispatch",
		async run() {
			return { kind: "ok", output: "council dispatched" };
		},
	});
	let asks = 0;
	registry.onPermissionRequired((_call, _decision, meta) => {
		asks += 1;
		registry.cancelParkedCall(meta.requestId, HEADLESS_PERMISSION_DENIED_REASON);
	});
	const args = {
		tasks: [
			{ agent: "reviewer", task: "review" },
			{ agent: "reviewer", task: "review again" },
		],
	};
	const first = await dispatchCouncilThroughRegistry(registry, args);
	const second = await dispatchCouncilThroughRegistry(registry, args);
	deepStrictEqual([first.status, second.status, asks], ["blocked", "blocked", 2]);
});
