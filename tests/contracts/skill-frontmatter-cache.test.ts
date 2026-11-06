import { deepEqual, equal, ok } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { scratchClioEnvVars } from "../harness/scratch-env.js";

// Parsed SKILL.md frontmatter is cached under the cache root by path, mtime and
// size. A hit must never outlive an edit, a deletion or a Clio version change.
const home = mkdtempSync(join(tmpdir(), "clio-coder-skill-fm-cache-"));
Object.assign(process.env, scratchClioEnvVars(home), { HOME: home });
const { resetXdgCache, clioCacheDir, clioConfigDir } = await import("../../src/core/xdg.js");
resetXdgCache();
const { readClioVersion } = await import("../../src/core/package-root.js");
const { loadSkills } = await import("../../src/domains/resources/skills/loader.js");
after(() => rmSync(home, { recursive: true, force: true }));

const skillFile = join(clioConfigDir(), "skills", "probe", "SKILL.md");
const cacheFile = (): string => join(clioCacheDir(), "skill-frontmatter.json");
const skillText = (description: string): string => `---\nname: probe\ndescription: ${description}\n---\nBody.\n`;
const description = (): string | undefined =>
	loadSkills({ cwd: home }).items.find((skill) => skill.name === "probe")?.description;

/** Rewrite the file at the same size and restore its mtime, so only the text differs. */
function rewriteInPlace(text: string): void {
	const before = statSync(skillFile);
	writeFileSync(skillFile, text);
	utimesSync(skillFile, before.atime, before.mtime);
	equal(statSync(skillFile).size, before.size);
}

function cacheWith(clioVersion: string, json: Record<string, unknown>): void {
	const stat = statSync(skillFile);
	const text = "name: probe\ndescription: Original one.";
	const entries = { [skillFile]: { mtimeMs: stat.mtimeMs, size: stat.size, text, json: JSON.stringify(json) } };
	writeFileSync(cacheFile(), JSON.stringify({ format: 1, clioVersion, entries }));
}

describe("skill frontmatter cache", () => {
	it("answers from the cache only while path, mtime, size, text and Clio version all match", () => {
		mkdirSync(join(clioConfigDir(), "skills", "probe"), { recursive: true });
		writeFileSync(skillFile, skillText("Original one."));
		equal(description(), "Original one.");
		ok(existsSync(cacheFile()), "a parse is persisted");

		// A planted entry proves a later process reads the cache instead of parsing.
		cacheWith(readClioVersion(), { name: "probe", description: "From cache." });
		equal(description(), "From cache.");
		cacheWith("0.0.0-other", { name: "probe", description: "From cache." });
		equal(description(), "Original one.", "another Clio version's cache is discarded");

		rewriteInPlace(skillText("Replaced one."));
		equal(description(), "Replaced one.", "an edit at the same size and mtime reparses");

		rmSync(skillFile);
		equal(description(), undefined);
		const persisted = JSON.parse(readFileSync(cacheFile(), "utf8")) as { entries: Record<string, unknown> };
		deepEqual(Object.keys(persisted.entries), [], "a deleted skill's entry is dropped");
	});

	it("reads a damaged cache file or entry as a miss and parses the source", () => {
		mkdirSync(join(clioConfigDir(), "skills", "probe"), { recursive: true });
		writeFileSync(skillFile, skillText("Original one."));
		for (const body of ["null", "[]", `{"format":1,"clioVersion":${JSON.stringify(readClioVersion())},"entries":null}`]) {
			writeFileSync(cacheFile(), body);
			equal(description(), "Original one.", `cache body ${body}`);
		}

		const stat = statSync(skillFile);
		const text = "name: probe\ndescription: Original one.";
		const entries = { [skillFile]: { mtimeMs: stat.mtimeMs, size: stat.size, text, json: "{not json" } };
		writeFileSync(cacheFile(), JSON.stringify({ format: 1, clioVersion: readClioVersion(), entries }));
		equal(description(), "Original one.", "an entry whose JSON does not parse falls back to the source");
		const persisted = JSON.parse(readFileSync(cacheFile(), "utf8")) as { entries: Record<string, { json: string }> };
		deepEqual(JSON.parse(persisted.entries[skillFile]?.json ?? "null"), { name: "probe", description: "Original one." });
		equal(description(), "Original one.", "the replaced entry answers the next load");
	});

});
