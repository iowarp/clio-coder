/**
 * Phase 8 diag. Hermetic smoke test for the Claude Agent SDK adapter after the
 * dedicated sdk worker entry was removed from the v0.1 build.
 *
 * Asserts:
 *   1. claudeSdkAdapter.tier === "sdk".
 *   2. canSatisfy with empty credentials → ok:false.
 *   3. canSatisfy with ANTHROPIC_API_KEY present → ok:true.
 *   4. Build output no longer contains dist/worker/sdk-entry.js.
 *   5. RUNTIME_ADAPTERS includes an adapter with id "claude-sdk".
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { claudeSdkAdapter } from "../src/domains/providers/runtimes/claude-sdk.js";
import { RUNTIME_ADAPTERS } from "../src/domains/providers/runtimes/index.js";

const projectRoot = process.cwd();
const workerJs = path.join(projectRoot, "dist/worker/sdk-entry.js");

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-claude-sdk] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-claude-sdk] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function main(): Promise<void> {
	// 1. tier
	check("adapter:tier-sdk", claudeSdkAdapter.tier === "sdk", `tier=${claudeSdkAdapter.tier}`);

	// 2. canSatisfy with no creds
	const verdictEmpty = claudeSdkAdapter.canSatisfy({ modelId: "x", credentialsPresent: new Set<string>() });
	check("canSatisfy:empty-creds-false", verdictEmpty.ok === false, `got ${JSON.stringify(verdictEmpty)}`);

	// 3. canSatisfy with creds
	const verdictFull = claudeSdkAdapter.canSatisfy({
		modelId: "x",
		credentialsPresent: new Set<string>(["ANTHROPIC_API_KEY"]),
	});
	check("canSatisfy:creds-present-true", verdictFull.ok === true, `got ${JSON.stringify(verdictFull)}`);

	const probeEmpty = await claudeSdkAdapter.probe({ credentialsPresent: new Set<string>() });
	check(
		"probe:empty-creds-false",
		probeEmpty.ok === false && probeEmpty.error === "ANTHROPIC_API_KEY not set",
		`got ${JSON.stringify(probeEmpty)}`,
	);
	const probeLiveEmpty = await claudeSdkAdapter.probeLive?.({ credentialsPresent: new Set<string>() });
	check(
		"probeLive:empty-creds-false",
		probeLiveEmpty?.ok === false && probeLiveEmpty.error === "ANTHROPIC_API_KEY not set",
		`got ${JSON.stringify(probeLiveEmpty)}`,
	);
	const probeLiveReady = await claudeSdkAdapter.probeLive?.({
		credentialsPresent: new Set<string>(["ANTHROPIC_API_KEY"]),
	});
	check(
		"probeLive:ready-not-implemented",
		probeLiveReady?.ok === false && probeLiveReady.error === "live probe not implemented for claude-sdk; config-only",
		`got ${JSON.stringify(probeLiveReady)}`,
	);

	// 5. registry contains adapter
	const inRegistry = RUNTIME_ADAPTERS.find((a) => String(a.id) === "claude-sdk");
	check("registry:contains-claude-sdk", inRegistry !== undefined, inRegistry ? "" : "not found");

	// 4. removed worker entry stays removed from dist
	console.log("[diag-claude-sdk] building dist/ ...");
	execFileSync("npm", ["run", "build"], { stdio: "inherit", cwd: projectRoot });
	check("worker:dist-omits-sdk-entry", !existsSync(workerJs), workerJs);

	if (failures.length > 0) {
		process.stderr.write(`[diag-claude-sdk] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-claude-sdk] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-claude-sdk] ERROR ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
