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
import { ENTER, ESC, routeSuperOverlayKey, type SuperOverlayKeyDeps } from "../../src/interactive/index.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";

// Row 49 of TEST-RUBRIC.md. When the LLM emits a bash batch that
// classifies as system_modify while the orchestrator sits in default
// mode, the registry must park the call (not reject it), open the
// super overlay, and execute the parked call once the user confirms
// the mode transition. These tests drive the real modes + safety
// bundles so the pending guard on confirmSuper, the damage-control
// ruleset, and the audit-writer pipeline are all exercised, not
// stubbed.

const ORIGINAL_ENV = { ...process.env };

function makeContext(): DomainContext {
	return {
		bus: createSafeEventBus(),
		getContract: () => undefined,
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

describe("super-mode elevation end-to-end", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-super-elevation-"));
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

	it("parks a system_modify bash batch in default mode and executes it after the real confirmSuper gate flips", async () => {
		const safetyBundle = createSafetyBundle(makeContext());
		const modesBundle = createModesBundle(makeContext());
		await safetyBundle.extension.start();
		await modesBundle.extension.start();
		try {
			const record = { runs: 0, lastCommand: null as string | null };
			const registry = createRegistry({ safety: safetyBundle.contract, modes: modesBundle.contract });
			registry.register(makeRecordingBashSpec(record));

			const command = "sudo apt install ripgrep";
			const pending = registry.invoke({ tool: ToolNames.Bash, args: { command } });

			await Promise.resolve();
			strictEqual(registry.hasParkedCalls(), true);
			strictEqual(record.runs, 0);

			// confirmSuper without a prior requestSuper is a no-op per the
			// real pending guard in createModesBundle. Assert the guard fires
			// so the test regresses if someone bypasses requestSuper.
			strictEqual(modesBundle.contract.confirmSuper({ requestedBy: "test", acceptedAt: 0 }), "default");
			strictEqual(modesBundle.contract.current(), "default");

			modesBundle.contract.requestSuper("keybind");
			modesBundle.contract.confirmSuper({ requestedBy: "keybind", acceptedAt: Date.now() });
			strictEqual(modesBundle.contract.current(), "super");
			await registry.resumeParkedCalls();

			const verdict = await pending;
			strictEqual(verdict.kind, "ok");
			if (verdict.kind === "ok") {
				strictEqual(verdict.result.kind, "ok");
				if (verdict.result.kind === "ok") {
					strictEqual(verdict.result.output, "executed");
				}
			}
			strictEqual(record.runs, 1);
			strictEqual(record.lastCommand, command);
			strictEqual(registry.hasParkedCalls(), false);
		} finally {
			await modesBundle.extension.stop?.();
			await safetyBundle.extension.stop?.();
		}
	});

	it("rejects a parked call with a clean blocked verdict when the user cancels the super overlay", async () => {
		const safetyBundle = createSafetyBundle(makeContext());
		const modesBundle = createModesBundle(makeContext());
		await safetyBundle.extension.start();
		await modesBundle.extension.start();
		try {
			const record = { runs: 0, lastCommand: null as string | null };
			const registry = createRegistry({ safety: safetyBundle.contract, modes: modesBundle.contract });
			registry.register(makeRecordingBashSpec(record));

			const pending = registry.invoke({
				tool: ToolNames.Bash,
				args: { command: "pip install requests" },
			});

			await Promise.resolve();
			strictEqual(registry.hasParkedCalls(), true);

			const cancelReason = "super mode confirmation cancelled";
			registry.cancelParkedCalls(cancelReason);
			const verdict = await pending;
			strictEqual(verdict.kind, "blocked");
			if (verdict.kind === "blocked") {
				strictEqual(verdict.reason, cancelReason);
			}
			strictEqual(record.runs, 0);
			strictEqual(registry.hasParkedCalls(), false);
			strictEqual(modesBundle.contract.current(), "default");
		} finally {
			await modesBundle.extension.stop?.();
			await safetyBundle.extension.stop?.();
		}
	});

	it("routeSuperOverlayKey drives the full Enter/Esc lifecycle through the real modes bundle", async () => {
		const safetyBundle = createSafetyBundle(makeContext());
		const modesBundle = createModesBundle(makeContext());
		await safetyBundle.extension.start();
		await modesBundle.extension.start();
		try {
			const record = { runs: 0, lastCommand: null as string | null };
			const registry = createRegistry({ safety: safetyBundle.contract, modes: modesBundle.contract });
			registry.register(makeRecordingBashSpec(record));

			let overlayOpen = false;
			registry.onSuperRequired(() => {
				if (overlayOpen) return;
				overlayOpen = true;
				modesBundle.contract.requestSuper("tool");
			});
			// Mirror the production closeOverlay() semantics: when leaving the
			// super-confirm overlay, current mode drives whether parked calls
			// resume or cancel.
			const closeOverlay = (): void => {
				overlayOpen = false;
				if (modesBundle.contract.current() === "super") {
					void registry.resumeParkedCalls();
				} else {
					registry.cancelParkedCalls("super mode confirmation cancelled");
				}
			};

			const pending = registry.invoke({
				tool: ToolNames.Bash,
				args: { command: "brew install coreutils" },
			});
			await Promise.resolve();
			strictEqual(overlayOpen, true, "super overlay should open on park");
			strictEqual(registry.hasParkedCalls(), true);

			const overlayDeps: SuperOverlayKeyDeps = {
				now: () => 1_700_000_000_000,
				cancelSuper: () => closeOverlay(),
				confirmSuper: (conf) => {
					modesBundle.contract.confirmSuper(conf);
					closeOverlay();
				},
			};
			strictEqual(routeSuperOverlayKey(ENTER, overlayDeps), true);

			const verdict = await pending;
			strictEqual(verdict.kind, "ok");
			strictEqual(record.runs, 1);
			strictEqual(modesBundle.contract.current(), "super");
			strictEqual(overlayOpen, false);
			strictEqual(registry.hasParkedCalls(), false);
		} finally {
			await modesBundle.extension.stop?.();
			await safetyBundle.extension.stop?.();
		}
	});

	it("Esc in the super overlay cancels the parked call and leaves the mode unchanged", async () => {
		const safetyBundle = createSafetyBundle(makeContext());
		const modesBundle = createModesBundle(makeContext());
		await safetyBundle.extension.start();
		await modesBundle.extension.start();
		try {
			const record = { runs: 0, lastCommand: null as string | null };
			const registry = createRegistry({ safety: safetyBundle.contract, modes: modesBundle.contract });
			registry.register(makeRecordingBashSpec(record));

			let overlayOpen = false;
			registry.onSuperRequired(() => {
				overlayOpen = true;
				modesBundle.contract.requestSuper("tool");
			});
			const closeOverlay = (): void => {
				overlayOpen = false;
				if (modesBundle.contract.current() === "super") {
					void registry.resumeParkedCalls();
				} else {
					registry.cancelParkedCalls("super mode confirmation cancelled");
				}
			};

			const pending = registry.invoke({
				tool: ToolNames.Bash,
				args: { command: "systemctl restart clio" },
			});
			await Promise.resolve();
			strictEqual(overlayOpen, true);

			const overlayDeps: SuperOverlayKeyDeps = {
				now: () => 0,
				cancelSuper: () => closeOverlay(),
				confirmSuper: (conf) => {
					modesBundle.contract.confirmSuper(conf);
					closeOverlay();
				},
			};
			strictEqual(routeSuperOverlayKey(ESC, overlayDeps), true);

			const verdict = await pending;
			strictEqual(verdict.kind, "blocked");
			strictEqual(record.runs, 0);
			strictEqual(modesBundle.contract.current(), "default");
			strictEqual(overlayOpen, false);
		} finally {
			await modesBundle.extension.stop?.();
			await safetyBundle.extension.stop?.();
		}
	});

	it("worker-shaped registry (no elevation path) rejects system_modify synchronously", async () => {
		const safetyBundle = createSafetyBundle(makeContext());
		await safetyBundle.extension.start();
		try {
			const record = { runs: 0, lastCommand: null as string | null };
			// Hand-rolled modes stub mirroring createWorkerModes: no elevation
			// target, pinned mode, no super transition. The registry must
			// therefore never park.
			const workerModes = {
				current: () => "default" as const,
				setMode: () => "default" as const,
				cycleNormal: () => "default" as const,
				visibleTools: () => new Set([ToolNames.Bash]),
				isToolVisible: (t: string) => t === ToolNames.Bash,
				isActionAllowed: (action: string) => action === "execute" || action === "read" || action === "write",
				requestSuper: () => {},
				confirmSuper: () => "default" as const,
				elevatedModeFor: () => null,
			};
			const registry = createRegistry({ safety: safetyBundle.contract, modes: workerModes });
			registry.register(makeRecordingBashSpec(record));

			const verdict = await registry.invoke({
				tool: ToolNames.Bash,
				args: { command: "sudo apt-get install foo" },
			});
			strictEqual(verdict.kind, "blocked");
			if (verdict.kind === "blocked") {
				strictEqual(verdict.reason, "action system_modify not allowed in mode default");
			}
			strictEqual(record.runs, 0);
			strictEqual(registry.hasParkedCalls(), false);
		} finally {
			await safetyBundle.extension.stop?.();
		}
	});

	it("re-opens the super overlay when a parked call arrived while a different overlay was in front", async () => {
		const safetyBundle = createSafetyBundle(makeContext());
		const modesBundle = createModesBundle(makeContext());
		await safetyBundle.extension.start();
		await modesBundle.extension.start();
		try {
			const record = { runs: 0, lastCommand: null as string | null };
			const registry = createRegistry({ safety: safetyBundle.contract, modes: modesBundle.contract });
			registry.register(makeRecordingBashSpec(record));

			// Mirror the production closeOverlay invariant: after closing any
			// overlay, if the registry still has parked calls the caller must
			// open the super overlay so the user gets a confirmation prompt.
			type OverlayName = "providers" | "super-confirm" | null;
			let overlayState: OverlayName = null;
			const openSuperOverlay = (requestedBy: string): void => {
				if (overlayState !== null) return;
				overlayState = "super-confirm";
				modesBundle.contract.requestSuper(requestedBy);
			};
			registry.onSuperRequired(() => openSuperOverlay("tool"));
			const closeOverlay = (): void => {
				const leaving = overlayState;
				overlayState = null;
				if (leaving === "super-confirm") {
					if (modesBundle.contract.current() === "super") {
						void registry.resumeParkedCalls();
					} else {
						registry.cancelParkedCalls("super mode confirmation cancelled");
					}
				}
				if (overlayState === null && registry.hasParkedCalls()) {
					openSuperOverlay("tool");
				}
			};

			// User has the target status overlay open when the agent emits a privileged call.
			overlayState = "providers";
			const pending = registry.invoke({
				tool: ToolNames.Bash,
				args: { command: "npm install -g @iowarp/clio-coder" },
			});
			await Promise.resolve();
			// onSuperRequired fired but openSuperOverlay saw a non-null state
			// and no-opped. The call is still parked.
			strictEqual(overlayState, "providers");
			strictEqual(registry.hasParkedCalls(), true);

			// User closes the target status overlay via Esc. closeOverlay observes the parked
			// queue and opens the super overlay.
			closeOverlay();
			strictEqual(overlayState, "super-confirm");
			strictEqual(registry.hasParkedCalls(), true);

			// User confirms; closeOverlay resumes the queue.
			modesBundle.contract.confirmSuper({ requestedBy: "keybind", acceptedAt: Date.now() });
			closeOverlay();
			const verdict = await pending;
			strictEqual(verdict.kind, "ok");
			strictEqual(record.runs, 1);
			strictEqual(registry.hasParkedCalls(), false);
		} finally {
			await modesBundle.extension.stop?.();
			await safetyBundle.extension.stop?.();
		}
	});

	it("still hard-blocks git_destructive even when elevation is available", async () => {
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
			ok(!registry.hasParkedCalls());
			strictEqual(record.runs, 0);
		} finally {
			await modesBundle.extension.stop?.();
			await safetyBundle.extension.stop?.();
		}
	});
});
