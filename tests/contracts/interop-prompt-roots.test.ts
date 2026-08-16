import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { expandPromptTemplateInput, loadPromptTemplates } from "../../src/domains/resources/prompts/loader.js";

const scratchRoots: string[] = [];

function scratchDir(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-prompt-roots-"));
	scratchRoots.push(root);
	return root;
}

function writePrompt(root: string, relative: string, body: string): void {
	const file = join(root, relative);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, body, "utf8");
}

afterEach(() => {
	for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("contracts/foreign prompt roots", () => {
	it("lists a project .claude/commands template as untrusted and refuses to expand it", () => {
		const cwd = scratchDir();
		writePrompt(cwd, join(".claude", "commands", "demo.md"), "---\ndescription: demo\n---\n\nRun the demo.\n");

		const list = loadPromptTemplates({ cwd, home: scratchDir() });
		const demo = list.items.find((item) => item.name === "demo");
		ok(demo, "the project compatibility root was not read");
		strictEqual(demo.trusted, false);

		const expansion = expandPromptTemplateInput("/demo", list);
		strictEqual(expansion.expanded, false, "an untrusted template must not substitute into the message");
		ok(
			expansion.diagnostics.some((diagnostic) => diagnostic.message.includes("untrusted project root")),
			"the refusal says why",
		);
		// Named separately from the diagnostics list because every caller that would
		// otherwise pass the text through has to tell this apart from "not a
		// template": the TUI turns it into an error notice, the headless run exits
		// on it, and neither sends the literal /demo to the model.
		if (expansion.expanded) throw new Error("expected a refusal");
		strictEqual(expansion.refusal?.template.name, "demo");
		ok(expansion.refusal?.message.includes("skills.trustProjectCompatRoots"), expansion.refusal?.message);
	});

	it("carries no refusal when the token names no template at all", () => {
		const list = loadPromptTemplates({ cwd: scratchDir(), home: scratchDir() });
		const expansion = expandPromptTemplateInput("/absent", list);

		strictEqual(expansion.expanded, false);
		if (expansion.expanded) throw new Error("expected no expansion");
		strictEqual(expansion.refusal, undefined, "an unknown token is not a template that refused");
	});

	it("expands the same template once the trust opt-in is set", () => {
		const cwd = scratchDir();
		writePrompt(cwd, join(".claude", "commands", "demo.md"), "Run the demo.\n");

		const list = loadPromptTemplates({ cwd, home: scratchDir(), trustProjectCompatRoots: true });
		const expansion = expandPromptTemplateInput("/demo", list);
		strictEqual(expansion.expanded, true);
	});

	it("trusts user-scope foreign prompts the way user-scope foreign skills are trusted", () => {
		const home = scratchDir();
		writePrompt(home, join(".codex", "prompts", "review.md"), "Review it.\n");

		const list = loadPromptTemplates({ cwd: scratchDir(), home });
		const review = list.items.find((item) => item.name === "review");
		ok(review);
		strictEqual(review.trusted, true);
		strictEqual(expandPromptTemplateInput("/review", list).expanded, true);
	});

	it("ranks a Clio project template over a foreign project template of the same name", () => {
		const cwd = scratchDir();
		writePrompt(cwd, join(".claude", "commands", "dup.md"), "foreign\n");
		writePrompt(cwd, join(".clio-coder", "prompts", "dup.md"), "clio\n");

		const list = loadPromptTemplates({ cwd, home: scratchDir(), trustProjectCompatRoots: true });
		const dup = list.items.find((item) => item.name === "dup");
		ok(dup);
		strictEqual(dup.content, "clio");
	});
});
