import { doesNotMatch, match, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { createGatewayTool } from "../../src/tools/gateway/index.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("a restricted surface refuses unknown and excluded names alike, and only an unrestricted run says none exists", async () => {
	const env = await isolateClioEnv("gateway-unknown-capability-");
	try {
		const gateway = createGatewayTool({ registry: createWorkerToolRegistry() });
		const refusal = async (op: string, capability: string, options: object): Promise<string> => {
			const result = await gateway.run({ op, capability, args: {} }, options);
			strictEqual(result.kind, "error");
			if (result.kind !== "error") throw new Error("expected refusal");
			return result.message;
		};
		for (const options of [
			{ allowedTools: ["read", "grep"] as const },
			{ turnConstraints: { allowedTools: ["read", "grep"] } },
		]) {
			for (const op of ["describe", "call"]) {
				const excluded = await refusal(op, "edit", options);
				match(excluded, /admitted capabilities: grep, read\. Use one of these exact names\.\nRefused by: /u);
				for (const capability of ["shell", "terminal", "mkdir"]) {
					// One message for every off-surface name, so existence cannot be probed.
					strictEqual(await refusal(op, capability, options), excluded.replace('"edit"', `"${capability}"`));
				}
			}
		}
		for (const op of ["describe", "call"]) {
			const unknown = await refusal(op, "shell", {});
			match(unknown, /no such capability "shell"; registered tools: .*\bread\b/u);
			doesNotMatch(unknown, /admitted capabilities|Refused by/u);
		}
	} finally {
		env.restore();
	}
});
