import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { heuristicBootstrapOutput } from "../../src/domains/context/bootstrap.js";
import { buildBootstrapPrompt } from "../../src/domains/context/bootstrap-prompt.js";
import {
	type BootstrapGenerateInput,
	buildCodewiki,
	scanAgentConfigs,
	serializeClioMd,
} from "../../src/domains/context/index.js";

const OBSOLETE_TOOLS = ["entry_points", "where_is", "find_symbol"] as const;

const scratchRoots: string[] = [];

afterEach(() => {
	for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function generatorInput(): Promise<BootstrapGenerateInput> {
	const cwd = mkdtempSync(join(tmpdir(), "clio-md-hygiene-"));
	scratchRoots.push(cwd);
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "hygiene-fixture", type: "module" }), "utf8");
	writeFileSync(join(cwd, "index.ts"), "export const hygieneFixture = true;\n", "utf8");
	return {
		cwd,
		projectType: "typescript",
		siblingFiles: [],
		adoption: scanAgentConfigs({ cwd }),
		codewiki: await buildCodewiki({ cwd, language: "typescript", generatedAt: "2026-08-07T00:00:00.000Z" }),
	};
}

/**
 * The navigation vocabulary Clio teaches has to stay current, but this used to
 * be asserted against the repository's own CLIO-CODER.md. That file is generated
 * context, and commit b8fbd6ca deliberately emptied the committed copy, so the
 * assertion only passed when a local bootstrap happened to have rewritten the
 * working tree. It tested the freshness of an artifact, not a contract.
 *
 * The contract lives in the two generators that author handbooks: the
 * deterministic heuristic and the prompt handed to Scout. Whatever they teach
 * is what every generated CLIO-CODER.md will say, in this repository and every other.
 */
describe("contracts/clio-md hygiene", () => {
	it("the heuristic handbook teaches code_nav and no obsolete navigation tools", async () => {
		const output = await heuristicBootstrapOutput(await generatorInput());
		const handbook = serializeClioMd({
			projectName: output.projectName,
			identity: output.identity,
			conventions: output.conventions,
			invariants: output.invariants,
			...(output.sections ? { sections: output.sections } : {}),
			fingerprint: {
				initAt: "2026-08-07T00:00:00.000Z",
				model: "heuristic",
				gitHead: null,
				treeHash: "0".repeat(64),
				loc: 1,
			},
		});

		ok(handbook.includes("code_nav"), handbook);
		for (const obsoleteTool of OBSOLETE_TOOLS) {
			strictEqual(handbook.includes(obsoleteTool), false, `heuristic handbook must not mention ${obsoleteTool}`);
		}
	});

	it("the Scout bootstrap prompt teaches code_nav and no obsolete navigation tools", async () => {
		const prompt = buildBootstrapPrompt(await generatorInput());

		ok(prompt.includes("code_nav"), prompt);
		for (const obsoleteTool of OBSOLETE_TOOLS) {
			strictEqual(prompt.includes(obsoleteTool), false, `Scout prompt must not mention ${obsoleteTool}`);
		}
	});

	/**
	 * The prompt and the grounding filter are two halves of one contract, and when
	 * they disagree the disagreement is silent: Scout answers in good faith, every
	 * line is deleted after the fact, and the run reports a heuristic handbook with
	 * no indication that the instructions were the problem. The prompt asked for
	 * verbatim extraction from sibling files while the filter now asks for cited
	 * description, so the prompt has to state the rule it will be judged by.
	 */
	it("the Scout bootstrap prompt states the citation rule the grounding filter enforces", async () => {
		const prompt = buildBootstrapPrompt(await generatorInput());

		ok(prompt.includes("backticked token"), "the prompt must name the token requirement the filter applies");
		ok(/cites nothing is deleted/i.test(prompt), "the prompt must say an uncited line is dropped");
		strictEqual(
			/verbatim|copied from siblingFiles|extractive/i.test(prompt),
			false,
			"the prompt must not still ask for verbatim extraction",
		);
	});

	/**
	 * The section titles the prompt requests are the ones the handbook is worth
	 * having for: control flow, invariants that break silently, and the file sets a
	 * change has to touch together. A handbook without them is a file listing.
	 */
	it("the Scout bootstrap prompt asks for behavior-changing sections", async () => {
		const prompt = buildBootstrapPrompt(await generatorInput());

		for (const section of ["Architecture", "Gotchas", "Extending"]) {
			ok(prompt.includes(`"${section}"`), `Scout prompt must request a ${section} section`);
		}
	});
});
