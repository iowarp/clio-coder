import { ok, strictEqual } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { configureGuardrails } from "../../src/core/guardrails.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { builtin } from "../../src/tools/builtin-tool-catalog.js";
import { OBSERVATION_POLICY_SLACK_BYTES } from "../../src/tools/observation.js";
import { validateBuiltinToolPolicy } from "../../src/tools/policy.js";
import { readTool } from "../../src/tools/read.js";
import { createRegistry, type ToolSourceInfo } from "../../src/tools/registry.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const SOURCE: ToolSourceInfo = { path: "builtin", scope: "core" };

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

	it("uses later cap changes through the registered tool's real result-shaping path", async () => {
		const scratch = await isolateClioEnv("clio-coder-read-cap-reload-");
		try {
			const path = join(scratch.dir, "sample.txt");
			const content = `${"a".repeat(3000)}\n${"b".repeat(3000)}\n${"c".repeat(3000)}`;
			writeFileSync(path, content);
			configureGuardrails({ readMaxBytes: 1024 });
			const registry = createRegistry({ safety: createWorkerSafety({ cwd: scratch.dir }) });
			registry.register(builtin(readTool, SOURCE));
			configureGuardrails({ readMaxBytes: 16_384 });
			const raised = await registry.invoke({ tool: "read", args: { path } });
			ok(raised.kind === "ok" && raised.result.kind === "ok");
			strictEqual(raised.result.output, content);

			configureGuardrails({ readMaxBytes: 1024 });
			const lowered = await registry.invoke({ tool: "read", args: { path } });
			ok(lowered.kind === "ok" && lowered.result.kind === "ok");
			const prefix = lowered.result.output.match(/^a+/u)?.[0] ?? "";
			ok(prefix.length > 0 && prefix.length <= 1024);
			const observation = lowered.result.details?.observation as { truncated: boolean };
			strictEqual(observation.truncated, true);
			strictEqual(
				lowered.result.details?.resultSize,
				undefined,
				"the read tool's own continuation notice must survive without a second truncation",
			);
		} finally {
			scratch.restore();
		}
	});
});
