import { deepStrictEqual, rejects, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { runBootstrap } from "../../src/domains/context/bootstrap.js";
import { parseBootstrapModelOutput } from "../../src/domains/context/bootstrap-prompt.js";
import { loadProjectClioMd, parseClioMd, serializeClioMd, tryReadClioMd } from "../../src/domains/context/clio-md.js";
import { createContextBundle } from "../../src/domains/context/extension.js";
import { renderPromptContext } from "../../src/domains/context/prompt-context.js";
import { runContextRefresh } from "../../src/domains/context/refresh.js";
import { readClioState, writeClioState } from "../../src/domains/context/state.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";
import { selectProjectPreload } from "../../src/domains/prompts/preload.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const staleNavigation = "OLD_INDEX_ENTRY";
const footer = `<!-- clio:fingerprint v1
{"initAt":"2026-09-01","model":"fixture","gitHead":null,"treeHash":"${"a".repeat(64)}","loc":1}
-->`;
const authored = `# Authored handbook

The first identity paragraph.

Second paragraph: preserve the calibration file before starting.

## Conventions

Conventions also include prose, not only bullets.

- Run the documented validation command:
  - Keep the nested instruction.
  Preserve this continuation and its two trailing spaces.${"  "}

\`\`\`sh
printf '%s\\n' 'CALIBRATION_SENTINEL'
\`\`\`

## Hard invariants

1. Retain the original data.
   This continuation qualifies the rule.

Prose after the numbered rule remains authoritative.

## Examples

~~~markdown
## Context retrieval
This is an example, not the index-owned section.
~~~

<!--
## Context retrieval
This is an authored comment.
-->

## Context retrieval${"   "}

${staleNavigation}

## Custom guidance

### Rare constraint

Preserve café and 🧪 exactly.

${footer}

Guidance after the legacy footer must survive too.${"  "}
`;

describe("authored handbook fidelity", { concurrency: false }, () => {
	let isolated: IsolatedClioEnv;
	let cwd: string;
	let path: string;

	beforeEach(async () => {
		isolated = await isolateClioEnv("clio-coder-handbook-fidelity-");
		cwd = isolated.dir;
		path = join(cwd, "CLIO-CODER.md");
		mkdirSync(join(cwd, "src"));
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "handbook-fixture", type: "module" }));
		writeFileSync(join(cwd, "src", "index.ts"), "export const calibration = true;\n");
	});

	afterEach(() => isolated.restore());

	for (const [name, source, projection] of [
		["headingless prose", "Run npm test before editing calibration.\n\nPreserve café and 🧪.\n", null],
		[
			"arbitrary titles without identity",
			"# Working agreements\n\n## Commands\n\nRun npm test.\n\n# Local constraints\n\nPreserve measurements.\n",
			null,
		],
		[
			"H1 inside fenced code",
			"# Guide\n\nRepository guidance.\n\n```markdown\n# An example heading\n```\n",
			// A fenced heading is not a heading, so this document projects; the
			// projection reads the real structure and invents nothing.
			{ projectName: "Guide", identity: "Repository guidance.", conventions: [], invariants: [], sections: [] },
		],
		[
			"malformed optional footer",
			"# Guide\n\nKeep this instruction.\n\n<!-- clio:fingerprint v1\n{bad json}\n-->\n",
			null,
		],
	] as const) {
		it(`loads ${name} verbatim through context state and the session compiler`, async () => {
			writeFileSync(path, source);
			const context = createContextBundle({ bus: createSafeEventBus(), getContract: () => undefined });
			strictEqual(context.contract.contextState(cwd).clioMd, "ok");
			const prompt = renderPromptContext(cwd);
			deepStrictEqual(prompt.handbookFiles, [path]);
			deepStrictEqual(prompt.warnings, []);
			if (projection === null) {
				strictEqual(prompt.clioMd, null, "authored text needs no invented structured metadata");
			} else {
				const { projectName, identity, conventions, invariants, sections } = prompt.clioMd ?? {};
				deepStrictEqual({ projectName, identity, conventions, invariants, sections }, projection);
			}
			strictEqual(prompt.text.includes(source), true);
			const bundle = createPromptsBundle({
				bus: createSafeEventBus(),
				getContract(name) {
					return name === "context" ? (context.contract as never) : undefined;
				},
			});
			await bundle.extension.start();
			try {
				const compiled = await bundle.contract.compileSessionPrompt({
					sessionId: `authored-${name}`,
					cwd,
					sessionInputs: { providerSupportsTools: true },
				});
				strictEqual(compiled.projectPreload?.mode, "full", "fixture must fit the unchanged preload budget");
				deepStrictEqual(compiled.projectHandbookFiles, [path]);
				strictEqual(compiled.systemPrompt.includes(source), true);
			} finally {
				await bundle.extension.stop?.();
			}
		});

		it(`preserves ${name} during plain init and generated exploration`, async () => {
			writeFileSync(path, source);
			const initialized = await runBootstrap({ cwd });
			strictEqual(initialized.summary.action, "preserved");
			strictEqual(initialized.preload.mode, "full");
			deepStrictEqual(readFileSync(path), Buffer.from(source));
			let calls = 0;
			const generated = await runBootstrap({
				cwd,
				generate: async (input) => {
					calls += 1;
					strictEqual(input.existingClioMdText, source);
					return { projectName: "Fixture", identity: "A generated proposal.", conventions: [], invariants: [] };
				},
			});
			strictEqual(calls, 1);
			strictEqual(generated.summary.action, "proposed");
			deepStrictEqual(readFileSync(path), Buffer.from(source));
		});
	}

	it("retains bounded authored guidance through the production compiler for every tool capability", async () => {
		const source =
			"EARLY_AUTHORED_SENTINEL: preserve calibration.\n\n" +
			"A later guidance paragraph.\n\n".repeat(450) +
			"OMITTED_TAIL_SENTINEL\n";
		writeFileSync(path, source);
		const context = createContextBundle({ bus: createSafeEventBus(), getContract: () => undefined });
		const bundle = createPromptsBundle({
			bus: createSafeEventBus(),
			getContract(name) {
				return name === "context" ? (context.contract as never) : undefined;
			},
		});
		await bundle.extension.start();
		try {
			for (const providerSupportsTools of [true, false, null]) {
				const compiled = await bundle.contract.compileSessionPrompt({
					sessionId: `bounded-${providerSupportsTools}`,
					cwd,
					sessionInputs: { providerSupportsTools },
				});
				strictEqual(compiled.systemPrompt.includes("EARLY_AUTHORED_SENTINEL"), true);
				strictEqual(compiled.systemPrompt.includes("OMITTED_TAIL_SENTINEL"), false);
				strictEqual(compiled.projectPreload?.mode, "partial");
				strictEqual(compiled.systemPrompt.includes(JSON.stringify(path)), true);
				const selected = selectProjectPreload(renderPromptContext(cwd), providerSupportsTools);
				deepStrictEqual(compiled.projectPreload, selected.classification);
				strictEqual(compiled.systemPrompt.includes(selected.text), true);
				writeFileSync(path, "Changed on disk.\n");
				const cached = await bundle.contract.compileSessionPrompt({
					sessionId: `bounded-${providerSupportsTools}`,
					cwd,
					sessionInputs: { providerSupportsTools },
				});
				deepStrictEqual(cached.projectPreload, compiled.projectPreload);
				writeFileSync(path, source);
			}
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("preserves authored policy under generated-looking section titles during refresh", async () => {
		const source =
			"## Context retrieval\n\nRead the calibration ledger first.\n\n## Skills\n\nDo not install project skills.\n\n## Agent context interop\n\nFollow the reviewed guide.\n";
		writeFileSync(path, source);
		const refreshed = await runContextRefresh({ cwd });
		strictEqual(refreshed.codewikiEntries, 1);
		strictEqual(refreshed.clioMd, "unchanged");
		deepStrictEqual(readFileSync(path), Buffer.from(source));
		strictEqual(renderPromptContext(cwd).text.includes(source), true);
	});

	it("keeps empty and unreadable authored files unavailable without fabricating metadata", () => {
		writeFileSync(path, " \n\t");
		const loaded = loadProjectClioMd(cwd);
		deepStrictEqual(loaded.files, []);
		strictEqual(loaded.errors.length, 1);
		strictEqual(loaded.value, null);
		const nested = join(cwd, "src", "CLIO-CODER.md");
		mkdirSync(nested);
		strictEqual(tryReadClioMd(join(cwd, "src"))?.ok, false);
	});

	it("does not let structured adoption overwrite a guide without a structured projection", async () => {
		const source = "Preserve this headingless team instruction.\n";
		writeFileSync(path, source);
		const provenance = {
			version: 1 as const,
			fingerprint: { treeHash: "b".repeat(64), gitHead: null, loc: 1 },
			contextSourceHash: "c".repeat(64),
			contextSources: [],
			lastInitAt: "2026-09-01",
		};
		writeClioState(cwd, provenance);
		strictEqual(readClioState(cwd)?.contextSourceHash, provenance.contextSourceHash);
		await rejects(runBootstrap({ cwd, adopt: true }), /cannot refresh Imported agent context.*no structured projection/);
		strictEqual(readClioState(cwd)?.contextSourceHash, provenance.contextSourceHash);
		deepStrictEqual(readClioState(cwd)?.contextSources, provenance.contextSources);
		strictEqual(readClioState(cwd)?.lastInitAt, provenance.lastInitAt);
		deepStrictEqual(readFileSync(path), Buffer.from(source));
	});

	it("preserves the rich authored source through the production session prompt compiler", async () => {
		writeFileSync(path, authored);
		const bundle = createPromptsBundle({
			bus: createSafeEventBus(),
			getContract(name) {
				return name === "context" ? ({ renderPromptContext } as never) : undefined;
			},
		});
		await bundle.extension.start();
		try {
			const compiled = await bundle.contract.compileSessionPrompt({
				sessionId: "handbook-fidelity",
				cwd,
				sessionInputs: { providerSupportsTools: true },
			});
			strictEqual(compiled.projectPreload?.mode, "full", "fixture must fit the unchanged preload budget");
			deepStrictEqual(compiled.projectHandbookFiles, [path]);
			strictEqual(compiled.systemPrompt.includes(authored), true, "the final model prompt must retain the source");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	for (const [name, source] of [
		["LF", authored],
		["BOM and CRLF", `\uFEFF  \r\n${authored.replaceAll("\n", "\r\n")}`],
	] as const) {
		it(`loads every authored byte into real prompt context (${name})`, () => {
			writeFileSync(path, source);
			const prompt = renderPromptContext(cwd);
			deepStrictEqual(prompt.handbookFiles, [path]);
			strictEqual(prompt.text.includes(source), true, "the model must receive the complete authored source");
			strictEqual(prompt.clioMd?.identity, "The first identity paragraph.");
			deepStrictEqual(prompt.clioMd?.warnings, [
				"trailing content after fingerprint footer omitted from structured fields",
			]);
		});

		it(`refreshes the index while preserving every authored byte (${name})`, async () => {
			writeFileSync(path, source);
			strictEqual((await runContextRefresh({ cwd })).clioMd, "unchanged");
			const expected = source;
			deepStrictEqual(readFileSync(path), Buffer.from(expected), "all authored bytes must survive");
			strictEqual(renderPromptContext(cwd).text.includes(expected), true);
			strictEqual((await runContextRefresh({ cwd })).clioMd, "unchanged");
			deepStrictEqual(readFileSync(path), Buffer.from(expected));
		});
	}

	it("does not treat headings inside fences or comments as index-owned sections", async () => {
		const source = authored.replace(`## Context retrieval   \n\n${staleNavigation}\n\n`, "");
		writeFileSync(path, source);
		strictEqual((await runContextRefresh({ cwd })).clioMd, "unchanged");
		deepStrictEqual(readFileSync(path), Buffer.from(source));
	});

	it("leaves ambiguous duplicate index sections untouched", async () => {
		const source = authored.replace(
			"## Custom guidance",
			"## Context retrieval\n\nSECOND_AUTHORED_SECTION\n\n## Custom guidance",
		);
		writeFileSync(path, source);
		strictEqual((await runContextRefresh({ cwd })).clioMd, "unchanged");
		deepStrictEqual(readFileSync(path), Buffer.from(source));
	});

	for (const [name, suffix] of [
		["end of file without a final newline", ""],
		["legacy footer and trailing authored guidance", `\n\n${footer}\n\nTAIL_INSTRUCTION`],
		["multiline footer marker", `\n\n${footer.replace("<!-- ", "<!--\n")}\n\nTAIL_INSTRUCTION`],
	] as const) {
		it(`preserves a generated-looking final section at ${name}`, async () => {
			const source = `# Handbook\n\nIdentity.\n\n## Context retrieval\n\n${staleNavigation}${suffix}`;
			writeFileSync(path, source);
			strictEqual((await runContextRefresh({ cwd })).clioMd, "unchanged");
			deepStrictEqual(readFileSync(path), Buffer.from(source));
		});
	}

	it("preserves an empty generated-looking section", async () => {
		const source = "# Handbook\n\nIdentity.\n\n## Context retrieval";
		writeFileSync(path, source);
		strictEqual((await runContextRefresh({ cwd })).clioMd, "unchanged");
		const expected = source;
		deepStrictEqual(readFileSync(path), Buffer.from(expected));
		strictEqual((await runContextRefresh({ cwd })).clioMd, "unchanged");
		deepStrictEqual(readFileSync(path), Buffer.from(expected));
	});

	it("does not add generated sections to authored documents", async () => {
		for (const [source, status] of [
			["# Handbook\n\nIdentity.\n\n## Commands\n\nRun npm test.\n", "unchanged"],
			["No generated headings here.\n", "unchanged"],
		] as const) {
			writeFileSync(path, source);
			strictEqual((await runContextRefresh({ cwd })).clioMd, status);
			deepStrictEqual(readFileSync(path), Buffer.from(source));
		}
	});

	it("preserves existing ancestor and override selection when rendering exact source", () => {
		writeFileSync(path, authored);
		const child = join(cwd, "src");
		const base = "CHILD_HEADINGLESS_GUIDANCE\n\nPreserve the child-specific command.\n";
		const childPath = join(child, "CLIO-CODER.md");
		writeFileSync(childPath, base);
		const inherited = renderPromptContext(child);
		deepStrictEqual(inherited.handbookFiles, [path, childPath]);
		strictEqual(inherited.text.includes(authored), true);
		strictEqual(inherited.text.includes(base), true);
		strictEqual(inherited.text.indexOf(authored) < inherited.text.indexOf(base), true);
		writeFileSync(path, authored + "Ancestor guidance.\n\n".repeat(600));
		const bounded = selectProjectPreload(renderPromptContext(child), true);
		strictEqual(bounded.classification.mode, "partial");
		strictEqual(bounded.text.includes(base), true);
		deepStrictEqual(
			bounded.classification.sources?.map((source) => source.path),
			[path, childPath],
		);
		const overridePath = join(child, "CLIO-CODER.override.md");
		const override = "OVERRIDE_HEADINGLESS_GUIDANCE\n\nUse the override-specific command.\n";
		writeFileSync(overridePath, override);
		const replaced = renderPromptContext(child);
		deepStrictEqual(replaced.handbookFiles, [overridePath]);
		strictEqual(replaced.text.includes(override), true);
		strictEqual(replaced.text.includes(authored), false);
		strictEqual(replaced.text.includes(base), false);
		strictEqual(replaced.clioMd, null);
		const replacement = selectProjectPreload(replaced, true);
		strictEqual(replacement.classification.mode, "full");
		deepStrictEqual(
			replacement.classification.sources?.map((source) => source.path),
			[overridePath],
		);
	});

	it("keeps authored rules through --apply when a fenced example carries a shell comment", async () => {
		// A `# comment` at column 0 inside a fenced block used to read as a second
		// H1: the parser rejected the handbook, the structured projection went
		// null, and a generated replacement started from nothing rather than from
		// the authored conventions and invariants.
		const fenced = "```sh\n# configure once, then build\ncmake --preset default\n## not a heading either\n```";
		const source = `# Fenced handbook\n\nA C++ project with a fenced example.\n\n## Conventions\n\n- Run ctest before handoff.\n\n## Hard invariants\n\n1. Never edit generated files under build/.\n\n## Commands\n\n${fenced}\n`;
		writeFileSync(path, source);
		const parsed = parseClioMd(source);
		strictEqual(parsed.ok, true);
		if (!parsed.ok) return;
		deepStrictEqual(parsed.value.conventions, ["Run ctest before handoff."]);
		deepStrictEqual(parsed.value.invariants, ["Never edit generated files under build/."]);
		deepStrictEqual(parsed.value.sections, [{ title: "Commands", body: fenced }]);
		strictEqual(renderPromptContext(cwd).clioMd?.projectName, "Fenced handbook");
		// Serialization keeps the fence bytes: no demoted headings, no inserted
		// blank lines inside the block.
		const { importedAgentContext: _imported, ...serializable } = parsed.value;
		strictEqual(serializeClioMd({ ...serializable, fingerprint: null }).includes(fenced), true);
		const applied = await runBootstrap({ cwd, applyClioMd: true });
		strictEqual(applied.summary.action, "refreshed");
		deepStrictEqual(applied.output.conventions.slice(0, 1), ["Run ctest before handoff."]);
		deepStrictEqual(applied.output.invariants, ["Never edit generated files under build/."]);
		const rewritten = readFileSync(path, "utf8");
		strictEqual(rewritten.includes(fenced), true, "the fenced example survives the generated rewrite byte for byte");
		const reparsed = parseClioMd(rewritten);
		strictEqual(reparsed.ok, true);
	});

	it("keeps comment-wrapped headings out of the projection and the serializer", () => {
		const comment = "<!--\n# Not a title\n## Not a section\n-->";
		const source = `# Guide\n\nAuthored.\n\n## Notes\n\nKeep this.\n\n${comment}\n`;
		const parsed = parseClioMd(source);
		strictEqual(parsed.ok, true);
		if (!parsed.ok) return;
		deepStrictEqual(parsed.value.sections, [{ title: "Notes", body: `Keep this.\n\n${comment}` }]);
		const { importedAgentContext: _imported, ...serializable } = parsed.value;
		strictEqual(serializeClioMd({ ...serializable, fingerprint: null }).includes(comment), true);
	});

	it("keeps the model proposal parser strict while authored Markdown loads", () => {
		const proposal = { projectName: "Fixture", identity: "A project.", conventions: [], invariants: [] };
		strictEqual(parseBootstrapModelOutput(JSON.stringify(proposal)).identity, proposal.identity);
		for (const invalid of [
			"Ordinary headingless instructions.\n",
			"# Guide\n\nAuthored Markdown.\n",
			JSON.stringify({ ...proposal, identity: "" }),
			JSON.stringify({ projectName: "Fixture" }),
		]) {
			throws(() => parseBootstrapModelOutput(invalid));
		}
	});

	it("keeps generated-document validation separate from source fidelity", () => {
		strictEqual(parseClioMd("Ordinary headingless instructions.\n").ok, false);
		throws(() => serializeClioMd({ projectName: "Fixture", identity: "", conventions: [], invariants: [] }));
	});
});
