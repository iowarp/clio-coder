/**
 * The README install block ran `npm run install:local`, then `hash -r`, then
 * `clio --version`. On a machine where `~/.local/bin` is not on PATH, which is
 * the case the installer itself checks for and warns about, that sequence ends
 * in `clio: command not found` on the last line of the documented install.
 *
 * The installer already prints the line that fixes it. The README has to carry
 * the same line, spelled the same way, or the two drift and the printed advice
 * stops matching the documented steps.
 */
import { ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function installerExportLine(): string {
	const script = readFileSync("scripts/install-local.sh", "utf8");
	// printf '... export PATH="%s:$PATH"\n' "$bin_dir"
	const template = script.match(/export PATH="%s:\$PATH"/);
	ok(template, "the installer still prints an export PATH line");
	const binDir = script.match(/^bin_dir=.*\$\{CLIO_BIN_DIR:-(?<fallback>[^}]+)\}/mu)?.groups?.fallback;
	ok(binDir, "the installer still has a default bin dir");
	return `export PATH="${binDir}:$PATH"`;
}

function readmeInstallBlock(): ReadonlyArray<string> {
	const readme = readFileSync("README.md", "utf8").split(/\r?\n/);
	const heading = readme.indexOf("## Install");
	ok(heading >= 0, "README has an Install section");
	const open = readme.indexOf("```bash", heading);
	ok(open > heading, "the Install section opens a shell block");
	const close = readme.indexOf("```", open + 1);
	ok(close > open, "the shell block is closed");
	return readme.slice(open + 1, close);
}

describe("contracts/readme install block", () => {
	it("carries the export line the installer prints, verbatim", () => {
		const expected = installerExportLine();
		const block = readmeInstallBlock();
		ok(block.includes(expected), `README install block is missing ${JSON.stringify(expected)}: ${JSON.stringify(block)}`);
	});

	it("exports the path before the step that needs it", () => {
		const block = readmeInstallBlock();
		const exported = block.findIndex((line) => line.startsWith("export PATH="));
		const version = block.findIndex((line) => line.includes("clio --version"));
		ok(version >= 0, "the block still verifies the install with clio --version");
		strictEqual(exported < version, true, "the export has to come before the command that resolves through PATH");
	});
});
