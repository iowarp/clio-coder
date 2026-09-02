import { strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { configureGuardrails } from "../../src/core/guardrails.js";
import { builtin } from "../../src/tools/builtin-tool-catalog.js";
import { OBSERVATION_POLICY_SLACK_BYTES } from "../../src/tools/observation.js";
import { validateBuiltinToolPolicy } from "../../src/tools/policy.js";
import { readTool } from "../../src/tools/read.js";

const SOURCE = { source: "builtin" } as never;

describe("the read tool's policy cap follows the installed read guardrail", () => {
	afterEach(() => configureGuardrails(undefined));

	it("registers with the operator's cap plus slack, not the import-time default", () => {
		configureGuardrails({ readMaxBytes: 65_536 });
		const spec = builtin(readTool, SOURCE);
		strictEqual(spec.metadata?.resultSizePolicy?.maxBytes, 65_536 + OBSERVATION_POLICY_SLACK_BYTES);
	});

	it("passes the drift check with a raised cap, which used to refuse boot", () => {
		configureGuardrails({ readMaxBytes: 65_536 });
		const errors = validateBuiltinToolPolicy([builtin(readTool, SOURCE)]).filter((e: string) => e.includes("policy cap"));
		strictEqual(errors.length, 0, errors.join("\n"));
	});
});
