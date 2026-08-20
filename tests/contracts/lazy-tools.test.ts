import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { resolveAgentTools } from "../../src/tools/agent-tools.js";
import { codeNavTool } from "../../src/tools/codewiki/code-nav.js";
import { codeNavToolSurface } from "../../src/tools/codewiki/code-nav-surface.js";
import { createContextTool } from "../../src/tools/context/index.js";
import { contextToolSurface } from "../../src/tools/context/surface.js";
import { lazyTool, type ToolSurface } from "../../src/tools/lazy-tool.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";
import { verifyTool } from "../../src/tools/verify/index.js";
import { verifyToolSurface } from "../../src/tools/verify/surface.js";
import { webFetchTool } from "../../src/tools/web-fetch.js";
import { webFetchToolSurface } from "../../src/tools/web-fetch-surface.js";

function advertised(spec: ToolSurface | ToolSpec): unknown {
	return {
		name: spec.name,
		description: spec.description,
		parameters: spec.parameters,
		baseActionClass: spec.baseActionClass,
		executionMode: spec.executionMode,
		prepareArguments: Boolean(spec.prepareArguments),
		prepareAdmissionArguments: Boolean(spec.prepareAdmissionArguments),
		disposeAdmissionArguments: Boolean(spec.disposeAdmissionArguments),
		describeDispatchPlan: Boolean(spec.describeDispatchPlan),
	};
}

