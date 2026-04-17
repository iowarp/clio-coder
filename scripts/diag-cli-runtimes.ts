/**
 * Phase 7 diag. Exercises each CLI-tier RuntimeAdapter stub without spawning
 * any external binary. Verifies adapter shape, capability manifest parity,
 * and canSatisfy robustness when binaries are absent from PATH.
 */

import { CLI_CAPABILITIES, type TelemetryTier } from "../src/domains/providers/runtimes/capability-manifest.js";
import { CLI_ADAPTERS } from "../src/domains/providers/runtimes/cli/index.js";
import { RUNTIME_ADAPTERS } from "../src/domains/providers/runtimes/index.js";

const EXPECTED_IDS = ["pi-coding-agent", "claude-code", "codex", "gemini", "opencode", "copilot"] as const;

const VALID_TELEMETRY: ReadonlySet<TelemetryTier> = new Set(["gold", "silver", "bronze"]);

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-cli-runtimes] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-cli-runtimes] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function main(): Promise<void> {
	check("adapters:length", CLI_ADAPTERS.length === 6, `len=${CLI_ADAPTERS.length}`);

	const adapterIds = CLI_ADAPTERS.map((a) => String(a.id));
	const expectedIdSet = new Set<string>(EXPECTED_IDS);
	check(
		"adapters:ids-match-expected",
		adapterIds.length === expectedIdSet.size && adapterIds.every((id) => expectedIdSet.has(id)),
		`got ${JSON.stringify(adapterIds)}`,
	);

	for (const adapter of CLI_ADAPTERS) {
		const id = String(adapter.id);
		check(`${id}:tier-is-cli`, adapter.tier === "cli", `tier=${adapter.tier}`);

		let verdict: { ok: boolean; reason: string } | null = null;
		let threw: unknown = null;
		try {
			verdict = adapter.canSatisfy({ modelId: "", credentialsPresent: new Set<string>() });
		} catch (err) {
			threw = err;
		}
		check(`${id}:canSatisfy-nothrow`, threw === null, threw === null ? undefined : String(threw));
		check(
			`${id}:canSatisfy-shape`,
			verdict !== null && typeof verdict.ok === "boolean" && typeof verdict.reason === "string",
			`got ${JSON.stringify(verdict)}`,
		);

		const health = adapter.initialHealth();
		check(
			`${id}:initialHealth-unknown`,
			health.status === "unknown" && health.providerId === id,
			`got ${JSON.stringify(health)}`,
		);

		const probe = await adapter.probe();
		check(`${id}:probe-shape`, typeof probe.ok === "boolean", `got ${JSON.stringify(probe)}`);
	}

	// Capability manifest parity.
	check("capabilities:length", CLI_CAPABILITIES.length === 6, `len=${CLI_CAPABILITIES.length}`);
	const capIds = CLI_CAPABILITIES.map((c) => c.id).sort();
	const adapterIdsSorted = [...adapterIds].sort();
	check(
		"capabilities:ids-match-adapters",
		capIds.length === adapterIdsSorted.length && capIds.every((id, i) => id === adapterIdsSorted[i]),
		`caps=${JSON.stringify(capIds)} adapters=${JSON.stringify(adapterIdsSorted)}`,
	);

	for (const cap of CLI_CAPABILITIES) {
		check(
			`capability:${cap.id}:booleans`,
			typeof cap.supportsStreaming === "boolean" && typeof cap.supportsStructuredOutput === "boolean",
			`got streaming=${cap.supportsStreaming} structured=${cap.supportsStructuredOutput}`,
		);
		check(`capability:${cap.id}:telemetry`, VALID_TELEMETRY.has(cap.telemetry), `telemetry=${cap.telemetry}`);
		check(`capability:${cap.id}:binary`, typeof cap.binary === "string" && cap.binary.length > 0, `binary=${cap.binary}`);
		check(
			`capability:${cap.id}:helpFlags`,
			Array.isArray(cap.helpFlags) && cap.helpFlags.every((f) => typeof f === "string"),
			`helpFlags=${JSON.stringify(cap.helpFlags)}`,
		);
	}

	// RUNTIME_ADAPTERS contains both provider + CLI adapters.
	const cliInRegistry = RUNTIME_ADAPTERS.filter((a) => a.tier === "cli");
	check("registry:includes-cli", cliInRegistry.length === 6, `count=${cliInRegistry.length}`);

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
