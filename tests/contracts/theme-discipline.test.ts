import { strictEqual } from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Color discipline is enforced by scanning the interactive source as plain
// text. src/interactive/theme is the single sanctioned home for raw SGR
// sequences and color values, so it is excluded from the scan; every other
// module must reach color exclusively through the theme tokens.
const INTERACTIVE_ROOT = fileURLToPath(new URL("../../src/interactive", import.meta.url));

/**
 * Recursively collect every `*.ts` file under src/interactive except the
 * `theme/` directory. The scan reads source text with readFileSync and never
 * imports the modules, so it stays fast and free of side effects.
 */
function collectSourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "theme") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectSourceFiles(full));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
	}
	return files;
}

type SourceFile = { path: string; text: string };

function loadSources(): SourceFile[] {
	return collectSourceFiles(INTERACTIVE_ROOT)
		.sort()
		.map((path) => ({ path: relative(INTERACTIVE_ROOT, path), text: readFileSync(path, "utf8") }));
}

// An SGR color escape is an ESC introducer followed by "[", any run of digits
// and semicolons, then the "m" terminator. The ESC introducer is matched in
// three spellings: the raw control byte (built from a char code so the pattern
// carries no control-character literal), the two-character hex source spelling,
// and the six-character unicode source spelling. Input-decode literals like the
// page-up key end in "~" rather than "m", so they never match and stay legal.
const ESC = String.fromCharCode(27);
const SGR_ESCAPE = new RegExp(`(?:${ESC}|\\\\x1b|\\\\u001b)\\[[0-9;]*m`);

// Truecolor and 256-color foreground/background introducers. Catching these
// fragments flags a color sequence regardless of how the ESC prefix is spelled.
const SGR_COLOR_FRAGMENT = /38;2;|48;2;|38;5;|48;5;/;

// Six-digit hex colors like #46e5d0.
const HEX_COLOR = /#[0-9a-fA-F]{6}\b/;

describe("contracts/theme-discipline", () => {
	const sources = loadSources();

	it("scans a non-empty set of interactive modules outside theme/", () => {
		strictEqual(sources.length > 0, true, "expected to find interactive source files to scan");
	});

	it("contains no raw SGR color escape sequences outside theme/", () => {
		const offenders = sources.filter((file) => SGR_ESCAPE.test(file.text)).map((file) => file.path);
		strictEqual(offenders.length, 0, `raw SGR escape sequences found in: ${offenders.join(", ")}`);
	});

	it("contains no truecolor or xterm color fragments outside theme/", () => {
		const offenders = sources.filter((file) => SGR_COLOR_FRAGMENT.test(file.text)).map((file) => file.path);
		strictEqual(offenders.length, 0, `SGR color fragments (38;2;/48;2;/38;5;/48;5;) found in: ${offenders.join(", ")}`);
	});

	it("contains no #rrggbb hex colors outside theme/", () => {
		const offenders = sources.filter((file) => HEX_COLOR.test(file.text)).map((file) => file.path);
		strictEqual(offenders.length, 0, `hex colors found in: ${offenders.join(", ")}`);
	});

	it("leaves input-decode escape literals legal because they do not end in m", () => {
		// A representative input-decode literal must pass the SGR escape guard so
		// the discipline scan never forces key handlers to launder terminal keys
		// through the theme.
		strictEqual(SGR_ESCAPE.test('data === "\\x1b[5~"'), false);
		strictEqual(SGR_ESCAPE.test('data === "\\x1b[6~"'), false);
		// A genuine color escape still trips the guard.
		strictEqual(SGR_ESCAPE.test('"\\x1b[38;2;70;229;208m"'), true);
	});
});