describe("contracts/lazy tool stubs", () => {
	const SURFACE_SHA256 = {
		code_nav: "bbdb58bd9e57679d34ff1c966d2ddd4929fef12419cb0e0971ddbf0025a9e4a9",
		context: "ce8654dad18e8e9d5503f11d4280851daf9d3978ea149e4ef32d7b049ccdcb5f",
		verify: "f7c499209b02f6ddc0cf3938681bb748aa544f8aaa40610fcd2ffa5ab70c5a80",
		web_fetch: "6b9c7e66866cc5f8c7cef21bcc6d1dd301692b051ad339f8ec3764ba14d6f164",
	} as const;

	function registry(blocked = false) {
		return createRegistry({
			safety: {
				classify: () => ({ actionClass: "read", reasons: [] }),
				evaluate: () =>
					blocked
						? {
								kind: "block",
								classification: { actionClass: "read", reasons: [] },
								rejection: { short: "blocked", detail: "blocked by fixture", hints: [] },
							}
						: { kind: "allow", classification: { actionClass: "read", reasons: [] } },
				observeLoop: () => ({ looping: false, key: "lazy-fixture", count: 0 }),
				scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
				isSubset: () => true,
				audit: { recordCount: () => 0 },
			},
		});
	}

	it("keeps every advertised surface byte-for-byte equal to its implementation", () => {
		for (const [surface, implementation] of [
			[codeNavToolSurface, codeNavTool],
			[contextToolSurface, createContextTool()],
			[verifyToolSurface, verifyTool],
			[webFetchToolSurface, webFetchTool],
		] as const) {
			const serialized = JSON.stringify(advertised(surface));
			strictEqual(serialized, JSON.stringify(advertised(implementation)));
			strictEqual(
				createHash("sha256").update(serialized).digest("hex"),
				SURFACE_SHA256[surface.name as keyof typeof SURFACE_SHA256],
				`${surface.name} provider and policy surface changed`,
			);
		}
	});

	it("single-flights parallel first use without changing arguments or results", async () => {
		let loads = 0;
		const surface = {
			name: ToolNames.CredentialPresent,
			description: "fixture",
			parameters: Type.Object({ value: Type.String() }),
			baseActionClass: "read",
			executionMode: "parallel",
		} satisfies ToolSurface;
		const stub = lazyTool(surface, async () => {
			loads += 1;
			await Promise.resolve();
			return {
				...surface,
				async run(args) {
					return { kind: "ok", output: String(args.value) };
				},
			};
		});
		const [first, second] = await Promise.all([stub.run({ value: "one" }), stub.run({ value: "two" })]);
		strictEqual(loads, 1);
		deepStrictEqual(first, { kind: "ok", output: "one" });
		deepStrictEqual(second, { kind: "ok", output: "two" });
	});

	it("does not load during registry discovery or when safety rejects admission", async () => {
		let loads = 0;
		const surface = {
			name: ToolNames.CredentialPresent,
			description: "admission fixture",
			parameters: Type.Object({}),
			baseActionClass: "read",
			executionMode: "parallel",
		} satisfies ToolSurface;
		const stub = lazyTool(surface, async () => {
			loads += 1;
			return { ...surface, run: async () => ({ kind: "ok", output: "loaded" }) };
		});

		const allowed = registry();
		allowed.register(stub);
		allowed.listAll();
		allowed.listVisible();
		allowed.listRegistered();
		allowed.get(surface.name);
		const providerSurface = resolveAgentTools({ registry: allowed });
		strictEqual(providerSurface.length, 1);
		match(JSON.stringify(providerSurface), /admission fixture/);
		strictEqual(loads, 0, "registration, policy discovery, and provider serialization stay lightweight");

		const denied = registry(true);
		denied.register(stub);
		const verdict = await denied.invoke({ tool: surface.name, args: {} });
		strictEqual(verdict.kind, "blocked");
		strictEqual(loads, 0, "safety admission must precede the dynamic import");

		const executed = await allowed.invoke({ tool: surface.name, args: {} });
		strictEqual(executed.kind, "ok");
		strictEqual(loads, 1);
	});

	it("does not rewrite exceptions thrown by an already-loaded implementation", async () => {
		const surface = {
			name: ToolNames.CredentialPresent,
			description: "throwing fixture",
			parameters: Type.Object({}),
			baseActionClass: "read",
			executionMode: "parallel",
		} satisfies ToolSurface;
		const stub = lazyTool(surface, async () => ({
			...surface,
			async run() {
				throw new Error("body failure remains a body failure");
			},
		}));
		await rejects(stub.run({}), /body failure remains a body failure/);
	});

	it("rejects surface drift before running the implementation", async () => {
		const surface = {
			name: ToolNames.CredentialPresent,
			description: "stable fixture",
			parameters: Type.Object({}),
			baseActionClass: "read",
			executionMode: "parallel",
		} satisfies ToolSurface;
		let ran = false;
		const result = await lazyTool(surface, async () => ({
			...surface,
			description: "drifted fixture",
			async run() {
				ran = true;
				return { kind: "ok", output: "wrong" };
			},
		})).run({});
		strictEqual(result.kind, "error");
		if (result.kind === "error") match(result.message, /lazy tool surface drift/);
		strictEqual(ran, false);
	});

	it("gives Clio-owned missing chunks the command-chunk reinstall diagnostic", async () => {
		const surface = {
			name: ToolNames.CredentialPresent,
			description: "missing fixture",
			parameters: Type.Object({}),
			baseActionClass: "read",
			executionMode: "parallel",
		} satisfies ToolSurface;
		const missing = Object.assign(new Error(`Cannot find module '${resolvePackageRoot()}/dist/missing-lazy-tool.js'`), {
			code: "ERR_MODULE_NOT_FOUND",
		});
		const result = await lazyTool(surface, async () => {
			throw missing;
		}).run({});
		strictEqual(result.kind, "error");
		if (result.kind === "error") {
			match(result.message, /installation is incomplete/);
			match(result.message, /npm install -g @iowarp\/clio-coder/);
			match(result.message, /npm run install:local/);
		}
	});

	it("does not mislabel a user module failure as an incomplete Clio install", async () => {
		const surface = {
			name: ToolNames.CredentialPresent,
			description: "foreign fixture",
			parameters: Type.Object({}),
			baseActionClass: "read",
			executionMode: "parallel",
		} satisfies ToolSurface;
		const missing = Object.assign(new Error("Cannot find module '/tmp/user-extension.js'"), {
			code: "ERR_MODULE_NOT_FOUND",
		});
		const result = await lazyTool(surface, async () => {
			throw missing;
		}).run({});
		strictEqual(result.kind, "error");
		if (result.kind === "error") {
			match(result.message, /implementation unavailable/);
			ok(!result.message.includes("installation is incomplete"));
		}
	});

	it("does not mislabel a missing external package whose importer is a Clio chunk", async () => {
		const surface = {
			name: ToolNames.CredentialPresent,
			description: "external package fixture",
			parameters: Type.Object({}),
			baseActionClass: "read",
			executionMode: "parallel",
		} satisfies ToolSurface;
		const missing = Object.assign(
			new Error(`Cannot find package 'operator-plugin' imported from ${resolvePackageRoot()}/dist/tool-chunk.js`),
			{ code: "ERR_MODULE_NOT_FOUND" },
		);
		const result = await lazyTool(surface, async () => {
			throw missing;
		}).run({});
		strictEqual(result.kind, "error");
		if (result.kind === "error") {
			match(result.message, /implementation unavailable/);
			ok(!result.message.includes("installation is incomplete"));
		}
	});
});
