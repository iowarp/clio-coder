import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { type ClioSettings, readSettings, settingsPath, writeSettings } from "../src/core/config.js";
import { loadDomains } from "../src/core/domain-loader.js";
import { initializeClioHome } from "../src/core/init.js";
import { resetSharedBus } from "../src/core/shared-bus.js";
import { resetXdgCache } from "../src/core/xdg.js";
import type { ChangeKind, ConfigDiff } from "../src/domains/config/classify.js";
import type { ConfigContract } from "../src/domains/config/contract.js";
import { ConfigDomainModule } from "../src/domains/config/index.js";

/**
 * Phase 1 Front 2 diag: config hot-reload matrix.
 *
 * Boots the config domain in an ephemeral CLIO_HOME, attaches one listener per
 * ChangeKind channel via ConfigContract.onChange, and exercises the full
 * classify/dispatch path with live file edits:
 *
 *   (1) hotReload round:        theme: "default" -> "dark"
 *   (2) nextTurn round:         budget.sessionCeilingUsd: 5 -> 10
 *   (3) restartRequired round:  provider.active: null -> "anthropic"
 *   (4) invalid-edit round:     safetyLevel: "bogus"
 *
 * For rounds 1-3, asserts the matching listener fires within 2s, the diff
 * includes the expected path in the expected bucket, the OTHER buckets stay
 * quiet for that round, and contract.get() reflects the new value.
 *
 * For round 4, asserts:
 *   - "reload rejected" appears on stderr (the prefix emitted by
 *     extension.ts line 53 when validate() throws),
 *   - contract.get() still returns the last valid snapshot (NOT the bogus
 *     one),
 *   - no listener fired.
 *
 * Success: clean the ephemeral CLIO_HOME and exit 0.
 * Failure: keep the ephemeral CLIO_HOME for post-mortem, log the path, exit 1.
 */

type BucketEvent = { diff: ConfigDiff; settings: Readonly<ClioSettings> };

let ephemeralHome: string | null = null;

function log(msg: string): void {
	process.stdout.write(`[diag-config] ${msg}\n`);
}

function cleanEphemeralHome(): void {
	if (!ephemeralHome) return;
	rmSync(ephemeralHome, { recursive: true, force: true });
	log(`cleaned ephemeral CLIO_HOME=${ephemeralHome}`);
	ephemeralHome = null;
}

function fail(msg: string, extra?: string): never {
	// writes to process.stderr.write to bypass the overridden console.error so dumped output isn't re-captured.
	process.stderr.write(`[diag-config] FAIL: ${msg}\n`);
	if (extra) process.stderr.write(`${extra}\n`);
	if (ephemeralHome) {
		process.stderr.write(`[diag-config] keeping CLIO_HOME for post-mortem: ${ephemeralHome}\n`);
	}
	process.exit(1);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, capMs: number, pollMs = 10): Promise<{ ok: boolean; elapsedMs: number }> {
	const start = Date.now();
	const deadline = start + capMs;
	while (!check()) {
		if (Date.now() > deadline) return { ok: false, elapsedMs: Date.now() - start };
		await sleep(pollMs);
	}
	return { ok: true, elapsedMs: Date.now() - start };
}

