import { ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolvePackageRoot } from "../../src/core/package-root.js";

/**
 * Every place Clio hands a URL to the platform's browser opener.
 *
 * These URLs are provider-supplied: OAuth authorize links, console links, and
 * device-code pages come off the wire. Building a command string and escaping
 * only double quotes leaves backticks and `$(...)` live inside the quoted
 * argument, so the shell evaluates them before the browser ever sees the URL.
 * Passing an argv array removes the shell from the path entirely.
 *
 * This is a source-level check rather than a behavioral one because the defect
 * is a shape: any future opener that reaches for `exec` with a template string
 * reintroduces it, and no runtime assertion catches that until someone ships a
 * hostile URL.
 */
const OPENER_SITES: ReadonlyArray<string> = ["src/interactive/index.ts", "src/cli/docs.ts"];

const OPENERS = /\b(xdg-open|start)\b/;

describe("contracts/external-url-opener", () => {
	it("never routes a URL through a shell", () => {
		for (const relative of OPENER_SITES) {
			const source = readFileSync(join(resolvePackageRoot(), relative), "utf8");
			const lines = source.split("\n");
			for (const [index, line] of lines.entries()) {
				strictEqual(
					/\bexec(?:Sync)?\s*\(/.test(line),
					false,
					`${relative}:${index + 1} runs a shell in a file that opens URLs: ${line.trim()}`,
				);
			}
		}
	});

	it("spawns the opener with the url as its own argument", () => {
		for (const relative of OPENER_SITES) {
			const source = readFileSync(join(resolvePackageRoot(), relative), "utf8");
			if (!OPENERS.test(source)) continue;
			ok(source.includes("spawn("), `${relative} names a platform opener but never spawns it with an argv array`);
		}
	});

	/**
	 * `start` is a cmd builtin, not an executable, so spawning it directly fails
	 * on Windows. Its first quoted argument is the window title, which is why the
	 * empty string has to be there before the URL.
	 */
	it("routes the windows opener through cmd with the empty title argument", () => {
		for (const relative of OPENER_SITES) {
			const source = readFileSync(join(resolvePackageRoot(), relative), "utf8");
			if (!source.includes('"win32"')) continue;
			ok(
				/\["\/c",\s*"start",\s*""/.test(source),
				`${relative} must call cmd /c start "" <url> so the URL is not read as a window title`,
			);
		}
	});
});
