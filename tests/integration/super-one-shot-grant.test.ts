import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Type } from "typebox";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { initializeClioHome } from "../../src/core/init.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { createModesBundle } from "../../src/domains/modes/extension.js";
import { createSafetyBundle } from "../../src/domains/safety/extension.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";

// Regression for the silent super-mode elevation bug. In default mode a write
// to a path outside cwd parks the call at the registry admission gate. The
// historical confirmation overlay called `modes.confirmSuper`, which flipped
// the persistent mode to "super" without warning. The fix introduces a
// one-shot grant: the user can confirm the parked call without changing the
// global mode. These tests exercise the registry contract that backs the
// fix; the interactive layer wires the tool-origin overlay to call
// `resumeParkedCalls({ mode: "super", requestedBy: "tool:one_shot" })`
// instead of mutating the modes contract.

const ORIGINAL_ENV = { ...process.env };

function makeContext(): DomainContext {
	return {
		bus: createSafeEventBus(),
		getContract: () => undefined,
	};
}

function makeRecordingWriteSpec(record: { runs: number; lastPath: string | null }): ToolSpec {
	return {
		name: ToolNames.Write,
		description: "recording write stub",
		parameters: Type.Object(
			{
				path: Type.String(),
				content: Type.String(),
			},
			{ additionalProperties: false },
		),
		baseActionClass: "write",
		executionMode: "sequential",
		async run(args) {
			record.runs += 1;
			record.lastPath = typeof args.path === "string" ? args.path : null;
			return { kind: "ok", output: "wrote" };
		},
	};
}

function makeRecordingBashSpec(record: { runs: number; lastCommand: string | null }): ToolSpec {
	return {
		name: ToolNames.Bash,
		description: "recording bash stub",
		parameters: Type.Object(
			{
				command: Type.String(),
			},
			{ additionalProperties: false },
		),
		baseActionClass: "execute",
		executionMode: "sequential",
		async run(args) {
			record.runs += 1;
			record.lastCommand = typeof args.command === "string" ? args.command : null;
			return { kind: "ok", output: "executed" };
		},
	};
}

