import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { installExtension, listInstalledExtensions } from "../../src/domains/extensions/state.js";
import { type HookReceipt, loadUserHooks, userHookToRegistration } from "../../src/domains/middleware/hooks.js";
import { readHookSources } from "../../src/domains/middleware/hooks-io.js";
import {
	type MiddlewareDiagnostic,
	type MiddlewareHookRegistration,
	runMiddlewareAsyncRegistrations,
	runMiddlewareRegistrations,
} from "../../src/domains/middleware/runtime.js";

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
