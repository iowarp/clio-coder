/**
 * Claude Agent SDK worker subprocess entry point (v0.1 stub).
 *
 * The SDK is an optional npm package (`@anthropic-ai/claude-agent-sdk`) that
 * Clio does NOT pin as a production dependency. At runtime this worker checks
 * for its availability via dynamic import. If the package is absent we emit a
 * structured `sdk_missing` NDJSON event and exit 2 so the orchestrator can
 * degrade gracefully to the CLI or native tier. The "real" path is stubbed
 * here; it will grow in a future phase to forward SDK hooks as NDJSON events.
 *
 * This module is intentionally isolated: it imports ONLY from
 * `src/worker/ndjson.js`. It must never import pi-mono or any src/domains
 * module. The `@anthropic-ai/...` dynamic import does not fall under the
 * pi-mono boundary rule.
 */

import { emitEvent } from "./ndjson.js";

async function main(): Promise<number> {
	let sdkAvailable = false;
	// Specifier is assembled at runtime so TypeScript does not resolve the
	// optional package at build time. The `@anthropic-ai/claude-agent-sdk`
	// package is a soft dependency — present only when the operator installs
	// it explicitly to unlock the gold telemetry tier.
	const specifier = ["@anthropic-ai/", "claude-agent-sdk"].join("");
	try {
		await import(specifier);
		sdkAvailable = true;
	} catch {
		// package absent; structured-event path handled below
	}

	emitEvent({ type: "agent_start", tier: "sdk" });

	if (!sdkAvailable) {
		emitEvent({
			type: "sdk_missing",
			message:
				"@anthropic-ai/claude-agent-sdk not installed — run `npm i @anthropic-ai/claude-agent-sdk` to enable the gold telemetry tier",
		});
		emitEvent({ type: "agent_end", messages: [], exitCode: 2 });
		return 2;
	}

	// Real SDK path lands in a future phase. For v0.1 the mere fact the package
	// is importable is enough to confirm the subprocess boundary works.
	emitEvent({ type: "agent_end", messages: [], exitCode: 0 });
	return 0;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[sdk-worker] fatal: ${msg}\n`);
		process.exit(2);
	},
);
