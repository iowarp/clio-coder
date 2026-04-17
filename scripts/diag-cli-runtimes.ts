/**
 * CLI-runtime diag. Exercises config-only readiness separately from the
 * explicit live probe path without spawning provider CLIs.
 */

import { CLI_CAPABILITIES, type TelemetryTier } from "../src/domains/providers/runtimes/capability-manifest.js";
import { CLI_ADAPTERS } from "../src/domains/providers/runtimes/cli/index.js";
import { RUNTIME_ADAPTERS } from "../src/domains/providers/runtimes/index.js";

type DiagMode = "config" | "live";

const EXPECTED_IDS = ["pi-coding-agent", "claude-code", "codex", "gemini", "opencode", "copilot"] as const;
const VALID_TELEMETRY: ReadonlySet<TelemetryTier> = new Set(["gold", "silver", "bronze"]);
const RUN_LIVE = process.env.CLIO_DIAG_LIVE === "1";

const failures: string[] = [];

function emit(status: "OK" | "FAIL" | "SKIP", mode: DiagMode, label: string, detail?: string): void {
	const suffix = detail ? ` ${detail}` : "";
	const line = `[diag-cli-runtimes] [${mode}] ${status.padEnd(4)} ${label}${suffix}\n`;
	if (status === "FAIL") process.stderr.write(line);
	else process.stdout.write(line);
}

function check(mode: DiagMode, label: string, ok: boolean, detail?: string): void {
	if (ok) {
		emit("OK", mode, label);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	emit("FAIL", mode, label, detail ? `(${detail})` : undefined);
}

function skip(mode: DiagMode, label: string, detail: string): void {
	emit("SKIP", mode, label, `(${detail})`);
}

async function main(): Promise<void> {
	check("config", "adapters:length", CLI_ADAPTERS.length === 6, `len=${CLI_ADAPTERS.length}`);

	const adapterIds = CLI_ADAPTERS.map((a) => String(a.id));
	const expectedIdSet = new Set<string>(EXPECTED_IDS);
	check(
		"config",
		"adapters:ids-match-expected",
		adapterIds.length === expectedIdSet.size && adapterIds.every((id) => expectedIdSet.has(id)),
		`got ${JSON.stringify(adapterIds)}`,
	);

	for (const adapter of CLI_ADAPTERS) {
		const id = String(adapter.id);
		check("config", `${id}:tier-is-cli`, adapter.tier === "cli", `tier=${adapter.tier}`);

		let verdict: { ok: boolean; reason: string } | null = null;
		let threw: unknown = null;
		try {
			verdict = adapter.canSatisfy({ modelId: "", credentialsPresent: new Set<string>() });
		} catch (err) {
			threw = err;
		}
		check("config", `${id}:canSatisfy-nothrow`, threw === null, threw === null ? undefined : String(threw));
		check(
			"config",
			`${id}:canSatisfy-shape`,
			verdict !== null && typeof verdict.ok === "boolean" && typeof verdict.reason === "string",
			`got ${JSON.stringify(verdict)}`,
		);

		const health = adapter.initialHealth();
		check(
			"config",
			`${id}:initialHealth-unknown`,
			health.status === "unknown" && health.providerId === id,
			`got ${JSON.stringify(health)}`,
		);

		const probe = await adapter.probe();
		check("config", `${id}:probe-shape`, typeof probe.ok === "boolean", `got ${JSON.stringify(probe)}`);
		check("config", `${id}:probeLive-exposed`, typeof adapter.probeLive === "function");
		if (adapter.probeLive) {
			const live = await adapter.probeLive();
			const expectedError = probe.ok ? `live probe not implemented for ${id}; config-only` : probe.error;
			check(
				"config",
				`${id}:probeLive-contract`,
				live.ok === false && live.error === expectedError,
				`probe=${JSON.stringify(probe)} live=${JSON.stringify(live)}`,
			);
		}

		if (!RUN_LIVE) {
			skip("live", `${id}:probeLive-live-skip`, "stub adapter contract is already asserted in config mode");
			continue;
		}
		skip("live", `${id}:probeLive-live-skip`, "stub adapter contract is already asserted in config mode");
	}

	check("config", "capabilities:length", CLI_CAPABILITIES.length === 6, `len=${CLI_CAPABILITIES.length}`);
	const capIds = CLI_CAPABILITIES.map((c) => c.id).sort();
	const adapterIdsSorted = [...adapterIds].sort();
	check(
		"config",
		"capabilities:ids-match-adapters",
		capIds.length === adapterIdsSorted.length && capIds.every((id, i) => id === adapterIdsSorted[i]),
		`caps=${JSON.stringify(capIds)} adapters=${JSON.stringify(adapterIdsSorted)}`,
	);

	for (const cap of CLI_CAPABILITIES) {
		check(
			"config",
			`capability:${cap.id}:booleans`,
			typeof cap.supportsStreaming === "boolean" && typeof cap.supportsStructuredOutput === "boolean",
			`got streaming=${cap.supportsStreaming} structured=${cap.supportsStructuredOutput}`,
		);
		check("config", `capability:${cap.id}:telemetry`, VALID_TELEMETRY.has(cap.telemetry), `telemetry=${cap.telemetry}`);
		check(
			"config",
			`capability:${cap.id}:binary`,
			typeof cap.binary === "string" && cap.binary.length > 0,
			`binary=${cap.binary}`,
		);
		check(
			"config",
			`capability:${cap.id}:helpFlags`,
			Array.isArray(cap.helpFlags) && cap.helpFlags.every((f) => typeof f === "string"),
			`helpFlags=${JSON.stringify(cap.helpFlags)}`,
		);
	}

	const cliInRegistry = RUNTIME_ADAPTERS.filter((a) => a.tier === "cli");
	check("config", "registry:includes-cli", cliInRegistry.length === 6, `count=${cliInRegistry.length}`);

	if (failures.length > 0) {
		process.stderr.write(`[diag-cli-runtimes] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-cli-runtimes] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-cli-runtimes] ERROR ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
