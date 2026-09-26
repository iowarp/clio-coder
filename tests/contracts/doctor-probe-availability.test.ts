import { match, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { deepToolProbeFindings } from "../../src/cli/doctor-deep.js";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/contract.js";
import codex from "../../src/domains/providers/runtimes/cloud/openai-codex.js";

it("doctor distinguishes a runtime without a live probe from a failed health probe", async () => {
	const base = {
		target: { id: "openai-codex", runtime: "openai-codex" },
		runtime: codex,
		available: true,
		reason: "store:oauth:openai-codex",
		health: { lastError: null },
	} as TargetStatus;
	const providers = { probeAllLive: async () => {}, list: () => [base] } as unknown as ProvidersContract;
	let rows = await deepToolProbeFindings(providers);
	strictEqual(rows[0]?.level, "info");
	match(rows[0]?.detail ?? "", /no live probe.*store:oauth:openai-codex/);
	base.available = false;
	base.reason = "missing auth (openai-codex)";
	rows = await deepToolProbeFindings(providers);
	strictEqual(rows[0]?.level, "warn");
	match(rows[0]?.detail ?? "", /missing auth/);
	base.available = true;
	base.health.lastError = "connection refused";
	rows = await deepToolProbeFindings(providers);
	strictEqual(rows[0]?.level, "warn");
	match(rows[0]?.detail ?? "", /connection refused/);
});
