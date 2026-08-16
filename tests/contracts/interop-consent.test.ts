import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { readSettings, settingsPath, updateSettings } from "../../src/core/config.js";
import { initializeClioHome } from "../../src/core/init.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import {
	acceptInteropAgents,
	declineInteropAgents,
	interopProposals,
	renderProposalEntry,
} from "../../src/domains/interop/index.js";
import type { InteropReport } from "../../src/domains/interop/types.js";

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

function savedDocument(): Record<string, unknown> {
	return parseYaml(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>;
}

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

describe("interop consent", () => {
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

	it("never proposes an agent that is already configured", () => {
		acceptInteropAgents(["codex"], report("sha256:a"));
		strictEqual(interopProposals(report("sha256:a"), readSettings()).length, 0);
	});
});
