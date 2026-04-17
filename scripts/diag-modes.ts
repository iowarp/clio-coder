import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Slice 5 diag harness. Wires Config + Safety + Modes domains against an
 * ephemeral CLIO_HOME and asserts the modes contract flows:
 *  - initial mode = "default" (from defaults)
 *  - tool visibility per mode
 *  - cycleNormal() flips default <-> advise
 *  - requestSuper emits a confirmation event without flipping
 *  - confirmSuper flips into super and persists state.lastMode
 *  - git_destructive remains hard-blocked in super
 *
 * Mirrors the hermeticity pattern from diag-safety.ts.
 */

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-modes] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-modes] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

interface ModeChangedEvent {
	from: string | null;
	to: string;
	reason?: string | null;
	requestedBy?: string;
	requiresConfirmation?: boolean;
	at: number;
}

async function runDomainHarness(): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "clio-diag-modes-"));
	const ENV_KEYS = ["CLIO_HOME", "CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const;
	const snapshot = new Map<string, string | undefined>();
	for (const k of ENV_KEYS) snapshot.set(k, process.env[k]);
	// Clear per-kind overrides BEFORE setting CLIO_HOME so xdg resolves inside
	// the ephemeral home rather than any inherited override.
	for (const k of ["CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const) {
		delete process.env[k];
	}
	process.env.CLIO_HOME = home;
	try {
		const { resetXdgCache, clioDataDir, clioConfigDir } = await import("../src/core/xdg.js");
		resetXdgCache();
		const expectedData = join(home, "data");
		const resolvedData = clioDataDir();
		if (resolvedData !== expectedData) {
			throw new Error(`expected data dir ${expectedData}, got ${resolvedData}`);
		}
		check("xdg:data-dir-matches-home", true);

		const { resetSharedBus, getSharedBus } = await import("../src/core/shared-bus.js");
		resetSharedBus();
		const { loadDomains } = await import("../src/core/domain-loader.js");
		const { ConfigDomainModule } = await import("../src/domains/config/index.js");
		const { SafetyDomainModule } = await import("../src/domains/safety/index.js");
		const { ModesDomainModule } = await import("../src/domains/modes/index.js");
		const { BusChannels } = await import("../src/core/bus-events.js");
		const { resetPackageRootCache } = await import("../src/core/package-root.js");
		resetPackageRootCache();

		// Touch settings.yaml so the config domain watcher has a target inode.
		writeFileSync(join(home, "settings.yaml"), "");

		const bus = getSharedBus();
		const modeEvents: ModeChangedEvent[] = [];
		bus.on(BusChannels.ModeChanged, (evt: unknown) => {
			modeEvents.push(evt as ModeChangedEvent);
		});

		const result = await loadDomains([ConfigDomainModule, SafetyDomainModule, ModesDomainModule]);
		check("domain:loaded", result.loaded.includes("modes"), `loaded=${result.loaded.join(",")}`);

		type ModesContractType = import("../src/domains/modes/contract.js").ModesContract;
		const modes = result.getContract<ModesContractType>("modes");
		check("domain:contract-exposed", modes !== undefined);
		if (!modes) {
			await result.stop();
			return;
		}

		// Boot event
		check(
			"bus:boot-mode-changed",
			modeEvents.some((e) => e.reason === "boot" && e.to === "default"),
			`events=${JSON.stringify(modeEvents)}`,
		);

		// Initial state
		check("current:default-at-boot", modes.current() === "default", `got ${modes.current()}`);
		check("visible:read-in-default", modes.isToolVisible("read") === true);
		check("visible:write-in-default", modes.isToolVisible("write") === true);

		// cycleNormal -> advise
		const afterFirstCycle = modes.cycleNormal();
		check("cycle:default-to-advise", afterFirstCycle === "advise", `got ${afterFirstCycle}`);
		check("visible:write-hidden-in-advise", modes.isToolVisible("write") === false);
		check("visible:write_plan-visible-in-advise", modes.isToolVisible("write_plan") === true);

		// cycleNormal -> default
		const afterSecondCycle = modes.cycleNormal();
		check("cycle:advise-to-default", afterSecondCycle === "default", `got ${afterSecondCycle}`);

		// requestSuper should NOT flip, but should emit requiresConfirmation event
		const beforeRequest = modes.current();
		modes.requestSuper("diag");
		check("request-super:no-flip", modes.current() === beforeRequest, `got ${modes.current()}`);
		check(
			"request-super:event-with-confirmation",
			modeEvents.some((e) => e.to === "super" && e.requiresConfirmation === true && e.requestedBy === "diag"),
			`events=${JSON.stringify(modeEvents.slice(-3))}`,
		);

		// confirmSuper flips
		const confirmed = modes.confirmSuper({ requestedBy: "diag", acceptedAt: Date.now() });
		check("confirm-super:flips-to-super", confirmed === "super" && modes.current() === "super");
		check("action:system_modify-allowed-in-super", modes.isActionAllowed("system_modify") === true);
		check("action:git_destructive-always-blocked", modes.isActionAllowed("git_destructive") === false);

		// settings.yaml should now reflect lastMode=super
		const settingsPath = join(clioConfigDir(), "settings.yaml");
		check("settings:file-exists", existsSync(settingsPath), settingsPath);
		if (existsSync(settingsPath)) {
			const raw = readFileSync(settingsPath, "utf8");
			const parsed = parseYaml(raw) as { state?: { lastMode?: string } } | null;
			check(
				"settings:lastMode-persisted-super",
				parsed?.state?.lastMode === "super",
				`got ${String(parsed?.state?.lastMode)}`,
			);
		}

		await result.stop();
	} finally {
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
		for (const [k, v] of snapshot) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

async function main(): Promise<void> {
	await runDomainHarness();

	if (failures.length > 0) {
		process.stderr.write(`[diag-modes] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-modes] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-modes] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
