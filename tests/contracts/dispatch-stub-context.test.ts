import { deepStrictEqual, ok } from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import { loadRecipesFromDir } from "../../src/domains/agents/registry.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

describe("dispatch stub builtin agent catalog", () => {
	it("serves every shipped builtin with its production audience, result contract, and tool surface", () => {
		const expected = loadRecipesFromDir({
			dir: join(resolvePackageRoot(), "src", "domains", "agents", "builtins"),
			source: "builtin",
			cwd: process.cwd(),
		});
		const agents = dispatchStubContext().getContract<AgentsContract>("agents");
		ok(agents, "the dispatch stub context has no agents contract");

		deepStrictEqual(
			agents.list().map(({ id, audience, resultContract, tools, toolRequirements }) => ({
				id,
				audience,
				resultContract,
				tools,
				toolRequirements,
			})),
			expected.map(({ id, audience, resultContract, tools, toolRequirements }) => ({
				id,
				audience,
				resultContract,
				tools,
				toolRequirements,
			})),
		);
	});
});
