import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { installExtension, listInstalledExtensions } from "../../src/domains/extensions/state.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import { type HookReceipt, loadUserHooks, userHookToRegistration } from "../../src/domains/middleware/hooks.js";
import { readHookSources } from "../../src/domains/middleware/hooks-io.js";
import { BUILTIN_MIDDLEWARE_RULE_IDS } from "../../src/domains/middleware/rules.js";
import {
	type MiddlewareDiagnostic,
	type MiddlewareHookRegistration,
	type MiddlewareRuleDefinition,
	runMiddlewareAsyncRegistrations,
	runMiddlewareRegistrations,
} from "../../src/domains/middleware/runtime.js";
import { createMiddlewareContractFromSnapshot } from "../../src/domains/middleware/snapshot.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "../../src/domains/middleware/types.js";

function registration(
	id: string,
	evaluate: MiddlewareHookRegistration["evaluate"],
	overrides: Partial<MiddlewareHookRegistration> = {},
): MiddlewareHookRegistration {
	return { id, description: id, hooks: ["before_tool"], evaluate, ...overrides };
}

const roots: string[] = [];

function scratch(): string {
	const root = mkdtempSync(path.join(tmpdir(), "clio-middleware-extension-"));
	roots.push(root);
	return root;
}

describe("middleware hook boundary", () => {
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("does not admit hooks from an invalid installed extension", () => {
		const project = scratch();
		const outside = scratch();
		const extensionRoot = path.join(project, ".clio-coder", "extensions", "invalid-hooks");
		mkdirSync(extensionRoot, { recursive: true });
		mkdirSync(path.join(outside, "agents"));
		writeFileSync(
			path.join(extensionRoot, "clio-coder-extension.yaml"),
			[
				"manifestVersion: 1",
				"id: invalid-hooks",
				"name: Invalid Hooks",
				"version: 1.0.0",
				"description: Invalid hook fixture.",
				"resources:",
				"  agents: agents",
				"",
			].join("\n"),
		);
		symlinkSync(path.join(outside, "agents"), path.join(extensionRoot, "agents"), "dir");
		writeFileSync(
			path.join(extensionRoot, "hooks.yaml"),
			"- id: must-not-load\n  on: before_tool\n  kind: prompt\n  message: unsafe\n",
		);

		const admitted = listInstalledExtensions(project)
			.filter((extension) => extension.loadable && extension.provenance !== undefined)
			.map((extension) => ({
				id: extension.id,
				rootPath: extension.rootPath,
				scope: extension.scope,
				installedContentDigest: extension.provenance?.contentDigest ?? "",
			}));
		deepStrictEqual(admitted, []);
		deepStrictEqual(readHookSources({ cwd: project, extensions: admitted }).batches, []);
	});

	it("carries verified install scope and content digest into extension hook receipts", () => {
		const project = scratch();
		const source = scratch();
		writeFileSync(
			path.join(source, "clio-coder-extension.yaml"),
			[
				"manifestVersion: 1",
				"id: receipt-hooks",
				"name: Receipt Hooks",
				"version: 1.0.0",
				"description: Hook receipt provenance fixture.",
				"resources: {}",
				"",
			].join("\n"),
		);
		writeFileSync(
			path.join(source, "hooks.yaml"),
			"- id: receipted\n  on: before_tool\n  kind: prompt\n  message: verify\n",
		);
		const installed = installExtension(source, { cwd: project, scope: "project" }).extension;
		strictEqual(installed?.loadable, true);
		const installedContentDigest = installed?.provenance?.contentDigest as string;
		const { batches } = readHookSources({
			cwd: project,
			extensions: [
				{
					id: installed?.id as string,
					rootPath: installed?.rootPath as string,
					scope: "project",
					installedContentDigest,
				},
			],
		});
		const loaded = loadUserHooks(batches, { workspaceRoot: project });
		strictEqual(loaded.hooks.length, 1);
		const [hook] = loaded.hooks;
		if (!hook) throw new Error("expected one loaded extension hook");
		const receipts: HookReceipt[] = [];
		const registration = userHookToRegistration(hook, {
			recordReceipt: (receipt) => receipts.push(receipt),
			runCommand: () => ({ code: 0, timedOut: false, stdout: "", stderr: "" }),
			now: () => 123,
		});
		registration.evaluate({ hook: "before_tool", toolName: "read" });
		strictEqual(receipts[0]?.extensionScope, "project");
		strictEqual(receipts[0]?.installedContentDigest, installedContentDigest);
	});

	it("evaluates matching registrations in order and exposes prior effects", () => {
		const seen: string[][] = [];
		const first = registration("first", () => [{ kind: "inject_reminder", message: "prepare" }]);
		const second = registration("second", (_input, context) => {
			seen.push((context?.priorEffects ?? []).map(({ kind }) => kind));
			return [{ kind: "block_tool", reason: "protected", severity: "hard-block" }];
		});
		const result = runMiddlewareRegistrations({ hook: "before_tool", toolName: "write", toolArgs: { path: "PLAN.md" } }, [
			first,
			second,
		]);
		deepStrictEqual(result.ruleIds, ["first", "second"]);
		deepStrictEqual(result.effects, [
			{ kind: "inject_reminder", message: "prepare" },
			{ kind: "block_tool", reason: "protected", severity: "hard-block" },
		]);
		deepStrictEqual(seen, [["inject_reminder"]]);
	});

	it("isolates a failed registration and continues later effects", () => {
		const diagnostics: MiddlewareDiagnostic[] = [];
		const failed = registration("failed", () => {
			throw new Error("hook exploded");
		});
		const survivor = registration("survivor", () => [
			{ kind: "annotate_tool_result", message: "checked", severity: "info" },
		]);
		const result = runMiddlewareRegistrations({ hook: "before_tool", toolName: "read" }, [failed, survivor], {
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		});
		deepStrictEqual(result.ruleIds, ["survivor"]);
		deepStrictEqual(result.effects, [{ kind: "annotate_tool_result", message: "checked", severity: "info" }]);
		deepStrictEqual(diagnostics, [
			{ kind: "hook_failed", registrationId: "failed", hook: "before_tool", message: "hook exploded" },
		]);
	});

	it("matches exact hook and tool scopes", () => {
		const scoped = registration("write-only", () => [{ kind: "lock_tools" }], { toolNames: ["write"] });
		strictEqual(runMiddlewareRegistrations({ hook: "before_tool", toolName: "write" }, [scoped]).effects.length, 1);
		strictEqual(runMiddlewareRegistrations({ hook: "before_tool", toolName: "read" }, [scoped]).effects.length, 0);
		strictEqual(runMiddlewareRegistrations({ hook: "before_tool" }, [scoped]).effects.length, 0);
		strictEqual(runMiddlewareRegistrations({ hook: "after_tool", toolName: "write" }, [scoped]).effects.length, 0);
	});

	it("serializes async phases in registration order and isolates rejection", async () => {
		const calls: string[] = [];
		const diagnostics: MiddlewareDiagnostic[] = [];
		const regs: MiddlewareHookRegistration[] = [
			registration("one", () => [], {
				evaluateAsync: async () => {
					calls.push("one");
					return [{ kind: "inject_reminder", message: "first" }];
				},
			}),
			registration("broken", () => [], {
				evaluateAsync: async () => {
					calls.push("broken");
					throw new Error("async failure");
				},
			}),
			registration("three", () => [], {
				evaluateAsync: async (_input, context) => {
					calls.push(`three:${context?.priorEffects.length ?? 0}`);
					return [{ kind: "request_continuation", message: "continue" }];
				},
			}),
		];
		const result = await runMiddlewareAsyncRegistrations({ hook: "before_tool", toolName: "write" }, regs, [], {
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		});
		deepStrictEqual(calls, ["one", "broken", "three:1"]);
		deepStrictEqual(result.effects, [
			{ kind: "inject_reminder", message: "first" },
			{ kind: "request_continuation", message: "continue" },
		]);
		strictEqual(diagnostics[0]?.kind, "hook_failed");
	});
});

