import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { createMonitorTool } from "../../src/tools/monitor.js";
import { TOOL_PLANES } from "../../src/tools/policy.js";
import { createSteerTool } from "../../src/tools/steer.js";

describe("orchestration tool scheduling policy", () => {
	it("keeps dispatch and steer sequential, so synchronous dispatch cannot offer parent-model interleaving", () => {
		const dispatch = {} as DispatchContract;
		const dispatchTool = createDispatchTool({ getAgentSpecs: () => [], dispatch });
		const monitorTool = createMonitorTool({ dispatch });
		const steerTool = createSteerTool({ dispatch });

		strictEqual(TOOL_PLANES[ToolNames.Dispatch].executionMode, "sequential");
		strictEqual(TOOL_PLANES[ToolNames.Steer].executionMode, "sequential");
		strictEqual(dispatchTool.executionMode, "sequential");
		strictEqual(steerTool.executionMode, "sequential");

		// Monitor remains a parallel read, but a pending sequential dispatch
		// prevents every other call in that model tool batch from interleaving.
		// The parent model must choose detached dispatch and receive run ids first.
		strictEqual(TOOL_PLANES[ToolNames.Monitor].executionMode, "parallel");
		strictEqual(monitorTool.executionMode, "parallel");
	});
});