describe("one-shot super grant for tool admission", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-one-shot-grant-"));
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		resetXdgCache();
		initializeClioHome();
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, key);
		}
		for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
			if (value !== undefined) process.env[key] = value;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	it("write outside cwd parks then runs under a one-shot grant without flipping the persistent mode", async () => {
		const safetyBundle = createSafetyBundle(makeContext());
		const modesBundle = createModesBundle(makeContext());
		await safetyBundle.extension.start();
		await modesBundle.extension.start();
		try {
			const record = { runs: 0, lastPath: null as string | null };
			const registry = createRegistry({ safety: safetyBundle.contract, modes: modesBundle.contract });
			registry.register(makeRecordingWriteSpec(record));

			const targetPath = join(tmpdir(), "clio-probe-test.txt");
			strictEqual(modesBundle.contract.current(), "default");

			const pending = registry.invoke({
				tool: ToolNames.Write,
				args: { path: targetPath, content: "hello clio" },
			});

			await Promise.resolve();
			strictEqual(registry.hasParkedCalls(), true, "write outside cwd must park");
			strictEqual(record.runs, 0, "parked call must not execute before confirmation");

			// User confirms the parked call via the tool-origin path. The
			// interactive layer issues a one-shot grant; the persistent mode
			// must NOT change.
			await registry.resumeParkedCalls({ mode: "super", requestedBy: "tool:one_shot" });

			const verdict = await pending;
			strictEqual(verdict.kind, "ok");
			if (verdict.kind === "ok") {
				strictEqual(verdict.result.kind, "ok");
			}
			strictEqual(record.runs, 1);
			strictEqual(record.lastPath, targetPath);
			strictEqual(registry.hasParkedCalls(), false);
			strictEqual(modesBundle.contract.current(), "default", "one-shot grant must not flip the persistent mode to super");
		} finally {
			await modesBundle.extension.stop?.();
			await safetyBundle.extension.stop?.();
		}
	});

	it("a follow-up privileged tool call after a one-shot grant is parked again, not auto-admitted", async () => {
		const safetyBundle = createSafetyBundle(makeContext());
		const modesBundle = createModesBundle(makeContext());
		await safetyBundle.extension.start();
		await modesBundle.extension.start();
		try {
			const writeRecord = { runs: 0, lastPath: null as string | null };
			const bashRecord = { runs: 0, lastCommand: null as string | null };
			const registry = createRegistry({ safety: safetyBundle.contract, modes: modesBundle.contract });
			registry.register(makeRecordingWriteSpec(writeRecord));
			registry.register(makeRecordingBashSpec(bashRecord));

			// First privileged call: parked, then resumed with a one-shot grant.
			const firstTarget = join(tmpdir(), "clio-one-shot-first.txt");
			const first = registry.invoke({
				tool: ToolNames.Write,
				args: { path: firstTarget, content: "x" },
			});
			await Promise.resolve();
			strictEqual(registry.hasParkedCalls(), true);
			await registry.resumeParkedCalls({ mode: "super", requestedBy: "tool:one_shot" });
			await first;
			strictEqual(writeRecord.runs, 1);
			strictEqual(modesBundle.contract.current(), "default");

			// Second privileged call (a different tool, different action): must
			// re-enter the live mode gate. No grant carries over. The persistent
			// mode is still default, so the call MUST park, not auto-execute.
			const second = registry.invoke({
				tool: ToolNames.Bash,
				args: { command: "sudo apt install ripgrep" },
			});
			await Promise.resolve();
			strictEqual(registry.hasParkedCalls(), true, "second privileged call must park, not auto-elevate");
			strictEqual(bashRecord.runs, 0);

			// Cancel the second one to drain the queue cleanly.
			registry.cancelParkedCalls("test cleanup");
			const verdict = await second;
			strictEqual(verdict.kind, "blocked");
			strictEqual(modesBundle.contract.current(), "default");
		} finally {
			await modesBundle.extension.stop?.();
			await safetyBundle.extension.stop?.();
		}
	});

	it("one-shot grant admits only one parked call when another parks before confirmation", async () => {
		const safetyBundle = createSafetyBundle(makeContext());
		const modesBundle = createModesBundle(makeContext());
		await safetyBundle.extension.start();
		await modesBundle.extension.start();
		try {
			const record = { runs: 0, lastPath: null as string | null };
			const registry = createRegistry({ safety: safetyBundle.contract, modes: modesBundle.contract });
			registry.register(makeRecordingWriteSpec(record));

			const firstTarget = join(tmpdir(), "clio-one-shot-queued-first.txt");
			const secondTarget = join(tmpdir(), "clio-one-shot-queued-second.txt");
			const first = registry.invoke({
				tool: ToolNames.Write,
				args: { path: firstTarget, content: "first" },
			});
			await Promise.resolve();
			const second = registry.invoke({
				tool: ToolNames.Write,
				args: { path: secondTarget, content: "second" },
			});
			await Promise.resolve();
			strictEqual(registry.hasParkedCalls(), true);
			strictEqual(record.runs, 0);

			await registry.resumeParkedCalls({ mode: "super", requestedBy: "tool:one_shot" });
			const firstVerdict = await first;
			strictEqual(firstVerdict.kind, "ok");
			strictEqual(record.runs, 1);
			strictEqual(record.lastPath, firstTarget);
			strictEqual(registry.hasParkedCalls(), true, "second parked call must require its own confirmation");

			registry.cancelParkedCalls("second call still needs explicit confirmation");
			const secondVerdict = await second;
			strictEqual(secondVerdict.kind, "blocked");
			strictEqual(record.runs, 1);
			strictEqual(modesBundle.contract.current(), "default");
		} finally {
			await modesBundle.extension.stop?.();
			await safetyBundle.extension.stop?.();
		}
	});

	it("persistent Alt+S confirmation still flips mode to super so subsequent calls run without prompts", async () => {
		const safetyBundle = createSafetyBundle(makeContext());
		const modesBundle = createModesBundle(makeContext());
		await safetyBundle.extension.start();
		await modesBundle.extension.start();
		try {
			const record = { runs: 0, lastCommand: null as string | null };
			const registry = createRegistry({ safety: safetyBundle.contract, modes: modesBundle.contract });
			registry.register(makeRecordingBashSpec(record));

			// Pre-arm super via the keybind path: requestSuper + confirmSuper.
			modesBundle.contract.requestSuper("keybind");
			strictEqual(modesBundle.contract.confirmSuper({ requestedBy: "keybind", acceptedAt: 0 }), "super");
			strictEqual(modesBundle.contract.current(), "super");

			// Now a privileged call runs immediately, without parking.
			const verdict = await registry.invoke({
				tool: ToolNames.Bash,
				args: { command: "sudo apt install ripgrep" },
			});
			strictEqual(verdict.kind, "ok");
			strictEqual(record.runs, 1);
			strictEqual(registry.hasParkedCalls(), false);
		} finally {
			await modesBundle.extension.stop?.();
			await safetyBundle.extension.stop?.();
		}
	});

	it("one-shot grant respects hard-block actions even with super grant", async () => {
		const safetyBundle = createSafetyBundle(makeContext());
		const modesBundle = createModesBundle(makeContext());
		await safetyBundle.extension.start();
		await modesBundle.extension.start();
		try {
			const record = { runs: 0, lastCommand: null as string | null };
			const registry = createRegistry({ safety: safetyBundle.contract, modes: modesBundle.contract });
			registry.register(makeRecordingBashSpec(record));

			const verdict = await registry.invoke({
				tool: ToolNames.Bash,
				args: { command: "git push --force origin main" },
			});
			strictEqual(verdict.kind, "blocked");
			ok(!registry.hasParkedCalls(), "hard-blocked actions must terminate, never park");
			strictEqual(record.runs, 0);

			// Even if a one-shot grant is supplied, a hard-block already
			// short-circuited at admission. Resuming with a grant must not
			// resurrect the call.
			await registry.resumeParkedCalls({ mode: "super", requestedBy: "tool:one_shot" });
			strictEqual(record.runs, 0);

			const systemModifyVerdict = await registry.invoke({
				tool: ToolNames.Bash,
				args: { command: "rm -rf /" },
			});
			strictEqual(systemModifyVerdict.kind, "blocked");
			ok(!registry.hasParkedCalls(), "system_modify hard blocks must terminate, never park");
			await registry.resumeParkedCalls({ mode: "super", requestedBy: "tool:one_shot" });
			strictEqual(record.runs, 0);
			strictEqual(modesBundle.contract.current(), "default");
		} finally {
			await modesBundle.extension.stop?.();
			await safetyBundle.extension.stop?.();
		}
	});
});