async function main(): Promise<void> {
	// Step 1: ephemeral CLIO_HOME + bootstrap tree.
	const home = mkdtempSync(join(tmpdir(), "clio-diag-config-"));
	ephemeralHome = home;
	log(`ephemeral CLIO_HOME=${home}`);
	process.env.CLIO_HOME = home;
	// Clear cached XDG dirs so clioConfigDir() recomputes against the new CLIO_HOME.
	resetXdgCache();
	// Clear any prior shared bus so listeners from earlier processes don't leak.
	resetSharedBus();

	initializeClioHome();
	const path = settingsPath();
	log(`settings path: ${path}`);

	// Step 2: intercept console.error so we can assert invalid-edit error text.
	const originalError = console.error;
	let capturedStderr = "";
	console.error = (...args: unknown[]): void => {
		capturedStderr += `${args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")}\n`;
		originalError(...args);
	};

	// Step 3: boot config domain via loadDomains and fetch the contract.
	const result = await loadDomains([ConfigDomainModule]);
	if (!result.loaded.includes("config")) {
		fail(`config domain did not load cleanly; loaded=${JSON.stringify(result.loaded)}`);
	}
	const contract: ConfigContract =
		result.getContract<ConfigContract>("config") ?? fail("loadDomains.getContract('config') returned undefined");

	// Step 4: attach one listener per ChangeKind channel.
	const received: Record<ChangeKind, BucketEvent[]> = {
		hotReload: [],
		nextTurn: [],
		restartRequired: [],
	};
	const unsubs: Array<() => void> = [];
	for (const kind of ["hotReload", "nextTurn", "restartRequired"] as const) {
		unsubs.push(
			contract.onChange(kind, (payload) => {
				received[kind].push(payload);
			}),
		);
	}

	// Shared helper for rounds 1-3: mutate one bucket's field, wait for fire,
	// assert diff shape, assert other buckets stay quiet, assert contract.get()
	// reflects the new value.
	async function runRound(args: {
		label: string;
		bucket: ChangeKind;
		expectedPath: string;
		mutate: (s: ClioSettings) => void;
		assertValue: (s: Readonly<ClioSettings>) => boolean;
	}): Promise<void> {
		const baselineCounts = {
			hotReload: received.hotReload.length,
			nextTurn: received.nextTurn.length,
			restartRequired: received.restartRequired.length,
		};
		const current = readSettings();
		args.mutate(current);
		writeSettings(current);

		const { ok, elapsedMs } = await waitFor(() => received[args.bucket].length > baselineCounts[args.bucket], 2000);
		if (!ok) {
			fail(`[${args.label}] ${args.bucket} listener did not fire within 2s (elapsed=${elapsedMs}ms)`);
		}
		const event = received[args.bucket].at(-1);
		if (!event) fail(`[${args.label}] ${args.bucket} listener fired but event was undefined`);
		if (!event.diff[args.bucket].includes(args.expectedPath)) {
			fail(
				`[${args.label}] diff.${args.bucket} missing ${JSON.stringify(args.expectedPath)}; got ${JSON.stringify(event.diff[args.bucket])}`,
			);
		}
		// Other buckets must stay quiet for this round. fs.watch may briefly
		// emit a second event for the same write on some platforms, so we wait
		// a short post-debounce tail before taking the verdict.
		await sleep(150);
		for (const other of ["hotReload", "nextTurn", "restartRequired"] as const) {
			if (other === args.bucket) continue;
			if (received[other].length !== baselineCounts[other]) {
				fail(
					`[${args.label}] bucket ${other} fired unexpectedly: before=${baselineCounts[other]} after=${received[other].length}; last diff=${JSON.stringify(received[other].at(-1)?.diff)}`,
				);
			}
		}
		if (!args.assertValue(contract.get())) {
			fail(`[${args.label}] contract.get() did not reflect the new value after ${args.bucket} edit`);
		}
		log(`round PASS: ${args.label} (bucket=${args.bucket}, path=${args.expectedPath})`);
	}

	// Round 1: hotReload. theme: "default" -> "dark".
	await runRound({
		label: "round 1 / hotReload",
		bucket: "hotReload",
		expectedPath: "theme",
		mutate: (s) => {
			s.theme = "dark";
		},
		assertValue: (s) => s.theme === "dark",
	});

	// Round 2: nextTurn. budget.sessionCeilingUsd: 5 -> 10.
	await runRound({
		label: "round 2 / nextTurn",
		bucket: "nextTurn",
		expectedPath: "budget.sessionCeilingUsd",
		mutate: (s) => {
			s.budget = { ...s.budget, sessionCeilingUsd: 10 };
		},
		assertValue: (s) => s.budget.sessionCeilingUsd === 10,
	});

	// Round 3: restartRequired. provider.active: null -> "anthropic".
	await runRound({
		label: "round 3 / restartRequired",
		bucket: "restartRequired",
		expectedPath: "provider.active",
		mutate: (s) => {
			s.provider = { ...s.provider, active: "anthropic" };
		},
		assertValue: (s) => s.provider.active === "anthropic",
	});

	// Round 4: invalid edit. safetyLevel: "bogus".
	// Capture the snapshot we expect to survive the bad write, then stamp the
	// file with an invalid value and wait past the debounce.
	const preInvalidSnapshot = contract.get();
	const preInvalidSafety = preInvalidSnapshot.safetyLevel;
	const preInvalidCounts = {
		hotReload: received.hotReload.length,
		nextTurn: received.nextTurn.length,
		restartRequired: received.restartRequired.length,
	};
	// Round 4 intentionally writes a value that fails schema validation, so it
	// bypasses writeSettings (which would type-check its argument) and stamps
	// the file with raw YAML.
	const bogus = readSettings() as unknown as Record<string, unknown>;
	bogus.safetyLevel = "bogus";
	writeFileSync(path, stringifyYaml(bogus), { encoding: "utf8", mode: 0o644 });

	const { ok: sawError, elapsedMs: invalidElapsed } = await waitFor(
		() => capturedStderr.includes("reload rejected"),
		2000,
	);
	if (!sawError) {
		fail(
			`[invalid] expected 'reload rejected' on stderr after bogus safetyLevel (elapsed=${invalidElapsed}ms)`,
			`captured stderr so far:\n${capturedStderr}`,
		);
	}
	// Give the watcher a short tail window; if the snapshot were ever going to
	// flip to the bogus value, it would have happened by now.
	await sleep(150);
	const post = contract.get();
	if (post.safetyLevel !== preInvalidSafety) {
		fail(`[invalid] snapshot was replaced. pre=${String(preInvalidSafety)} post=${String(post.safetyLevel)}`);
	}
	for (const other of ["hotReload", "nextTurn", "restartRequired"] as const) {
		if (received[other].length !== preInvalidCounts[other]) {
			fail(
				`[invalid] bucket ${other} fired (before=${preInvalidCounts[other]} after=${received[other].length}); invalid edits must not dispatch`,
			);
		}
	}
	log("round PASS: round 4 / invalid edit (reload rejected, snapshot preserved, no dispatch)");

	// Teardown.
	for (const u of unsubs) u();
	await result.stop();
	console.error = originalError;
	log("PASS: all four rounds (hotReload, nextTurn, restartRequired, invalid)");
	cleanEphemeralHome();
	process.exit(0);
}

main().catch((err) => {
	process.stderr.write(`[diag-config] unexpected error: ${err instanceof Error ? err.stack : String(err)}\n`);
	if (ephemeralHome) {
		process.stderr.write(`[diag-config] keeping CLIO_HOME for post-mortem: ${ephemeralHome}\n`);
	}
	process.exit(1);
});
