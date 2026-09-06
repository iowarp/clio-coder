import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { parseClioMd, serializeClioMd } from "../../src/domains/context/clio-md.js";
import { renderPromptContext } from "../../src/domains/context/prompt-context.js";
import { runContextRefresh } from "../../src/domains/context/refresh.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const staleNavigation = "OLD_INDEX_ENTRY";
const freshNavigation =
	"Start orientation with these indexed entry points: `src/index.ts`. Use `code_nav` (modes: symbol, path, entries, outline, deps, dependents, wiki) before broad reads when the task is navigational.";
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
		isolated = await isolateClioEnv("clio-handbook-fidelity-");
		cwd = isolated.dir;
		path = join(cwd, "CLIO-CODER.md");
		mkdirSync(join(cwd, "src"));
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "handbook-fixture", type: "module" }));
		writeFileSync(join(cwd, "src", "index.ts"), "export const calibration = true;\n");
	});

	afterEach(() => isolated.restore());

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

		it(`refreshes only the actual index-owned body and remains byte-stable (${name})`, async () => {
			writeFileSync(path, source);
			strictEqual((await runContextRefresh({ cwd })).clioMd, "updated");
			const expected = source.replace(staleNavigation, freshNavigation);
			deepStrictEqual(readFileSync(path), Buffer.from(expected), "all bytes outside the managed body must survive");
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
		it(`bounds the final managed body at ${name}`, async () => {
			const source = `# Handbook\n\nIdentity.\n\n## Context retrieval\n\n${staleNavigation}${suffix}`;
			writeFileSync(path, source);
			strictEqual((await runContextRefresh({ cwd })).clioMd, "updated");
			deepStrictEqual(readFileSync(path), Buffer.from(source.replace(staleNavigation, freshNavigation)));
		});
	}

	it("fills an empty managed section without joining its heading and body", async () => {
		const source = "# Handbook\n\nIdentity.\n\n## Context retrieval";
		writeFileSync(path, source);
		strictEqual((await runContextRefresh({ cwd })).clioMd, "updated");
		const expected = `${source}\n${freshNavigation}\n`;
		deepStrictEqual(readFileSync(path), Buffer.from(expected));
		strictEqual((await runContextRefresh({ cwd })).clioMd, "unchanged");
		deepStrictEqual(readFileSync(path), Buffer.from(expected));
	});

	it("does not add a missing managed section or touch a malformed document", async () => {
		for (const [source, status] of [
			["# Handbook\n\nIdentity.\n\n## Commands\n\nRun npm test.\n", "unchanged"],
			["No generated headings here.\n", "absent"],
		] as const) {
			writeFileSync(path, source);
			strictEqual((await runContextRefresh({ cwd })).clioMd, status);
			deepStrictEqual(readFileSync(path), Buffer.from(source));
		}
	});

	it("preserves existing ancestor and override selection when rendering exact source", () => {
		writeFileSync(path, authored);
		const child = join(cwd, "src");
		const base = "# Child\n\nChild identity.\n\nCHILD_SECOND_PARAGRAPH\n";
		const childPath = join(child, "CLIO-CODER.md");
		writeFileSync(childPath, base);
		const inherited = renderPromptContext(child);
		deepStrictEqual(inherited.handbookFiles, [path, childPath]);
		strictEqual(inherited.text.includes(authored), true);
		strictEqual(inherited.text.includes(base), true);
		strictEqual(inherited.text.indexOf(authored) < inherited.text.indexOf(base), true);
		const overridePath = join(child, "CLIO-CODER.override.md");
		const override = "# Override\n\nOverride identity.\n\nOVERRIDE_SECOND_PARAGRAPH\n";
		writeFileSync(overridePath, override);
		const replaced = renderPromptContext(child);
		deepStrictEqual(replaced.handbookFiles, [overridePath]);
		strictEqual(replaced.text.includes(override), true);
		strictEqual(replaced.text.includes(authored), false);
		strictEqual(replaced.text.includes(base), false);
	});

	it("keeps generated-document validation separate from source fidelity", () => {
		strictEqual(parseClioMd("Ordinary headingless instructions.\n").ok, false);
		throws(() => serializeClioMd({ projectName: "Fixture", identity: "", conventions: [], invariants: [] }));
	});
});
