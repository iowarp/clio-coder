import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { validateWikiPageEvidence } from "../../src/domains/context/wiki/evidence.js";

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
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

describe("wiki mechanical evidence gate", () => {
	it("resolves a real relative import from a declared source without accepting escaping or invented imports", () => {
		writeFileSync(join(root, "tests/main.test.ts"), 'import { main } from "../src/main.js";\n');
		const content = "---\nsources: [src/main.ts]\ntests: [tests/main.test.ts]\n---\nThe test imports `../src/main.js`.";
		deepStrictEqual(check(content), { ok: true, reasons: [], dependencies: ["src/main.ts", "tests/main.test.ts"] });
		strictEqual(check(content.replace("`../src/main.js`", "`../src/invented.js`")).ok, false);
		writeFileSync(join(sandbox, "outside.ts"), "outside\n");
		writeFileSync(join(root, "tests/main.test.ts"), 'import "../../outside.ts";\n');
		strictEqual(check(content.replace("`../src/main.js`", "`../../outside.ts`")).ok, false);
	});

	it("accepts a test selector only when a package command declares it and a verified test matches", () => {
		writeFileSync(join(root, "package.json"), '{"scripts":{"test":"node --test tests/*.test.ts"}}');
		const content = "---\ntests: [tests/main.test.ts]\n---\nCI discovers `tests/*.test.ts`.";
		deepStrictEqual(check(content), { ok: true, reasons: [], dependencies: ["package.json", "tests/main.test.ts"] });
		strictEqual(check(content.replace("tests/*.test.ts", "tests/missing-*.test.ts")).ok, false);
		strictEqual(check("---\ntests: [tests/*.test.ts]\n---\nA page.").ok, false);
		writeFileSync(join(root, "package.json"), "{}");
		strictEqual(check(content).ok, false);
	});

	it("accepts readable pages without a mandatory template and resolves JS source aliases", () => {
		deepStrictEqual(check(page("src/main.js", "See `src/main.js:1-3` and `tests/main.test.ts#L1`.")), {
			ok: true,
			reasons: [],
			dependencies: ["src/main.ts", "tests/main.test.ts"],
		});
		strictEqual(check("See `package.json:1` and `Makefile`. No frontmatter is required.").ok, true);
	});

	it("returns canonical body-only evidence for source checkpoints and no dependencies on failure", () => {
		symlinkSync(join(root, "src/main.ts"), join(root, "src/alias.ts"));
		deepStrictEqual(check("See `src/main.js:1`, `src/alias.ts`, and `package.json`."), {
			ok: true,
			reasons: [],
			dependencies: ["package.json", "src/main.ts"],
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
			{ ok: true, reasons: [], dependencies: ["src/main.ts", "tests/main.test.ts"] },
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
			{ ok: true, reasons: [], dependencies: ["slugify/__init__.py", "slugify/__version__.py", "slugify/special.py"] },
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
			});
		}
		rmSync(join(root, "src/nested/main.ts"));
		deepStrictEqual(check(page("package.json", "See `main.js`.")), {
			ok: true,
			reasons: [],
			dependencies: ["package.json", "src/main.ts"],
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
		writeFileSync(join(root, "src/main.ts"), 'const config = "settings.yaml"; const example = "[project]/src/a.ts";\n');
		const content = page("src/main.ts", "The names are `settings.yaml` and `[project]/src/a.ts`.");
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
		strictEqual(check(content.replace("`tests/*.test.ts`", "`apps/gui/tests/*.test.ts`")).ok, false);
		writeFileSync(manifest, "invalid json");
		strictEqual(check(content).ok, false);
	});

	it("deduplicates declared aliases by their verified canonical file", () => {
		symlinkSync(join(root, "src/main.ts"), join(root, "src/alias.ts"));
		deepStrictEqual(check("---\nsources: [src/main.ts, src/alias.ts]\n---\nSee `main.ts:1` and `alias.ts:2`."), {
			ok: true,
			reasons: [],
			dependencies: ["src/main.ts"],
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
		strictEqual(check("x".repeat(2 * 1024 * 1024 + 1)).ok, false);
		strictEqual(
			check(`---\nsources: ${JSON.stringify(Array.from({ length: 513 }, (_, i) => `f${i}.ts`))}\n---\nBody.`).ok,
			false,
		);
		writeFileSync(join(root, "large.ts"), "");
		truncateSync(join(root, "large.ts"), 4 * 1024 * 1024 + 1);
		match(check("See `large.ts:1`.").reasons.join(" "), /exceeds 4 MiB/);
	});
});
