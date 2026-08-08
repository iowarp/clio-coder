import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { heuristicBootstrapOutput } from "../../src/domains/context/bootstrap.js";
import { buildBootstrapPrompt } from "../../src/domains/context/bootstrap-prompt.js";
import {
	type BootstrapGenerateInput,
	buildCodewiki,
	scanAgentConfigs,
	serializeClioMd,
} from "../../src/domains/context/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
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
 * be asserted against the repository's own CLIO.md. That file is generated
 * context, and commit b8fbd6ca deliberately emptied the committed copy, so the
 * assertion only passed when a local bootstrap happened to have rewritten the
 * working tree. It tested the freshness of an artifact, not a contract.
 *
 * The contract lives in the two generators that author handbooks: the
 * deterministic heuristic and the prompt handed to Scout. Whatever they teach
 * is what every generated CLIO.md will say, in this repository and every other.
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

	// A handbook checked into this repository is reviewed like source, so it
	// still must not carry retired tool names. An empty committed stub satisfies
	// this vacuously, which is the intended post-b8fbd6ca state.
	it("a committed CLIO.md never names a retired navigation tool", () => {
		const clioMd = readFileSync(join(repoRoot, "CLIO.md"), "utf8");

		for (const obsoleteTool of OBSOLETE_TOOLS) {
			strictEqual(clioMd.includes(obsoleteTool), false, `CLIO.md must not mention ${obsoleteTool}`);
		}
	});
});
