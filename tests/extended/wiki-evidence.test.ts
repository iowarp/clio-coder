import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	inspectWikiPageEvidence,
	repairWikiLinks,
	validateWikiPageEvidence,
} from "../../src/domains/context/wiki/evidence.js";

import { repairWikiCitations } from "../../src/domains/context/wiki/markdown.js";

let sandbox: string;
let root: string;
function check(content: string) {
	return validateWikiPageEvidence({ sourceRoot: root, pagePath: "area.md", content });
}
function page(reference = "src/main.ts", body = "The entry point is implemented here.") {
	return `---\nsources: [${JSON.stringify(reference)}]\n---\n# Area\n\n${body}\n`;
}

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "wiki-evidence-"));
	root = join(sandbox, "repo");
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, "tests"));
	writeFileSync(join(root, "src/main.ts"), "first\nsecond\nthird\n");
	writeFileSync(join(root, "tests/main.test.ts"), "test\n");
	writeFileSync(join(root, "package.json"), "{}\n");
	writeFileSync(join(root, "Makefile"), "all:\n");
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["add", "."], { cwd: root });
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

describe("wiki mechanical evidence gate", () => {
	it("classifies declared coverage gaps as substantive failures even when mechanical evidence passes", () => {
		const content = page().replace(
			"---\n#",
			'coverage_gaps:\n  - "Inspect the admission rejection branch and its test."\n---\n#',
		);
		const result = check(content);
		strictEqual(result.ok, false);
		strictEqual(result.validationKind, "coverage");
		strictEqual(result.dependencies, undefined);
		deepStrictEqual(result.reasons, ["Coverage gap: Inspect the admission rejection branch and its test."]);
		strictEqual(check(`${content}\nSee \`missing.py\`.`).validationKind, "coverage");
		strictEqual(check(page().replace("---\n#", "coverage_gaps: []\n---\n#")).ok, true);
		for (const invalid of ["null", '"not a list"', '[""]', "[123]"]) {
			strictEqual(check(page().replace("---\n#", `coverage_gaps: ${invalid}\n---\n#`)).ok, false);
		}
	});

	it("shares repairable link and generated-index targets while excluding empty and missing pages", () => {
		const outputDir = join(root, ".clio-coder/wiki");
		mkdirSync(join(outputDir, "section"), { recursive: true });
		mkdirSync(join(outputDir, "empty"));
		writeFileSync(join(outputDir, "target.md"), page());
		writeFileSync(join(outputDir, "empty/page.md"), "# Empty\n<!-- no content -->\n");
		writeFileSync(join(outputDir, "empty/index.md"), "# Stale index\n\nOld navigation.\n");
		const valid = page(
			"src/main.ts",
			"[Root](target.md#heading), [Section](index.md), [Wiki](../index.md), " +
				"[External](https://example.com/missing.md), [Local](#heading).\n```md\n[Example](missing.md)\n```",
		);
		writeFileSync(join(outputDir, "section/page.md"), valid);
		const input = { sourceRoot: root, outputDir, pagePath: "section/page.md" };
		strictEqual(inspectWikiPageEvidence(input).ok, true);
		writeFileSync(
			join(outputDir, "section/page.md"),
			`${valid}\n[Empty](../empty/page.md) [Stale](../empty/index.md) [Missing](missing.md)\n`,
		);
		const invalid = inspectWikiPageEvidence(input);
		strictEqual(invalid.ok, false);
		strictEqual(invalid.reasons.length, 3);
		for (const target of ["../empty/page.md", "../empty/index.md", "missing.md"]) {
			strictEqual(
				invalid.reasons.some((reason) => reason.includes(target)),
				true,
			);
		}
	});

	it("repairs titled, angle-bracket and reference-definition links while preserving Markdown formatting", () => {
		const wikiLinks = { targets: new Set(["target.md"]), unavailable: new Set<string>() };
		for (const body of [
			'[Title](target.md "Optional title")',
			"[Title](target.md 'Optional title')",
			"[Title](target.md (Optional title))",
			"[Angle](<target.md#heading>)",
			"[Multiline](\ntarget.md)",
			"[Reference][target]\n\n[target]:\n  target.md",
			'[Both](<target.md> "Optional `code` title")',
			'[Reference][target]\n\n[target]: target.md "Optional title"',
			'[Collapsed][]\n\n[Collapsed]: <target.md#heading> "Optional title"',
			"[Shortcut]\n\n[Shortcut]: target.md",
		]) {
			deepStrictEqual(repairWikiLinks("section/page.md", body, wikiLinks), {
				body: body.replace("target.md", "../target.md"),
				unresolved: [],
			});
			const input = { sourceRoot: root, pagePath: "section/page.md", wikiLinks };
			strictEqual(validateWikiPageEvidence({ ...input, content: page("src/main.ts", body) }).ok, true, body);
			const missing = body.replace("target.md", "missing.md");
			const result = validateWikiPageEvidence({ ...input, content: page("src/main.ts", missing) });
			strictEqual(result.ok, false, missing);
			strictEqual(result.reasons.length, 1, missing);
			match(result.reasons[0] ?? "", /unresolved wiki link "missing.md"/);
		}
	});

	it("excludes inline code spans and fences from link inspection and rewriting", () => {
		const wikiLinks = { targets: new Set(["target.md"]), unavailable: new Set<string>() };
		for (const body of [
			'`[Example](missing.md "Title")` and `[Target](target.md)`.',
			"`` `[Example](<missing.md>)` and [Target](target.md) ``",
			"`Example on two lines:\n[Example](missing.md) and [Target](target.md)`",
			'`Example definition:\n[label]: <missing.md> "Title"`',
			"~~~markdown\n~~~text\n[Example](missing.md) and [Target](target.md)\n~~~",
			"```markdown\n[Label][label]\n[label]: missing.md\n```",
		]) {
			deepStrictEqual(repairWikiLinks("section/page.md", body, wikiLinks), { body, unresolved: [] });
			strictEqual(
				validateWikiPageEvidence({
					sourceRoot: root,
					pagePath: "section/page.md",
					content: page("src/main.ts", body),
					wikiLinks,
				}).ok,
				true,
				body,
			);
		}
		for (const separator of ["\n\n", "\n \n", "\r\n\t\r\n"]) {
			const body = `Unclosed \` tick.${separator}[Missing](missing.md) [Target](target.md)${separator}Another \` tick.`;
			deepStrictEqual(repairWikiLinks("section/page.md", body, wikiLinks), {
				body: body.replace("target.md", "../target.md"),
				unresolved: ["missing.md"],
			});
			strictEqual(
				validateWikiPageEvidence({
					sourceRoot: root,
					pagePath: "section/page.md",
					content: page("src/main.ts", body),
					wikiLinks,
				}).ok,
				false,
			);
		}
		deepStrictEqual(repairWikiLinks("section/page.md", "[Not a link](\n\nmissing.md)", wikiLinks).unresolved, []);

		deepStrictEqual(repairWikiLinks("section/page.md", "Unclosed ` tick: [Missing](missing.md)", wikiLinks).unresolved, [
			"missing.md",
		]);
	});

	it("inspects parser containers and block boundaries while keeping indented code opaque", () => {
		const wikiLinks = { targets: new Set(["target.md"]), unavailable: new Set<string>() };
		for (const body of [
			"Opening ` tick.\n# Heading\n[Broken](missing.md)\nClosing ` tick.",
			"[Multiline\nlabel](missing.md)",
			"[Use][ref]\n\n> [ref]: missing.md",
			"- > [Nested](missing.md)",
			"| Link |\n| --- |\n| [Broken](missing.md) |",
		]) {
			deepStrictEqual(repairWikiLinks("area.md", body, wikiLinks).unresolved, ["missing.md"], body);
		}
		const opaque = "    [Example](missing.md) `missing.ts`\n\n- Item\n\n      [Nested code](missing.md) `missing.py`";
		deepStrictEqual(repairWikiLinks("area.md", opaque, wikiLinks), { body: opaque, unresolved: [] });
		strictEqual(check(page("src/main.ts", opaque)).ok, true);
		for (const body of [
			"# `missing.ts`",
			"> - ``missing.ts``",
			"| Source |\n| --- |\n| `missing.ts` |",
			"See `\nmissing.ts\n`.",
		]) {
			strictEqual(check(page("src/main.ts", body)).ok, false, body);
		}
	});

	it("patches used reference definitions once, including blockquotes and normalized labels", () => {
		const inventory = { targets: new Set(["target.md"]), unavailable: new Set<string>() };
		for (const body of [
			'[One][REF] and [ref][] and [ref].\n\n> [ref]: target.md "Title"',
			"[Two\nlines](target.md)",
			"- > [Nested](target.md)",
		]) {
			const repaired = repairWikiLinks("section/page.md", body, inventory);
			deepStrictEqual(repaired, { body: body.replace("target.md", "../target.md"), unresolved: [] });
			deepStrictEqual(repairWikiLinks("section/page.md", repaired.body, inventory), repaired);
		}
		deepStrictEqual(repairWikiLinks("section/page.md", "[unused]: missing.md", inventory), {
			body: "[unused]: missing.md",
			unresolved: [],
		});
	});

	it("decodes Markdown escapes, entities and URL paths before inventory lookup", () => {
		const inventory = {
			targets: new Set(["target.md", "a&b.md", "two words.md", "a(b).md", "©.md", "a#b.md", "€uro.md"]),
			unavailable: new Set<string>(),
		};
		for (const href of [
			"target%2emd",
			"target&#46;md",
			"target&period;md",
			"a&amp;b.md",
			"two%20words.md",
			"&copy;.md",
			"a%23b.md",
			"&#128;uro.md",
			"target.md?view=1#part",
			"a\\(b\\).md",
		]) {
			const body = `[Link](${href})`;
			deepStrictEqual(repairWikiLinks("page.md", body, inventory), { body, unresolved: [] }, href);
		}
		deepStrictEqual(repairWikiLinks("page.md", "[Missing](missing%2emd)", inventory).unresolved, ["missing.md"]);
		const sibling = { targets: new Set(["section/local.md"]), unavailable: new Set<string>() };
		const rooted = { targets: new Set(["section/local.md", "local.md"]), unavailable: new Set<string>() };
		for (const [href, expected] of [
			["/local.md", "/local.md"],
			["/../local.md", "/../local.md"],
			["%2Flocal.md", "%2Flocal.md"],
			["%2flocal.md", "%2flocal.md"],
			["sub%2Flocal.md", "sub%2Flocal.md"],
			["sub%5Clocal.md", "sub%5Clocal.md"],
		] as const) {
			const body = `[Link](${href})`;
			const missing = repairWikiLinks("section/page.md", body, sibling);
			deepStrictEqual(missing, { body, unresolved: [expected] }, href);
			const present = repairWikiLinks("section/page.md", body, rooted);
			deepStrictEqual(present, { body, unresolved: href === "/local.md" ? [] : [expected] }, href);
		}
	});

	it("preserves CRLF and Unicode and diagnoses normalized or ambiguous repairs", () => {
		const inventory = { targets: new Set(["target.md"]), unavailable: new Set<string>() };
		const stable = "# Café 🧪\r\n\r\n\r\n[Résumé](target.md)\r\n  ";
		deepStrictEqual(repairWikiLinks("section/page.md", stable, inventory), {
			body: stable.replace("target.md", "../target.md"),
			unresolved: [],
		});
		for (const body of [
			'[Multiline]( \r\n  <target.md#heading>\r\n"Optional title"\r\n)',
			"[Repeat](target.md) [Repeat](target.md)",
			"- > [Nested\n  > label](target.md)",
			"[target.md](target.md)",
		]) {
			const repaired = repairWikiLinks("section/page.md", body, inventory);
			strictEqual(repaired.body, body);
			strictEqual((repaired.diagnostics?.length ?? 0) > 0, true, body);
			strictEqual(
				validateWikiPageEvidence({
					sourceRoot: root,
					pagePath: "section/page.md",
					content: page("src/main.ts", body),
					wikiLinks: inventory,
				}).ok,
				false,
			);
		}
	});

	it("rejects a patch when re-lexing changes Markdown beyond the intended citation", () => {
		const body = "See `main.ts` and preserve 🧪 prose.";
		const result = repairWikiCitations(body, { "main.ts": "src/a`file.ts" });
		strictEqual(result.body, body);
		strictEqual(result.diagnostics.length, 1);
	});

	it("accepts exact source occurrences without certifying their runtime meaning", () => {
		for (const text of ["// Layout: verdict-<tier>.json", 'path = "verdict-<tier>.json".replace("json", "yaml")']) {
			writeFileSync(join(root, "src/main.ts"), text);
			strictEqual(check(page("src/main.ts", "Layout: `verdict-<tier>.json`.")).ok, true);
			strictEqual(check(page("package.json", "Layout: `verdict-<tier>.json`.")).ok, false);
		}
		writeFileSync(join(root, "untracked.json"), "{}");
		strictEqual(check(page("src/main.ts", "Layout: `untracked*.json`.")).ok, false);
		strictEqual(check(page("src/main.ts", "Layout: `src/*.ts`.")).ok, true);
		writeFileSync(join(root, "src/gone.cfg"), "x");
		writeFileSync(join(sandbox, "outside.txt"), "x");
		symlinkSync(join(sandbox, "outside.txt"), join(root, "src/escape.lnk"));
		execFileSync("git", ["add", "src/gone.cfg", "src/escape.lnk"], { cwd: root });
		rmSync(join(root, "src/gone.cfg"));
		strictEqual(check(page("src/main.ts", "Layout: `src/gone*.cfg`.")).ok, false);
		strictEqual(check(page("src/main.ts", "Layout: `src/escape*.lnk`.")).ok, false);
	});

	it("exposes individually valid body rewrites even when another citation fails", () => {
		const result = check(page("src/main.ts", "See `src/main.js:1-3`, `main.js#L2`, `main.js:9`, and `missing.py`."));
		strictEqual(result.ok, false);
		strictEqual(result.dependencies, undefined);
		deepStrictEqual(result.resolvedCitations, {
			"src/main.js:1-3": "src/main.ts:1-3",
			"main.js#L2": "src/main.ts#L2",
		});
		strictEqual(check(page("src/main.js", "Source metadata is not a body citation.")).resolvedCitations, undefined);
	});

	it("returns resolved body dependencies and full diagnostics on failed validation", () => {
		const missing = Array.from({ length: 10 }, (_, index) => `missing/${"segment/".repeat(45)}file-${index}.ts`);
		const body = [
			"See `src/main.js:99`, `tests/main.test.ts`, and `package.json`.",
			...missing.map((path) => `Missing: \`${path}\`.`),
		].join("\n");
		const result = check(body);
		strictEqual(result.ok, false);
		strictEqual(result.dependencies, undefined);
		deepStrictEqual(result.resolvedDependencies, ["package.json", "src/main.ts", "tests/main.test.ts"]);
		strictEqual(result.reasons.length, 8);
		strictEqual(
			result.reasons.every((reason) => reason.length <= 300),
			true,
		);
		strictEqual(result.allReasons?.length, 11);
		match(result.allReasons?.[0] ?? "", /Repair line range/);
		for (const [index, path] of missing.entries()) {
			strictEqual(
				result.allReasons?.[index + 1],
				`Replace or remove unresolved repository reference ${JSON.stringify(path)}; inspect the current file path.`,
			);
		}
		deepStrictEqual(
			result.reasons,
			result.allReasons?.slice(0, 8).map((reason) => reason.slice(0, 300)),
		);
	});

	it("resolves a real relative import from a declared source without accepting escaping or invented imports", () => {
		writeFileSync(join(root, "tests/main.test.ts"), 'import { main } from "../src/main.js";\n');
		const content = "---\nsources: [src/main.ts]\ntests: [tests/main.test.ts]\n---\nThe test imports `../src/main.js`.";
		deepStrictEqual(check(content), {
			ok: true,
			reasons: [],
			dependencies: ["src/main.ts", "tests/main.test.ts"],
			resolvedCitations: { "../src/main.js": "src/main.ts" },
		});
		strictEqual(check(content.replace("`../src/main.js`", "`../src/invented.js`")).ok, false);
		writeFileSync(join(sandbox, "outside.ts"), "outside\n");
		writeFileSync(join(root, "tests/main.test.ts"), 'import "../../outside.ts";\n');
		strictEqual(check(content.replace("`../src/main.js`", "`../../outside.ts`")).ok, false);
	});

	it("records a test selector's package evidence and accepts a matching layout glob without a command", () => {
		writeFileSync(join(root, "package.json"), '{"scripts":{"test":"node --test tests/*.test.ts"}}');
		const content = "---\ntests: [tests/main.test.ts]\n---\nCI discovers `tests/*.test.ts`.";
		deepStrictEqual(check(content), { ok: true, reasons: [], dependencies: ["package.json", "tests/main.test.ts"] });
		strictEqual(check(content.replace("tests/*.test.ts", "tests/missing-*.test.ts")).ok, false);
		strictEqual(check("---\ntests: [tests/*.test.ts]\n---\nA page.").ok, false);
		writeFileSync(join(root, "package.json"), "{}");
		deepStrictEqual(check(content), { ok: true, reasons: [], dependencies: ["tests/main.test.ts"] });
	});

	it("accepts matching repository globs as mentions but rejects absent matches and glob evidence", () => {
		for (const glob of ["src/*.ts", "**/main.ts", "src/ma?n.ts", "src/[m]ain.ts"]) {
			deepStrictEqual(check(page("package.json", `The layout includes \`${glob}\`.`)), {
				ok: true,
				reasons: [],
				dependencies: ["package.json"],
			});
		}
		for (const glob of ["src/missing-*.ts", "missing/**/*.json", "../*.ts"]) {
			strictEqual(check(page("package.json", `The layout includes \`${glob}\`.`)).ok, false, glob);
		}
		strictEqual(check(page("src/*.ts")).ok, false);
		strictEqual(check("The layout includes `src/*.ts`.").ok, false);
		strictEqual(check(page("package.json", "See `src/*.ts:1`.")).ok, false);
	});

	it("requires exact template spelling rather than inferred expression values", () => {
		writeFileSync(
			join(root, "src/main.ts"),
			'output = f"verdict-{tier}.json"\nraw = trial_dir / "raw" / "metrics.json"\n' +
				'path = "research" / "directives" / f"{campaign_id}.yaml"\n' +
				'measure = root / "measure" / tier / "*/block-*/measurements.json"\n',
		);
		for (const name of [
			"verdict-<tier>.json",
			"raw/metrics.json",
			"research/directives/<campaign_id>.yaml",
			"measure/<tier>/*/block-*/measurements.json",
		]) {
			strictEqual(check(page("src/main.ts", `The runtime layout is \`${name}\`.`)).ok, false, name);
			strictEqual(check(page("package.json", `The runtime layout is \`${name}\`.`)).ok, false, name);
			strictEqual(check(page("src/main.ts", `See \`${name}:1\`.`)).ok, false, name);
			strictEqual(check(page(name)).ok, false, name);
		}
		for (const name of ["invented-<tier>.json", "verdict-<tier>.missing.json", "raw/invented.json"]) {
			strictEqual(check(page("src/main.ts", `The runtime layout is \`${name}\`.`)).ok, false, name);
		}
		writeFileSync(join(root, "src/main.ts"), 'output = f"preverdict-{tier}.json"\n');
		strictEqual(check(page("src/main.ts", "The layout is `verdict-<tier>.json`.")).ok, false);
		writeFileSync(join(root, "src/main.ts"), 'output = f"verdict-{tier}.jsonl"\n');
		strictEqual(check(page("src/main.ts", "The layout is `verdict-<tier>.json`.")).ok, false);
		writeFileSync(join(root, "src/main.ts"), 'prefix = "verdict-"\n');
		writeFileSync(join(root, "tests/main.test.ts"), 'suffix = ".json"\n');
		strictEqual(
			check("---\nsources: [src/main.ts, tests/main.test.ts]\n---\nThe layout is `verdict-<tier>.json`.").ok,
			false,
		);
	});

	it("rejects unrelated literals, wrong suffixes, reordered paths and repeated components", () => {
		writeFileSync(
			join(root, "src/main.ts"),
			'lineage = self.research_dir / "lineage" / f"{self.campaign_id}.jsonl"\n' +
				'steering = self.research_dir / "steering" / f"{self.campaign_id}.jsonl"\n' +
				'directive = self.research_dir / "directives" / f"{self.campaign_id}.yaml"\n' +
				'raw = trial_dir / "raw" / "metrics.json"\n' +
				'prefix = "detached"; suffix = "result.json"\n' +
				'measure = root / "measure" / tier\nmeasure.glob("*/block-*/measurements.json")\n',
		);
		for (const name of [
			"lineage/<campaign_id>.jsonl",
			"steering/<campaign_id>.jsonl",
			"directives/<campaign_id>.yaml",
			"raw/metrics.json",
		]) {
			strictEqual(check(page("src/main.ts", `Layout: \`${name}\`.`)).ok, false, name);
		}
		for (const name of [
			"lineage/<campaign_id>.yaml",
			"steering/<campaign_id>.yaml",
			"<campaign_id>/lineage.jsonl",
			"lineage/lineage/<campaign_id>.jsonl",
			"raw/raw/metrics.json",
			"raw/<invented>/metrics.json",
			"metrics.json/raw/metrics.json",
			"detached/result.json",
			"detached/<id>/result.json",
			"measure/<tier>/*/block-*/measurements.json",
		]) {
			strictEqual(check(page("src/main.ts", `Layout: \`${name}\`.`)).ok, false, name);
		}
	});

	it("rejects synthesized templates from joins, Path chains, literals and concatenation", () => {
		for (const expression of [
			'os.path.join(root, "lineage", f"{campaign_id}.jsonl")',
			'Path(root, "lineage") / f"{campaign_id}.jsonl"',
			`path.posix.join(root, "lineage", \`\${campaign_id}.jsonl\`)`,
			`\`lineage/\${campaign_id}.jsonl\``,
			'"lineage/" + campaign_id + ".jsonl"',
			'(f"lineage/{campaign_id}.jsonl")',
			'write_file(f"lineage/{campaign_id}.jsonl", contents)',
			'f"lineage/{campaign_id}.jsonl"; next_statement()',
			'f"lineage/{campaign_id}.jsonl" # Comment\nnext_statement()',
			'f"lineage/{campaign_id}.jsonl"\nif condition:\n    next_statement()',
			'f"lineage/{campaign_id}.jsonl"\nfor item in items:\n    next_statement()',
			'root / "lineage" / f"{campaign_id}.jsonl"\nif condition:\n    next_statement()',
		]) {
			writeFileSync(join(root, "src/main.ts"), `output = ${expression}\n`);
			strictEqual(check(page("src/main.ts", "Layout: `lineage/<campaign_id>.jsonl`.")).ok, false, expression);
			strictEqual(check(page("src/main.ts", "Layout: `lineage/<campaign_id>.yaml`.")).ok, false, expression);
			strictEqual(check(page("src/main.ts", "Layout: `lineage/lineage/<campaign_id>.jsonl`.")).ok, false, expression);
		}
		for (const expression of [
			'"lineage/" + transform(campaign_id) + ".jsonl"',
			'build_path("lineage", campaign_id, ".jsonl")',
			'"lineage" / campaign_id + ".jsonl"',
			'f"lineage/{transform(campaign_id)}.jsonl"',
			'f"lineage/{campaign_id}.jsonl" + ".yaml"',
			'f"lineage/{campaign_id}.jsonl".replace(".jsonl", ".yaml")',
			'Path(root, "lineage", f"{campaign_id}.jsonl").with_suffix(".yaml")',
			'(f"lineage/{campaign_id}.jsonl").replace(".jsonl", ".yaml")',
			'(f"lineage/{campaign_id}.jsonl")\n.replace(".jsonl", ".yaml")',
			'f"lineage/{campaign_id}.jsonl"[:-1]',
			'f"lineage/{campaign_id}.jsonl" * 2',
			'f"lineage/{campaign_id}.jsonl" // 2',
			'2 * f"lineage/{campaign_id}.jsonl"',
			'f"lineage/{campaign_id}.jsonl" if condition else "other.yaml"',
			'(f"lineage/{campaign_id}.jsonl"\n if condition else "other.yaml")',
		]) {
			writeFileSync(join(root, "src/main.ts"), `output = ${expression}\n`);
			strictEqual(check(page("src/main.ts", "Layout: `lineage/<campaign_id>.jsonl`.")).ok, false, expression);
		}
	});

	it("rejects unmatched plain globs even when a declared source contains the exact literal", () => {
		writeFileSync(join(root, "src/main.ts"), 'glob = "missing/**/*.json"\n');
		strictEqual(check(page("src/main.ts", "Layout: `missing/**/*.json`.")).ok, false);
	});

	it("accepts readable pages without a mandatory template and resolves JS source aliases", () => {
		deepStrictEqual(check(page("src/main.js", "See `src/main.js:1-3` and `tests/main.test.ts#L1`.")), {
			ok: true,
			reasons: [],
			dependencies: ["src/main.ts", "tests/main.test.ts"],
			resolvedCitations: { "src/main.js:1-3": "src/main.ts:1-3" },
		});
		strictEqual(check("See `package.json:1` and `Makefile`. No frontmatter is required.").ok, true);
	});

	it("returns canonical body-only evidence for source checkpoints and no dependencies on failure", () => {
		symlinkSync(join(root, "src/main.ts"), join(root, "src/alias.ts"));
		deepStrictEqual(check("See `src/main.js:1`, `src/alias.ts`, and `package.json`."), {
			ok: true,
			reasons: [],
			dependencies: ["package.json", "src/main.ts"],
			resolvedCitations: { "src/main.js:1": "src/main.ts:1", "src/alias.ts": "src/main.ts" },
		});
		const failed = check(page("src/main.ts", "See `missing.py`."));
		strictEqual(failed.ok, false);
		strictEqual(failed.dependencies, undefined);
		deepStrictEqual(check("See `package.json`.").dependencies, ["package.json"]);
	});

	it("resolves body shorthand only through uniquely declared source/test files", () => {
		deepStrictEqual(
			check(
				"---\nsources: [src/main.js]\ntests: [tests/main.test.ts]\n---\nSee `main.js:1-3`, `main.ts#L2`, and `main.test.ts:1`.",
			),
			{
				ok: true,
				reasons: [],
				dependencies: ["src/main.ts", "tests/main.test.ts"],
				resolvedCitations: {
					"main.js:1-3": "src/main.ts:1-3",
					"main.ts#L2": "src/main.ts#L2",
					"main.test.ts:1": "tests/main.test.ts:1",
				},
			},
		);
		mkdirSync(join(root, "slugify"));
		for (const name of ["special.py", "__init__.py", "__version__.py"]) {
			writeFileSync(join(root, "slugify", name), "source\n");
		}
		deepStrictEqual(
			check(
				"---\nsources: [slugify/special.py, slugify/__init__.py, slugify/__version__.py]\n---\n" +
					"The package re-exports `special.py` through `__init__.py`.\n\n## Metadata from `__version__.py`\n",
			),
			{
				ok: true,
				reasons: [],
				dependencies: ["slugify/__init__.py", "slugify/__version__.py", "slugify/special.py"],
				resolvedCitations: {
					"special.py": "slugify/special.py",
					"__init__.py": "slugify/__init__.py",
					"__version__.py": "slugify/__version__.py",
				},
			},
		);
	});

	it("keeps shorthand strict for ambiguous lines, undeclared files, frontmatter and escapes", () => {
		writeFileSync(join(root, "tests/main.ts"), "different\n");
		writeFileSync(join(root, "src/undeclared.ts"), "present but not declared\n");
		writeFileSync(join(sandbox, "outside.ts"), "outside\n");
		symlinkSync(join(sandbox, "outside.ts"), join(root, "src/escape.ts"));
		for (const content of [
			"---\nsources: [src/main.ts, tests/main.ts]\n---\nSee `main.ts:1`.",
			"---\nsources: [src/main.ts, main.ts]\n---\nSee `main.ts`.",
			page("src/main.ts", "See `undeclared.ts` and `unknown.ts`."),
			page("src/main.ts", "See `main.ts:4`."),
			page("src/main.ts", "See `main.ts:0` and `main.ts:3-2`."),
			page("src/main.ts", "See `../main.ts` and `other/main.ts`."),
			page("src/escape.ts", "See `escape.ts`."),
		]) {
			const result = check(content);
			strictEqual(result.ok, false, content);
			strictEqual(result.dependencies, undefined);
		}
	});

	it("resolves unique NodeNext basenames and path suffixes to authored files", () => {
		mkdirSync(join(root, "src/nested"));
		for (const [authored, cited] of [
			["main.ts", "main.js"],
			["view.tsx", "view.js"],
			["module.mts", "module.mjs"],
			["common.cts", "common.cjs"],
		] as const) {
			writeFileSync(join(root, "src/nested", authored), "source\n");
			const reference = authored === "main.ts" ? `nested/${cited}` : cited;
			deepStrictEqual(check(page("package.json", `See \`${reference}\`.`)), {
				ok: true,
				reasons: [],
				dependencies: ["package.json", `src/nested/${authored}`],
				resolvedCitations: { [reference]: `src/nested/${authored}` },
			});
		}
		rmSync(join(root, "src/nested/main.ts"));
		deepStrictEqual(check(page("package.json", "See `main.js`.")), {
			ok: true,
			reasons: [],
			dependencies: ["package.json", "src/main.ts"],
			resolvedCitations: { "main.js": "src/main.ts" },
		});
	});

	it("accepts ambiguous real basenames as mentions without adding or substituting evidence", () => {
		writeFileSync(join(root, "tests/main.ts"), "different\n");
		for (const name of ["main.ts", "main.js"]) {
			deepStrictEqual(check(page("package.json", `Modules use \`${name}\`.`)), {
				ok: true,
				reasons: [],
				dependencies: ["package.json"],
			});
			const result = check(`Modules use \`${name}\`.`);
			strictEqual(result.ok, false);
			match(result.reasons.join(" "), /Cite at least one existing repository file/);
			strictEqual(check(page("package.json", `See \`${name}:1\`.`)).ok, false);
		}
	});

	it("accepts declared source literals as mentions while rejecting fabricated or unverified citations", () => {
		writeFileSync(join(root, "src/main.ts"), 'const config = "settings.yaml"; const example = "<project>/src/a.ts";\n');
		const content = page("src/main.ts", "The names are `settings.yaml` and `<project>/src/a.ts`.");
		deepStrictEqual(check(content), { ok: true, reasons: [], dependencies: ["src/main.ts"] });
		strictEqual(check(content.replace("settings.yaml", "fabricated.yaml")).ok, false);
		strictEqual(check(page("package.json", "The name is `settings.yaml`.")).ok, false);
		strictEqual(check(page("src/main.ts", "See `settings.yaml:1`.")).ok, false);
		strictEqual(check(page("settings.yaml", "The configuration is described here.")).ok, false);
		truncateSync(join(root, "src/main.ts"), 512 * 1024 + 1);
		strictEqual(check(content).ok, false);
	});

	it("requires complete literal tokens rather than filename or path substrings", () => {
		for (const [cited, literal] of [
			["data.ts", "metadata.ts"],
			["foo/bar.ts", "src/foo/bar.ts"],
		]) {
			writeFileSync(join(root, "src/main.ts"), `const example = "${literal}";\n`);
			strictEqual(check(page("src/main.ts", `See \`${cited}\`.`)).ok, false, cited);
		}
		writeFileSync(join(root, "src/main.ts"), "// Load settings.yaml.\n");
		deepStrictEqual(check(page("src/main.ts", "The name is `settings.yaml`.")), {
			ok: true,
			reasons: [],
			dependencies: ["src/main.ts"],
		});
	});

	it("verifies test selectors against the nearest workspace package and a declared matching test", () => {
		mkdirSync(join(root, "apps/gui/tests"), { recursive: true });
		writeFileSync(join(root, "apps/gui/tests/view.test.ts"), "test\n");
		execFileSync("git", ["add", "apps"], { cwd: root });
		const manifest = join(root, "apps/gui/package.json");
		writeFileSync(manifest, '{"scripts":{"test":"node --test tests/*.test.ts tests/*.test.tsx"}}');
		const content = "---\ntests: [apps/gui/tests/view.test.ts]\n---\nCI discovers `tests/*.test.ts`.";
		deepStrictEqual(check(content), {
			ok: true,
			reasons: [],
			dependencies: ["apps/gui/package.json", "apps/gui/tests/view.test.ts"],
		});
		strictEqual(check(content.replace("tests/*.test.ts`", "tests/*.test.tsx`")).ok, false);
		writeFileSync(join(root, "package.json"), '{"scripts":{"test":"node --test apps/gui/tests/*.test.ts"}}');
		writeFileSync(manifest, "{}");
		deepStrictEqual(check(content.replace("`tests/*.test.ts`", "`apps/gui/tests/*.test.ts`")), {
			ok: true,
			reasons: [],
			dependencies: ["apps/gui/tests/view.test.ts"],
		});
		writeFileSync(manifest, "invalid json");
		deepStrictEqual(check(content), { ok: true, reasons: [], dependencies: ["apps/gui/tests/view.test.ts"] });
	});

	it("deduplicates declared aliases by their verified canonical file", () => {
		symlinkSync(join(root, "src/main.ts"), join(root, "src/alias.ts"));
		deepStrictEqual(check("---\nsources: [src/main.ts, src/alias.ts]\n---\nSee `main.ts:1` and `alias.ts:2`."), {
			ok: true,
			reasons: [],
			dependencies: ["src/main.ts"],
			resolvedCitations: { "main.ts:1": "src/main.ts:1", "alias.ts:2": "src/main.ts:2" },
		});
	});

	it("rejects empty, metadata-only, headings-only and comments-only bodies", () => {
		for (const body of ["", "# Heading", "<!-- placeholder -->", "# Heading\n\n<!-- placeholder -->"]) {
			const result = check(page("src/main.ts", body));
			strictEqual(result.ok, false);
			match(result.reasons.join(" "), /nonempty page body/);
		}
		strictEqual(check("This page has no source evidence.").ok, false);
	});

	it("rejects every unresolved authored source/test before metadata repair can discard it", () => {
		const content = "---\nsources: [src/main.ts, src/invented.ts]\ntests: [tests/invented.test.ts]\n---\nBody.";
		const result = check(content);
		strictEqual(result.ok, false);
		match(result.reasons.join(" "), /src\/invented.ts/);
		match(result.reasons.join(" "), /tests\/invented.test.ts/);
		strictEqual(check(page("src/main.ts", "See `other/invented.py:2` or `missing.py`.")).ok, false);
	});

	it("rejects malformed metadata instead of certifying the parser's fallback", () => {
		for (const block of [
			"sources: src/main.ts",
			"tests: [123]",
			"sources: [",
			"sources: []\nsources: []",
			"- src/main.ts",
		]) {
			strictEqual(check(`---\n${block}\n---\nSee \`src/main.ts\`.`).ok, false);
		}
		strictEqual(check("---\nsources: [src/main.ts]\nSee `src/main.ts`.").ok, false);
	});

	it("keeps frontmatter references compatible with assembly resolution", () => {
		strictEqual(check(page("src/main.ts:1")).ok, false);
	});

	it("names the received type when source or test frontmatter is not a path list", () => {
		for (const field of ["sources", "tests"]) {
			for (const [value, received] of [
				["null", "null"],
				["src/main.ts", "string"],
				["123", "number"],
				["{}", "object"],
				["[src/main.ts, null]", "array with invalid entries"],
			]) {
				const result = check(`---\n${field}: ${value}\n---\nSee \`src/main.ts\`.`);
				strictEqual(result.ok, false);
				deepStrictEqual(result.reasons, [
					`Repair frontmatter ${field}: use a list of nonempty repository-relative file paths; received ${received}.`,
				]);
			}
		}
	});

	it("checks inclusive line bounds, zero, reversed, malformed and absent final-newline cases", () => {
		for (const ref of [
			"src/main.ts:0",
			"src/main.ts:4",
			"src/main.ts:3-2",
			"src/main.ts:2-4",
			"src/main.ts#L1-L4",
			"src/main.ts:-2",
			"src/main.ts:1-",
			"src/main.ts:9007199254740993",
		]) {
			strictEqual(check(page("src/main.ts", `See \`${ref}\`.`)).ok, false, ref);
		}
		writeFileSync(join(root, "src/main.ts"), "first\nsecond");
		strictEqual(check(page("src/main.ts", "See `src/main.ts:2:main`.")).ok, true);
		strictEqual(check(page("src/main.ts", "See `src/main.ts#L2-L3`.")).ok, false);
		writeFileSync(join(root, "src/main.ts"), "");
		strictEqual(check(page("src/main.ts", "See `src/main.ts:1`.")).ok, false);
	});

	it("rejects traversal, absolute paths, directories and symlink escapes but permits internal aliases", () => {
		writeFileSync(join(sandbox, "outside.ts"), "outside\n");
		symlinkSync(join(sandbox, "outside.ts"), join(root, "src/escape.ts"));
		symlinkSync(sandbox, join(root, "external"));
		symlinkSync(join(root, "src/main.ts"), join(root, "src/alias.ts"));
		for (const ref of ["../outside.ts", join(sandbox, "outside.ts"), "src/escape.ts", "external/outside.ts", "src"]) {
			strictEqual(check(page(ref)).ok, false, ref);
		}
		strictEqual(check(page("src/main.ts", "See `../outside.ts:1`.")).ok, false);
		strictEqual(check(page("src/alias.ts", "See `src/alias.ts:1`.")).ok, true);
	});

	it("does not interpret commands, config keys, versions, decision refs, fences or wiki links as evidence", () => {
		const prose =
			"Run `npm test -- src/missing.ts`; set `cache.enabled`; version `1.2.3`; decision `set/key`; [next](missing.md); `https://host/missing.ts`.\n\n```ts\nconst example = `src/example.ts`;\n```";
		strictEqual(check(page("src/main.ts", prose)).ok, true);
		strictEqual(check(prose).ok, false);
	});

	it("fails closed on unavailable roots and bounds retry reasons and IO", () => {
		const content = page("src/main.ts");
		rmSync(root, { recursive: true });
		strictEqual(check(content).ok, false);
		mkdirSync(root);
		const refs = Array.from({ length: 20 }, (_, i) => `missing-${i}.ts`);
		const result = check(`---\nsources: ${JSON.stringify(refs)}\n---\nBody.`);
		strictEqual(result.reasons.length, 8);
		strictEqual(
			result.reasons.every((reason) => reason.length <= 300),
			true,
		);
		const oversized = check("x".repeat(2 * 1024 * 1024 + 1));
		strictEqual(oversized.ok, false);
		deepStrictEqual(oversized.resolvedDependencies, []);
		deepStrictEqual(oversized.allReasons, oversized.reasons);
		strictEqual(
			check(`---\nsources: ${JSON.stringify(Array.from({ length: 513 }, (_, i) => `f${i}.ts`))}\n---\nBody.`).ok,
			false,
		);
		writeFileSync(join(root, "large.ts"), "");
		truncateSync(join(root, "large.ts"), 4 * 1024 * 1024 + 1);
		match(check("See `large.ts:1`.").reasons.join(" "), /exceeds 4 MiB/);
	});
});
