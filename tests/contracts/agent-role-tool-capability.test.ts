import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AGENT_ROLE_TOOLS_REQUIRED_REASON,
	mergeCapabilities,
	supportsAgentRoleTools,
} from "../../src/domains/providers/capabilities.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";

const RUNTIME_DEFAULTS = { ...EMPTY_CAPABILITIES, chat: true, tools: true } as const;

describe("contracts/agent role tool capability", () => {
	it("lets a written catalog entry correct a probe that reports no tool support", () => {
		// The shape that motivated this: LM Studio reports
		// `trained_for_tool_use: false` for a model the operator knows calls tools
		// fine. A hand-authored model-catalog.d entry is the per-model escape hatch,
		// so it has to outrank the server's own metadata.
		const merged = mergeCapabilities({ ...RUNTIME_DEFAULTS }, { tools: true }, { tools: false }, null);
		strictEqual(merged.tools, true);
	});

	it("keeps a probe authoritative when no catalog entry disagrees", () => {
		const merged = mergeCapabilities({ ...RUNTIME_DEFAULTS }, null, { tools: false }, null);
		strictEqual(merged.tools, false, "an unopposed probe still narrows the runtime default");

		const untouched = mergeCapabilities({ ...RUNTIME_DEFAULTS }, { vision: true }, { tools: false }, null);
		strictEqual(untouched.tools, false, "a catalog entry silent about tools does not restore them");
	});

	it("keeps a target-level override outranking both", () => {
		const merged = mergeCapabilities({ ...RUNTIME_DEFAULTS }, { tools: true }, { tools: true }, { tools: false });
		strictEqual(merged.tools, false);
	});

	it("treats only an explicit true as eligible for an agent role", () => {
		ok(supportsAgentRoleTools({ tools: true }));
		ok(!supportsAgentRoleTools({ tools: false }));
		ok(
			AGENT_ROLE_TOOLS_REQUIRED_REASON.length > 0 && !AGENT_ROLE_TOOLS_REQUIRED_REASON.endsWith("."),
			"the reason composes into a caller's sentence",
		);
	});

	it("keeps live deployment limits authoritative without changing metadata precedence", () => {
		const merged = mergeCapabilities(
			{ ...RUNTIME_DEFAULTS, contextWindow: 8_192 },
			{ contextWindow: 262_144 },
			{ contextWindow: 131_072, vision: true },
			null,
		);
		deepStrictEqual(
			{ contextWindow: merged.contextWindow, vision: merged.vision },
			{ contextWindow: 131_072, vision: true },
			"the served window wins while the probe still supplies keys it alone knows",
		);
	});
});
