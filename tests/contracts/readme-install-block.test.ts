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
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

/**
 * The Install section carries two shell blocks. The npm block comes first
 * because that is the path most readers take, so a test that wants the
 * from-source steps has to anchor on its own prose line rather than on
 * whichever block happens to be nearest the heading.
 */
function readmeBashBlockAfter(marker: string): ReadonlyArray<string> {
	const readme = readFileSync("README.md", "utf8").split(/\r?\n/);
	const heading = readme.indexOf("## Install");
	ok(heading >= 0, "README has an Install section");
	const anchor = readme.findIndex((line, index) => index > heading && line.startsWith(marker));
	ok(anchor > heading, `the Install section still introduces its steps with ${JSON.stringify(marker)}`);
	const open = readme.indexOf("```bash", anchor);
	ok(open > anchor, `${JSON.stringify(marker)} opens a shell block`);
	const close = readme.indexOf("```", open + 1);
	ok(close > open, "the shell block is closed");
	return readme.slice(open + 1, close);
}

/** The from-source steps: clone, install, PATH, verify. */
function readmeInstallBlock(): ReadonlyArray<string> {
	return readmeBashBlockAfter("From source");
}

/** The published-package steps. */
function readmeNpmBlock(): ReadonlyArray<string> {
	return readmeBashBlockAfter("From npm");
}

describe("contracts/readme install block", () => {
	/**
	 * The npm block is the first thing a reader runs, so it has to install the
	 * package this repository actually publishes rather than a name that only
	 * resembles it.
	 */
	it("installs the published package name in the npm block", () => {
		const name = JSON.parse(readFileSync("package.json", "utf8")).name as string;
		const install = readmeNpmBlock().find((line) => line.includes("npm install"));
		ok(install, "the npm block still installs the package");
		ok(install?.includes(name), `the npm block must install ${name}: ${install}`);
	});

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

	/**
	 * The README told the reader to keep using the bare name once `clio
	 * --version` and the launcher's own `--version` agreed. Two installs of the
	 * same release print the same version, so that check passes while shadowed:
	 * it compares the answer instead of asking who answered.
	 */
	it("resolves the bare name by path rather than comparing versions", () => {
		const readme = readFileSync("README.md", "utf8");
		const section = readme.slice(readme.indexOf("## Install"), readme.indexOf("To remove it"));
		ok(section.includes("command -v clio"), "the README asks which file the bare name reaches");
		ok(
			!/`clio --version` and\s+`[^`]*\/clio" --version` agree/u.test(section),
			"and no longer treats agreeing versions as proof the name resolves to this install",
		);
	});

	/**
	 * The paragraph above promises the installer warns about a shadowing clio.
	 * It is a promise about a program, so it is checked by running the program:
	 * a stub `clio` earlier on PATH, an install into a bin dir that is not, and
	 * the dry run that changes nothing.
	 */
	it("backs the shadowing claim: the installer names the other clio on PATH", () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-install-shadow-"));
		try {
			const shadowDir = join(scratch, "shadow");
			const binDir = join(scratch, "bin");
			mkdirSync(shadowDir);
			mkdirSync(binDir);
			const shadow = join(shadowDir, "clio");
			writeFileSync(shadow, '#!/bin/sh\necho "clio 0.0.0-other"\n');
			chmodSync(shadow, 0o755);

			const run = spawnSync("bash", ["scripts/install-local.sh", "--dry-run", "--skip-deps", "--no-build"], {
				encoding: "utf8",
				env: { ...process.env, PATH: `${shadowDir}:${process.env.PATH ?? ""}`, CLIO_BIN_DIR: binDir },
			});
			strictEqual(run.status, 0, `dry run should succeed: ${run.stderr}`);
			const output = `${run.stdout}${run.stderr}`;
			ok(output.includes(`another clio is on your PATH at ${shadow}`), `installer names it: ${output}`);
			ok(output.includes(`check it with: ${shadow} --version`), `and says how to identify it: ${output}`);

			// The same stub, reached through a link into the launcher this run is
			// about, is one installation and must not be reported as two. Comparing
			// the raw paths said it was.
			const linked = join(scratch, "linked");
			mkdirSync(linked);
			symlinkSync(resolve("scripts/install-local.sh"), join(binDir, "clio"));
			symlinkSync(join(binDir, "clio"), join(linked, "clio"));
			const sameInstall = spawnSync("bash", ["scripts/install-local.sh", "--dry-run", "--skip-deps", "--no-build"], {
				encoding: "utf8",
				env: { ...process.env, PATH: `${linked}:${process.env.PATH ?? ""}`, CLIO_BIN_DIR: binDir },
			});
			ok(
				!`${sameInstall.stdout}${sameInstall.stderr}`.includes("another clio is on your PATH"),
				"a name that resolves through to this launcher is not a second installation",
			);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
