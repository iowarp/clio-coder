import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { compile } from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { reportFingerprint } from "../../src/domains/report/fingerprint.js";
import { readOutbox, readReportDraft } from "../../src/domains/report/index.js";
import { recordAnswer } from "../../src/domains/report/offers.js";
import type { LocalIdentity } from "../../src/domains/report/scrub.js";
import type { AskUserHandler } from "../../src/tools/ask-user.js";
import { CLIO_REPORT_NUDGE, clioIssueNudge } from "../../src/tools/bash.js";
import { createReportTool, REPORT_OFFER_REFUSED, type ReportToolDeps } from "../../src/tools/report.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const IDENTITY = async (): Promise<LocalIdentity> => ({
	packageRoot: null,
	paths: ["/home/alice/work"],
	remotes: [],
	names: [],
});

function deps(stateDir: string, overrides: Partial<ReportToolDeps> = {}): ReportToolDeps {
	return {
		stateDir,
		version: "0.7.1",
		surface: "headless",
		session: () => ({ id: "s-1", cwd: "/home/alice/work" }),
		offers: () => "ask",
		writeOffersOff: () => {},
		attended: () => false,
		openReview: () => null,
		identity: IDENTITY,
		...overrides,
	};
}

const DRAFT = {
	action: "draft",
	kind: "bug",
	title: "compaction loops",
	happened: "Compaction ran three times in /home/alice/work and the turn stalled.",
	operator_words: "it keeps compacting",
	not_known: ["whether the provider was slow"],
};

describe("report tool", () => {
	it("saves a scrubbed agent draft, never sends it, and writes one per session", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "report-tool-"));
		const tool = createReportTool(deps(stateDir));
		const first = await tool.run(DRAFT, {});
		strictEqual(first.kind, "ok");
		const id = (first.details as { draftId: string }).draftId;
		ok(first.kind === "ok" && !first.output.includes("report send"), first.kind === "ok" ? first.output : "");
		const draft = readReportDraft(stateDir, id);
		strictEqual(draft?.origin, "agent");
		strictEqual(draft?.trigger, "agent");
		strictEqual(draft?.fingerprint, null);
		ok(!draft?.sections.happened.includes("/home/alice"), draft?.sections.happened);
		deepStrictEqual(draft?.sections.notKnown, ["whether the provider was slow"]);
		strictEqual(readOutbox(stateDir)[id]?.state, "draft");

		const again = await tool.run(DRAFT, {});
		strictEqual((again.details as { created: boolean } | undefined)?.created, false);
		strictEqual(Object.keys(readOutbox(stateDir)).length, 1);
	});

	it("raises a notice for the operator and opens nothing", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "report-tool-"));
		const noticed: string[] = [];
		const tool = createReportTool(
			deps(stateDir, { surface: "tui", attended: () => true, openReview: () => (id) => noticed.push(id) }),
		);
		const result = await tool.run(DRAFT, {});
		ok(result.kind === "ok" && result.output.includes("for the operator to review"));
		strictEqual(noticed.length, 1);
	});

	it("refuses an offer the host budget forbids without asking, and records a no", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "report-tool-"));
		let asked = 0;
		const askUser: AskUserHandler = async () => {
			asked++;
			return { cancelled: false, answers: [{ question: "q", options: ["Not now"] }] } as never;
		};
		const offer = { action: "offer", kind: "bug", title: "compaction loops", happened: "", not_known: [] };
		const away = createReportTool(deps(stateDir, { askUser, attended: () => false }));
		strictEqual((await away.run(offer, {})).kind === "ok" && asked, 0);

		const tool = createReportTool(deps(stateDir, { askUser, attended: () => true }));
		const result = await tool.run(offer, {});
		strictEqual(result.kind === "ok" ? result.output : "", REPORT_OFFER_REFUSED);
		strictEqual(asked, 1);
		const again = createReportTool(deps(stateDir, { askUser, attended: () => true, session: () => ({ id: "s-2" }) }));
		strictEqual((await again.run(offer, {})).kind === "ok" ? asked : -1, 1);

		const declinedDir = mkdtempSync(join(tmpdir(), "report-tool-"));
		const fingerprint = reportFingerprint({ trigger: "agent", cause: "compaction loops", version: "0.7.1" });
		recordAnswer(declinedDir, fingerprint, "declined", { now: new Date(0) });
		const declined = createReportTool(deps(declinedDir, { askUser, attended: () => true }));
		strictEqual((await declined.run(offer, {})).kind === "ok" ? asked : -1, 1);
	});
});

describe("report guidance in the prompt", () => {
	let env: IsolatedClioEnv;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-report-guidance-");
	});
	afterEach(() => env.restore());

	const prompt = (headless: boolean, capabilities: string[]) =>
		compile(loadFragments(), {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.default",
			sessionInputs: {
				provider: "local",
				model: "stable-model",
				contextWindow: 32_768,
				providerSupportsTools: true,
				headless,
				coordinatorCapabilities: capabilities,
				toolNames: [ToolNames.Gateway],
			},
		}).systemPrompt;

	it("renders only for an attended session that registered report", () => {
		const marker = "Reporting Clio Coder's own problems";
		ok(prompt(false, [ToolNames.Report]).includes(marker));
		ok(!prompt(false, [ToolNames.ClioDocs]).includes(marker));
		ok(!prompt(true, [ToolNames.Report]).includes(marker));
		ok(prompt(true, [ToolNames.Report]).includes('`report` action "draft"'));
	});
});

describe("gh bypass nudge", () => {
	it("notes /report on a gh issue against Clio Coder and stays quiet elsewhere", () => {
		ok(clioIssueNudge("gh issue create --repo iowarp/clio-coder --title x").includes(CLIO_REPORT_NUDGE));
		ok(clioIssueNudge("gh api repos/iowarp/clio-coder/issues -f title=x").includes(CLIO_REPORT_NUDGE));
		strictEqual(clioIssueNudge("gh issue create --repo octo/api --title x"), "");
		strictEqual(clioIssueNudge("gh issue list --repo iowarp/clio-coder"), "");
	});
});
