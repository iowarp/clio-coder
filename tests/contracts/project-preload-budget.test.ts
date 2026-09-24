import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdoptionScanResult } from "../../src/domains/context/adoption.js";
import { buildBootstrapPrompt } from "../../src/domains/context/bootstrap-prompt.js";
import { renderProjectContextFragment } from "../../src/domains/context/clio-md.js";
import type { ProjectPromptContext } from "../../src/domains/context/contract.js";
import { selectProjectPreload } from "../../src/domains/prompts/preload.js";

// A handbook written to the 200-line guideline, with lines as dense as a real
// one (the repository's own handbook averages about 125 UTF-16 units per line).
const HANDBOOK_LINES = 200;
const handbook = [
	"# Project",
	"",
	...Array.from({ length: HANDBOOK_LINES - 3 }, (_, i) => `- Rule ${i}: ${"dense handbook guidance ".repeat(4)}`),
	"LAST RULE",
].join("\n");

function context(source: string): ProjectPromptContext {
	const path = "/repo/CLIO-CODER.md";
	const supportFragments = ["<project-type>typescript</project-type>", "<codewiki>available; use code_nav</codewiki>"];
	return {
		text: [...supportFragments, renderProjectContextFragment(source, path)].join("\n\n"),
		handbookSources: [{ path, source }],
		handbookFiles: [path],
		supportFragments,
		clioMd: null,
		warnings: [],
	};
}

const noAdoption: AdoptionScanResult = {
	cwd: "/repo",
	homeDir: "/home/user",
	includeGlobal: false,
	sources: [],
	rejected: [],
	importedRules: [],
	conflicts: [],
	sourceHash: "",
	sourceSnapshots: [],
};

describe("project handbook budget", () => {
	it("preloads a 200-line handbook in full, so a model that never calls read still sees every rule", () => {
		const selected = selectProjectPreload(context(handbook));
		strictEqual(selected.classification.mode, "full");
		strictEqual(selected.text.includes("LAST RULE"), true);
	});

	it("hands the bootstrap generator the whole existing handbook, not its first half", () => {
		const prompt = buildBootstrapPrompt({
			cwd: "/repo",
			projectType: "typescript",
			siblingFiles: [],
			adoption: noAdoption,
			existingClioMdText: handbook,
		});
		strictEqual(prompt.includes("LAST RULE"), true);
	});
});
