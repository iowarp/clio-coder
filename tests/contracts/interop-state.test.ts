import { ok, strictEqual } from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { interopStatePath, readInteropReport, writeInteropReport } from "../../src/domains/interop/state.js";
import type { InteropReport } from "../../src/domains/interop/types.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const REPORT: InteropReport = {
	version: 1,
	detectedAt: "2026-08-16T00:00:00.000Z",
	agents: [
		{
			kind: "codex",
			presence: "present",
			binary: "/usr/local/bin/codex",
			version: "0.9.1",
			skillCount: 3,
			projectArtifacts: 4,
			fingerprint: "sha256:abc",
			decision: "declined",
			decidedAt: "2026-08-16T00:00:00.000Z",
			decidedFingerprint: "sha256:abc",
		},
	],
};

describe("interop state file", () => {
	// Nested inside the describe, not at module top level: under
	// --experimental-test-isolation=none every file shares one root test
	// context, so a top-level beforeEach/afterEach runs around every test in
	// every file, not just this one's. Routed through isolateClioEnv() rather
	// than a hand-rolled save/mutate/restore of CLIO_CODER_HOME: that duplicate
	// of the same idiom was exactly what raced against interop-consent.test.ts's
	// own copy at full-suite scale (issue #84). isolateClioEnv() now serializes
	// every in-process env window process-wide, so this only closes the gap by
	// going through it instead of re-implementing it.
	let isolated: IsolatedClioEnv;

	beforeEach(async () => {
		isolated = await isolateClioEnv("clio-interop-state-");
	});

	afterEach(() => {
		isolated.restore();
	});

	it("round-trips a report through the state dir", () => {
		writeInteropReport(REPORT);
		ok(interopStatePath().endsWith("interop.json"));
		const read = readInteropReport();
		ok(read);
		strictEqual(read.agents.length, 1);
		strictEqual(read.agents[0]?.decision, "declined");
		strictEqual(read.agents[0]?.version, "0.9.1");
	});

	it("degrades to no report when the file is corrupt", () => {
		writeInteropReport(REPORT);
		writeFileSync(interopStatePath(), "{ not json", "utf8");
		strictEqual(readInteropReport(), null);
	});

	it("drops entries that do not parse instead of failing the whole read", () => {
		writeInteropReport(REPORT);
		const raw = JSON.parse(readFileSync(interopStatePath(), "utf8")) as Record<string, unknown>;
		raw.agents = [...(raw.agents as unknown[]), { kind: "not-an-agent", fingerprint: "x", presence: "present" }];
		writeFileSync(interopStatePath(), JSON.stringify(raw), "utf8");
		const read = readInteropReport();
		ok(read);
		strictEqual(read.agents.length, 1);
	});

	it("reports nothing when no file was ever written", () => {
		strictEqual(readInteropReport(), null);
	});
});
