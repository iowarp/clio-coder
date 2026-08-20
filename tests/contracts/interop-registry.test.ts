import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { scanAgentConfigs } from "../../src/domains/context/adoption.js";
import type { InteropReport } from "../../src/domains/interop/index.js";
import { detectInteropAgents, INTEROP_AGENT_KINDS, writeInteropReport } from "../../src/domains/interop/index.js";
import { defaultSkillRoots } from "../../src/domains/resources/skills/loader.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const ADOPTION_PROVIDERS = ["claude-code", "agents", "codex", "gemini", "cursor", "copilot", "opencode"] as const;
const FOREIGN_SKILL_SOURCES = ["agents", "claude", "codex", "copilot", "opencode"] as const;

const scratchRoots: string[] = [];

function scratchDir(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-interop-"));
	scratchRoots.push(root);
	return root;
}

// Wrapped in its own describe so the top-level beforeEach/afterEach below
// scope to this file's suites, not the whole process, under
// --experimental-test-isolation=none (every file shares one root test
// context there, so an unscoped top-level hook runs around every test in
// every file).
describe("contracts/interop-registry", () => {
	afterEach(() => {
		for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	describe("interop registry", () => {
		it("maps every adoption provider to exactly one kind", () => {
			for (const provider of ADOPTION_PROVIDERS) {
				const owners = INTEROP_AGENT_KINDS.filter((kind) => kind.adoptionProvider === provider);
				strictEqual(owners.length, 1, `${provider} has ${owners.length} owning kinds`);
			}
		});

		it("maps every foreign skill source to exactly one kind", () => {
			for (const source of FOREIGN_SKILL_SOURCES) {
				const owners = INTEROP_AGENT_KINDS.filter((kind) => kind.skillSource === source);
				strictEqual(owners.length, 1, `${source} has ${owners.length} owning kinds`);
			}
		});

		it("names every foreign skill root the loader builds", () => {
			const home = scratchDir();
			const cwd = scratchDir();
			const loaderRoots = new Set(
				defaultSkillRoots({ cwd, home, disableDiscovery: false })
					.filter((root) => root.source !== undefined && FOREIGN_SKILL_SOURCES.includes(root.source as never))
					.map((root) => root.path),
			);
			const registryRoots = new Set(
				INTEROP_AGENT_KINDS.flatMap((kind) => [
					...(kind.userSkillRoot === undefined ? [] : [join(home, kind.userSkillRoot)]),
					...(kind.projectSkillRoot === undefined ? [] : [join(cwd, kind.projectSkillRoot)]),
				]),
			);
			deepStrictEqual([...loaderRoots].sort(), [...registryRoots].sort());
		});

		it("names every project instruction file adoption reads as an agent's own", () => {
			const cwd = scratchDir();
			for (const kind of INTEROP_AGENT_KINDS) {
				for (const file of kind.instructionFiles) {
					const target = join(cwd, file);
					mkdirSync(join(target, ".."), { recursive: true });
					writeFileSync(target, "# rules\n\nAlways run the tests before you finish.\n", "utf8");
				}
			}
			const scan = scanAgentConfigs({ cwd, homeDir: scratchDir() });
			for (const kind of INTEROP_AGENT_KINDS) {
				for (const file of kind.instructionFiles) {
					const source = scan.sources.find((entry) => entry.path === join(cwd, file));
					ok(source, `adoption did not read ${file}`);
					strictEqual(source.provider, kind.adoptionProvider, `${file} belongs to a different provider`);
				}
			}
		});

		it("declares a binary name for every runtime descriptor that drives a foreign CLI", () => {
			const declared = new Set(INTEROP_AGENT_KINDS.flatMap((kind) => kind.binaryNames));
			for (const binary of ["claude", "agy"]) ok(declared.has(binary), `no kind claims ${binary}`);
		});
	});

	describe("interop detection", () => {
		// Every test here calls detectInteropAgents with no `previous`, which falls
		// back to readInteropReport() for prior decisions. Without isolation that
		// reads the operator's real interop.json, so a machine with a recorded
		// report leaks its decisions and versions into what should be a clean
		// detection. isolateClioEnv() points CLIO_CODER_STATE_DIR at a scratch dir
		// per test, the same idiom interop-state.test.ts and interop-consent.test.ts
		// use, so readInteropReport() sees only what a test writes there itself.
		let isolated: IsolatedClioEnv;

		beforeEach(async () => {
			isolated = await isolateClioEnv("clio-interop-detect-");
		});

		afterEach(() => {
			isolated.restore();
		});

		it("performs no subprocess and reports absent agents as absent", async () => {
			const home = scratchDir();
			const report = await detectInteropAgents({ cwd: scratchDir(), home, probeVersion: false });
			for (const agent of report.agents) {
				strictEqual(agent.version, undefined, `${agent.kind} reported a version without probing`);
			}
			strictEqual(
				report.agents.some((agent) => agent.presence === "absent" && agent.installDir === undefined),
				false,
				"an agent with no signal at all should not be listed",
			);
		});

		it("reports unknown rather than absent when PATH cannot answer", async () => {
			const saved = process.env.PATH;
			delete process.env.PATH;
			try {
				const home = scratchDir();
				mkdirSync(join(home, ".codex"), { recursive: true });
				const report = await detectInteropAgents({ cwd: scratchDir(), home });
				const codex = report.agents.find((agent) => agent.kind === "codex");
				ok(codex, "the install dir alone should list codex");
				strictEqual(codex.presence, "unknown");
			} finally {
				if (saved !== undefined) process.env.PATH = saved;
			}
		});

		it("kills a hung --version at the probe timeout and reports no version", async () => {
			const home = scratchDir();
			const bin = scratchDir();
			writeFileSync(join(bin, "codex"), "#!/bin/sh\nsleep 30\n", { encoding: "utf8", mode: 0o755 });
			const saved = process.env.PATH;
			process.env.PATH = bin;
			try {
				const started = Date.now();
				const report = await detectInteropAgents({ cwd: scratchDir(), home, probeVersion: true });
				const codex = report.agents.find((agent) => agent.kind === "codex");
				ok(codex, "codex resolved on PATH");
				strictEqual(codex.presence, "present");
				strictEqual(codex.version, undefined);
				ok(Date.now() - started < 15_000, "the probe did not wait for the hung child");
			} finally {
				if (saved !== undefined) process.env.PATH = saved;
			}
		});

		it("keeps a declined decision keyed to the facts it was made against", async () => {
			const home = scratchDir();
			const bin = scratchDir();
			writeFileSync(join(bin, "codex"), "#!/bin/sh\necho 0.9.1\n", { encoding: "utf8", mode: 0o755 });
			const saved = process.env.PATH;
			process.env.PATH = bin;
			try {
				const first = await detectInteropAgents({ cwd: scratchDir(), home, probeVersion: true });
				const codex = first.agents.find((agent) => agent.kind === "codex");
				ok(codex);
				const declined = [{ ...codex, decision: "declined" as const, decidedFingerprint: codex.fingerprint }];
				const second = await detectInteropAgents({ cwd: scratchDir(), home, probeVersion: true }, declined);
				const again = second.agents.find((agent) => agent.kind === "codex");
				ok(again);
				strictEqual(again.fingerprint, codex.fingerprint, "unchanged facts keep the fingerprint");
				strictEqual(again.decidedFingerprint, codex.fingerprint);

				writeFileSync(join(bin, "codex"), "#!/bin/sh\necho 0.9.2\n", { encoding: "utf8", mode: 0o755 });
				const third = await detectInteropAgents({ cwd: scratchDir(), home, probeVersion: true }, declined);
				const bumped = third.agents.find((agent) => agent.kind === "codex");
				ok(bumped);
				ok(bumped.fingerprint !== codex.fingerprint, "a version bump is a fresh proposal");
			} finally {
				if (saved !== undefined) process.env.PATH = saved;
			}
		});

		it("falls back to the recorded report when the caller passes no previous", async () => {
			const home = scratchDir();
			const bin = scratchDir();
			writeFileSync(join(bin, "codex"), "#!/bin/sh\necho 0.9.1\n", { encoding: "utf8", mode: 0o755 });
			const saved = process.env.PATH;
			process.env.PATH = bin;
			try {
				const first = await detectInteropAgents({ cwd: scratchDir(), home, probeVersion: true });
				const codex = first.agents.find((agent) => agent.kind === "codex");
				ok(codex);
				const recorded: InteropReport = {
					version: 1,
					detectedAt: "2026-08-16T00:00:00.000Z",
					agents: [{ ...codex, decision: "declined", decidedFingerprint: codex.fingerprint }],
				};
				writeInteropReport(recorded);

				const second = await detectInteropAgents({ cwd: scratchDir(), home, probeVersion: false });
				const again = second.agents.find((agent) => agent.kind === "codex");
				ok(again, "the recorded report's kind is still detected by the live PATH scan");
				strictEqual(again.decision, "declined", "the recorded decision surfaces with no previous argument");
				strictEqual(
					again.version,
					"0.9.1",
					"the recorded version carries over for an unprobed run against the same binary",
				);
			} finally {
				if (saved !== undefined) process.env.PATH = saved;
			}
		});
	});
});