const FIXED_RULE_ID = "rule.fixed";
const FIXED_RULE: MiddlewareRuleDefinition = {
	rule: {
		id: FIXED_RULE_ID,
		source: "builtin",
		description: "fixed rule fixture",
		enabled: true,
		hooks: ["before_tool"],
		effectKinds: ["inject_reminder"],
	},
	effects: [{ kind: "inject_reminder", message: FIXED_RULE_ID }],
};
const PROBE: MiddlewareHookInput = { hook: "before_tool", toolName: "read" };

function emitting(id: string, message = id): MiddlewareHookRegistration {
	return registration(id, () => [{ kind: "inject_reminder", message }]);
}

function messages(effects: ReadonlyArray<MiddlewareEffect>): string[] {
	return effects.map((effect) => (effect.kind === "inject_reminder" ? effect.message : effect.kind));
}

function ownedBundle(diagnostics: MiddlewareDiagnostic[] = []) {
	return createMiddlewareBundle({
		ruleDefinitions: [FIXED_RULE],
		onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
	}).contract;
}

function permutations<T>(items: ReadonlyArray<T>): T[][] {
	if (items.length <= 1) return [[...items]];
	return items.flatMap((item, index) =>
		permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
	);
}

describe("middleware generation-owned registrations", () => {
	it("replaces an owner's set as one unit under a strictly increasing generation", () => {
		const middleware = ownedBundle();
		const first = middleware.replaceRegistrations("user-hooks", 1, [emitting("a")]);
		strictEqual(first.applied, true);
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "a"]);
		const second = middleware.replaceRegistrations("user-hooks", 2, [emitting("b")]);
		strictEqual(second.applied, true);
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "b"]);
		for (const stale of [2, 1, 0, 1.5]) {
			const report = middleware.replaceRegistrations("user-hooks", stale, [emitting("c")]);
			deepStrictEqual(
				{ applied: report.applied, reason: report.reason, activeGeneration: report.activeGeneration },
				{ applied: false, reason: "stale", activeGeneration: 2 },
			);
		}
		strictEqual(middleware.ownedGeneration("user-hooks"), 2);
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "b"]);
		const unknown = middleware.replaceRegistrations("nobody" as "user-hooks", 9, [emitting("z")]);
		strictEqual(unknown.reason, "unknown-owner");
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "b"]);
	});

	it("makes a stale disposer harmless and lets a prepared replacement refuse after supersession", () => {
		const middleware = ownedBundle();
		const three = middleware.replaceRegistrations("user-hooks", 3, [emitting("h3")]);
		strictEqual(middleware.replaceRegistrations("user-hooks", 2, []).applied, false, "an older empty set is refused");
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "h3"]);
		const four = middleware.replaceRegistrations("user-hooks", 4, [emitting("h4")]);
		three.dispose();
		deepStrictEqual(
			middleware.runHook(PROBE).ruleIds,
			[FIXED_RULE_ID, "h4"],
			"disposing generation 3 cannot remove generation 4",
		);
		const prepared = middleware.prepareRegistrationReplacement("user-hooks", 5, [emitting("h5")]);
		strictEqual(prepared.status, "prepared");
		if (prepared.status !== "prepared") return;
		strictEqual(prepared.replacement.current(), true);
		strictEqual(middleware.replaceRegistrations("user-hooks", 6, [emitting("h6")]).applied, true);
		strictEqual(prepared.replacement.current(), false);
		strictEqual(prepared.replacement.commit().applied, false, "a superseded prepared replacement never publishes");
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "h6"]);
		four.dispose();
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "h6"]);
		const host = middleware.prepareRegistrationReplacement("user-hooks", 7, [emitting("h7")]);
		strictEqual(host.status, "prepared");
		if (host.status !== "prepared") return;
		middleware.registerHook(emitting("host.late"));
		strictEqual(host.replacement.current(), false, "a host registration after prepare invalidates the prepared list");
		strictEqual(host.replacement.commit().applied, false);
		strictEqual(middleware.ownedGeneration("user-hooks"), 6);
		const applied = middleware.replaceRegistrations("user-hooks", 8, []);
		strictEqual(applied.applied, true);
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "host.late"]);
	});

	it("keeps builtin and host ids out of owned sets and lets a host registration evict an owned one", () => {
		const diagnostics: MiddlewareDiagnostic[] = [];
		const middleware = ownedBundle(diagnostics);
		middleware.registerHook(emitting("host.x"));
		const builtinId = BUILTIN_MIDDLEWARE_RULE_IDS[0] as string;
		const report = middleware.replaceRegistrations("user-hooks", 1, [
			emitting(builtinId, "owned-builtin"),
			emitting(FIXED_RULE_ID, "owned-fixed"),
			emitting("host.x", "owned-host"),
			emitting("u", "owned-u"),
			emitting("u", "owned-u-duplicate"),
		]);
		deepStrictEqual(report.dropped, [
			{ id: builtinId, conflictsWith: "builtin" },
			{ id: FIXED_RULE_ID, conflictsWith: "builtin" },
			{ id: "host.x", conflictsWith: "host" },
			{ id: "u", conflictsWith: "owned" },
		]);
		deepStrictEqual(
			diagnostics.map((diagnostic) =>
				diagnostic.kind === "registration_conflict"
					? [diagnostic.registrationId, diagnostic.conflictsWith, diagnostic.action, diagnostic.generation]
					: diagnostic.kind,
			),
			[
				[builtinId, "builtin", "dropped", 1],
				[FIXED_RULE_ID, "builtin", "dropped", 1],
				["host.x", "host", "dropped", 1],
				["u", "owned", "dropped", 1],
			],
		);
		const before = middleware.runHook(PROBE);
		deepStrictEqual(before.ruleIds, [FIXED_RULE_ID, "host.x", "u"]);
		deepStrictEqual(messages(before.effects), [FIXED_RULE_ID, "host.x", "owned-u"]);
		diagnostics.length = 0;
		middleware.registerHook(emitting("u", "host-u"));
		deepStrictEqual(
			diagnostics.map((diagnostic) =>
				diagnostic.kind === "registration_conflict"
					? [diagnostic.registrationId, diagnostic.conflictsWith, diagnostic.action]
					: diagnostic.kind,
			),
			[["u", "host", "evicted"]],
		);
		const after = middleware.runHook(PROBE);
		deepStrictEqual(after.ruleIds, [FIXED_RULE_ID, "host.x", "u"]);
		deepStrictEqual(messages(after.effects), [FIXED_RULE_ID, "host.x", "host-u"]);
		strictEqual(middleware.listRules()[0]?.id, builtinId, "builtin rules stay first in the declarative order");
	});

	it("anchors the owned slot where it was first applied and keeps it there across replacements", () => {
		const middleware = ownedBundle();
		middleware.registerHook(emitting("A"));
		strictEqual(middleware.replaceRegistrations("user-hooks", 1, [emitting("u")]).applied, true);
		middleware.registerHook(emitting("B"));
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "A", "u", "B"]);
		strictEqual(middleware.replaceRegistrations("user-hooks", 2, [emitting("v"), emitting("w")]).applied, true);
		deepStrictEqual(middleware.runHook(PROBE).ruleIds, [FIXED_RULE_ID, "A", "v", "w", "B"]);
		const worker = createMiddlewareContractFromSnapshot(middleware.snapshot());
		strictEqual(worker.replaceRegistrations("user-hooks", 1, [emitting("worker-u")]).applied, true);
		strictEqual(worker.ownedGeneration("user-hooks"), 1);
		deepStrictEqual(worker.runHook(PROBE).ruleIds, ["worker-u"], "the worker contract honours the same owner semantics");
	});

	it("finishes an in-flight async evaluation against its captured list while later evaluations use the new one", async () => {
		const middleware = ownedBundle();
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const u1 = registration("u1", () => [], {
			evaluateAsync: async () => {
				await gate;
				return [{ kind: "inject_reminder", message: "u1" }];
			},
		});
		const u2 = registration("u2", () => [], {
			evaluateAsync: async () => [{ kind: "inject_reminder", message: "u2" }],
		});
		strictEqual(middleware.replaceRegistrations("user-hooks", 1, [u1]).applied, true);
		ok(middleware.runAsyncHook);
		const inFlight = middleware.runAsyncHook(PROBE);
		strictEqual(middleware.replaceRegistrations("user-hooks", 2, [u2]).applied, true);
		release();
		const old = await inFlight;
		deepStrictEqual(old.ruleIds, ["u1"]);
		const fresh = await middleware.runAsyncHook(PROBE);
		deepStrictEqual(fresh.ruleIds, ["u2"]);
	});

	it("matches a reference model across every ordering of replace, dispose, host, and evaluate", () => {
		type Op = "R2" | "R3" | "D2" | "H" | "E";
		const orderings = permutations<Op>(["R2", "R3", "D2", "H", "E"]);
		strictEqual(orderings.length, 120);
		for (const ordering of orderings) {
			const middleware = ownedBundle();
			const model = { generation: 0, owned: [] as string[], disposeTwo: false };
			let disposeTwo: (() => void) | null = null;
			let hostRegistered = false;
			const observe = (): void => {
				const result = middleware.runHook(PROBE);
				const ids = result.ruleIds.filter((id) => id !== FIXED_RULE_ID && id !== "x");
				deepStrictEqual(ids, model.owned, `owned ids after ${ordering.join(",")}`);
				strictEqual(result.ruleIds.includes("x"), hostRegistered, `host presence after ${ordering.join(",")}`);
				strictEqual(new Set(result.ruleIds).size, result.ruleIds.length, `duplicate id after ${ordering.join(",")}`);
				strictEqual(result.ruleIds[0], FIXED_RULE_ID);
			};
			for (const op of ordering) {
				if (op === "R2") {
					const report = middleware.replaceRegistrations("user-hooks", 2, [emitting("a")]);
					if (2 > model.generation) {
						model.generation = 2;
						model.owned = ["a"];
						model.disposeTwo = true;
						disposeTwo = report.dispose;
						strictEqual(report.applied, true);
					} else strictEqual(report.applied, false);
				} else if (op === "R3") {
					const report = middleware.replaceRegistrations("user-hooks", 3, [emitting("b")]);
					strictEqual(report.applied, true);
					model.generation = 3;
					model.owned = ["b"];
				} else if (op === "D2") {
					disposeTwo?.();
					if (model.disposeTwo && model.generation === 2) model.owned = [];
				} else if (op === "H") {
					middleware.registerHook(emitting("x"));
					hostRegistered = true;
				} else observe();
				observe();
			}
		}
	});
});
