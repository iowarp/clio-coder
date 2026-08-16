import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetXdgCache } from "../../src/core/xdg.js";
import { interopStatePath, readInteropReport, writeInteropReport } from "../../src/domains/interop/state.js";
import type { InteropReport } from "../../src/domains/interop/types.js";

const scratchRoots: string[] = [];
let savedHome: string | undefined;

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

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "clio-interop-state-"));
	scratchRoots.push(root);
	savedHome = process.env.CLIO_CODER_HOME;
	process.env.CLIO_CODER_HOME = root;
	mkdirSync(root, { recursive: true });
	resetXdgCache();
});

afterEach(() => {
	if (savedHome === undefined) delete process.env.CLIO_CODER_HOME;
	else process.env.CLIO_CODER_HOME = savedHome;
	resetXdgCache();
	for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("interop state file", () => {
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
