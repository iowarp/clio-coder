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

/** The default bin dir the installer links into, read from the installer itself. */
function installerBinDir(): string {
	const script = readFileSync("scripts/install-local.sh", "utf8");
	const binDir = script.match(/^bin_dir=.*\$\{CLIO_BIN_DIR:-(?<fallback>[^}]+)\}/mu)?.groups?.fallback;
	ok(binDir, "the installer still has a default bin dir");
	return binDir;
}

function installerExportLine(): string {
	const script = readFileSync("scripts/install-local.sh", "utf8");
	// printf '... export PATH="%s:$PATH"\n' "$bin_dir"
	const template = script.match(/export PATH="%s:\$PATH"/);
	ok(template, "the installer still prints an export PATH line");
	return `export PATH="${installerBinDir()}:$PATH"`;
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
		const version = block.findIndex((line) => line.includes("--version"));
		ok(version >= 0, "the block still verifies the install");
		strictEqual(exported < version, true, "the export has to come before the command that resolves through PATH");
	});

	/**
	 * The block cloned the default branch and never left it, so a stranger
	 * following the README installed whatever was on main that day rather than
	 * the release the rest of the page documents.
	 */
	it("pins the clone to the release this README describes", () => {
		const version = JSON.parse(readFileSync("package.json", "utf8")).version as string;
		const clone = readmeInstallBlock().find((line) => line.includes("git clone"));
		ok(clone, "the block still clones the repository");
		ok(
			clone?.includes(`--branch v${version}`),
			`the clone must pin v${version}, the version package.json declares: ${clone}`,
		);
	});

	/**
	 * A bare `clio` resolves through PATH and can answer for an older install
	 * earlier on it, which verifies that one rather than the one just installed.
	 * The installer warns about exactly that shadowing; the README's own
	 * verification step must not walk into it.
	 */
	it("verifies with the launcher's own path, not a bare clio", () => {
		const block = readmeInstallBlock();
		const verify = block.find((line) => line.includes("--version"));
		ok(verify, "the block still verifies the install");
		ok(
			verify?.includes("/clio") && !/^clio --version/u.test(verify.trim()),
			`verification must name the installed launcher by path: ${verify}`,
		);
		const binDir = installerBinDir();
		ok(verify?.includes(binDir), `it must be the path the installer links (${binDir}): ${verify}`);
	});
});
