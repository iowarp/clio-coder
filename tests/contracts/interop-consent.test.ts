import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { readSettings, settingsPath, updateSettings } from "../../src/core/config.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { initializeClioHome } from "../../src/core/init.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { createInteropBundle } from "../../src/domains/interop/extension.js";
import {
	acceptInteropAgents,
	declineInteropAgents,
	interopProposals,
	readInteropReport,
	renderProposalEntry,
} from "../../src/domains/interop/index.js";
import type { InteropAgentRecord, InteropReport } from "../../src/domains/interop/types.js";

const scratchRoots: string[] = [];
let savedHome: string | undefined;

function report(fingerprint: string): InteropReport {
	return {
		version: 1,
		detectedAt: "2026-08-16T00:00:00.000Z",
		agents: [
			{
				kind: "codex",
				presence: "present",
				binary: "/usr/local/bin/codex",
				version: "0.9.1",
				adapter: "absent",
				skillCount: 0,
				projectArtifacts: 0,
				fingerprint,
			},
		],
	};
}

/** Two present, undecided ACP kinds, the shape one `configure --interop` pass reviews. */
function pair(): InteropReport {
	return {
		version: 1,
		detectedAt: "2026-08-16T00:00:00.000Z",
		agents: [
			...report("sha256:a").agents,
			{
				kind: "opencode",
				presence: "present",
				binary: "/usr/local/bin/opencode",
				version: "1.2.3",
				adapter: "present",
				skillCount: 0,
				projectArtifacts: 0,
				fingerprint: "sha256:b",
			},
		],
	};
}

function storedRecord(kind: string): InteropAgentRecord | undefined {
	return readInteropReport()?.agents.find((agent) => agent.kind === kind);
}

function savedDocument(): Record<string, unknown> {
	return parseYaml(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>;
}

describe("interop consent", () => {
	// Nested inside the describe, not at module top level: under
	// --experimental-test-isolation=none every file shares one root test
	// context, so a top-level beforeEach/afterEach runs around every test in
	// every file, not just this one's.
	beforeEach(() => {
		const root = mkdtempSync(join(tmpdir(), "clio-interop-consent-"));
		scratchRoots.push(root);
		savedHome = process.env.CLIO_CODER_HOME;
		process.env.CLIO_CODER_HOME = root;
		resetXdgCache();
		initializeClioHome();
	});

	afterEach(() => {
		if (savedHome === undefined) delete process.env.CLIO_CODER_HOME;
		else process.env.CLIO_CODER_HOME = savedHome;
		resetXdgCache();
		for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("appends exactly one entry with clio-policy governance and no projectContext key", () => {
		const result = acceptInteropAgents(["codex"], report("sha256:a"));

		strictEqual(result.wired.length, 1);
		strictEqual(result.wired[0], "codex");
		const agents = readSettings().delegation.agents;
		strictEqual(agents.length, 1);
		strictEqual(agents[0]?.toolGovernance, "clio-policy");
		const written = (savedDocument().delegation as { agents: Array<Record<string, unknown>> }).agents;
		strictEqual(written.length, 1);
		strictEqual("projectContext" in (written[0] as object), false);
		strictEqual(written[0]?.command, "npx");
	});

	it("previews the entry that lands", () => {
		const proposals = interopProposals(report("sha256:a"), readSettings());
		const preview = renderProposalEntry(proposals[0] as (typeof proposals)[number]);
		acceptInteropAgents(["codex"], report("sha256:a"));
		const written = (savedDocument().delegation as { agents: unknown[] }).agents;
		strictEqual(preview.includes("id: codex"), true);
		strictEqual(preview.includes("toolGovernance: clio-policy"), true);
		strictEqual(JSON.stringify(parseYaml(preview)), JSON.stringify(written));
	});

	it("suppresses a declined agent until its facts change", () => {
		const before = readFileSync(settingsPath(), "utf8");
		declineInteropAgents(["codex"], report("sha256:a"));

		strictEqual(readFileSync(settingsPath(), "utf8"), before, "declining wrote to settings.yaml");
		const declined: InteropReport = {
			...report("sha256:a"),
			agents: report("sha256:a").agents.map((agent) => ({
				...agent,
				decision: "declined" as const,
				decidedFingerprint: "sha256:a",
			})),
		};
		strictEqual(interopProposals(declined, readSettings()).length, 0);

		const moved: InteropReport = {
			...declined,
			agents: declined.agents.map((agent) => ({ ...agent, fingerprint: "sha256:b" })),
		};
		strictEqual(interopProposals(moved, readSettings()).length, 1, "changed facts are a fresh proposal");
	});

	it("keeps an entry another writer added while the proposal was open", () => {
		const pending = report("sha256:a");
		updateSettings((settings) => {
			settings.delegation.agents.push({ id: "hand-written", command: "opencode", args: ["acp"] });
		});

		acceptInteropAgents(["codex"], pending);

		const ids = readSettings().delegation.agents.map((agent) => agent.id);
		strictEqual(ids.length, 2);
		ok(ids.includes("hand-written"));
		ok(ids.includes("codex"));
	});

	/**
	 * Answering n for one agent and y for another in a single `configure --interop`
	 * pass recorded the decline and lost the accept: both calls carry the same
	 * report, whose in-memory copy of the accepted record still had no decision,
	 * and the merge let it overwrite what had just been written.
	 */
	it("keeps every decision taken in one review, whatever order they are recorded in", () => {
		const pending = pair();

		acceptInteropAgents(["opencode"], pending);
		declineInteropAgents(["codex"], pending);

		const opencode = storedRecord("opencode");
		strictEqual(opencode?.decision, "accepted");
		strictEqual(opencode.decidedFingerprint, "sha256:b");
		ok(opencode.decidedAt, "an accepted agent records when it was decided");
		strictEqual(storedRecord("codex")?.decision, "declined");
		strictEqual(interopProposals(readInteropReport() as InteropReport, readSettings()).length, 0);
	});

	it("keeps a decline taken before an accept in the same review", () => {
		const pending = pair();

		declineInteropAgents(["codex"], pending);
		acceptInteropAgents(["opencode"], pending);

		strictEqual(storedRecord("codex")?.decision, "declined");
		strictEqual(storedRecord("opencode")?.decision, "accepted");
	});

	it("shows the decision in the report the overlay rebuilds from", async () => {
		const home = mkdtempSync(join(tmpdir(), "clio-interop-home-"));
		scratchRoots.push(home);
		mkdirSync(join(home, ".codex"), { recursive: true });
		const bundle = createInteropBundle({} as unknown as DomainContext);
		await bundle.contract.detect({ cwd: home, home });

		bundle.contract.decline(["codex"]);

		const shown = bundle.contract.lastReport()?.agents.find((agent) => agent.kind === "codex");
		strictEqual(shown?.decision, "declined", "the keystroke's decision must be visible without a new detection");
	});

	it("never proposes an agent that is already configured", () => {
		acceptInteropAgents(["codex"], report("sha256:a"));
		strictEqual(interopProposals(report("sha256:a"), readSettings()).length, 0);
	});
});
