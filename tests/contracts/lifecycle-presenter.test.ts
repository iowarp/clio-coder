import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { createLifecyclePresenter, formatBytes, measurePath, shortenPath } from "../../src/cli/lifecycle-presenter.js";

/**
 * Drop SGR escapes so a rail assertion compares glyphs, not colors. A fresh
 * regex per call: a shared `/g` one carries `lastIndex` between tests.
 */
function stripAnsi(text: string): string {
	return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu"), "");
}

/** Collect everything a presenter writes, so a test can assert the whole transcript. */
function capture(): { stream: PassThrough; text: () => string } {
	const stream = new PassThrough();
	let captured = "";
	stream.on("data", (chunk) => {
		captured += chunk.toString("utf8");
	});
	return { stream, text: () => captured };
}

describe("contracts/lifecycle-presenter", () => {
	it("formats byte sizes with one decimal above the byte range", () => {
		strictEqual(formatBytes(0), "0 B");
		strictEqual(formatBytes(512), "512 B");
		strictEqual(formatBytes(1024), "1.0 KB");
		strictEqual(formatBytes(12888), "12.6 KB");
		strictEqual(formatBytes(1048576), "1.0 MB");
		strictEqual(formatBytes(21181235), "20.2 MB");
		strictEqual(formatBytes(4509715660), "4.2 GB");
	});

	it("shortens home directory paths to tilde notation", () => {
		const fakeHome = "/user/home/tester";
		strictEqual(shortenPath("/user/home/tester/.config/clio-coder", fakeHome), "~/.config/clio-coder");
		strictEqual(shortenPath("/user/home/tester", fakeHome), "~");
		strictEqual(shortenPath("/var/log/clio.log", fakeHome), "/var/log/clio.log");
	});

	it("measures files, directories, and absent entries", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "presenter-measure-"));
		try {
			writeFileSync(join(tempDir, "fileA.txt"), "1234567890", "utf8");
			mkdirSync(join(tempDir, "nested"));
			writeFileSync(join(tempDir, "nested", "fileB.txt"), "12345", "utf8");

			const measuredFile = measurePath(join(tempDir, "fileA.txt"));
			strictEqual(measuredFile.exists, true);
			strictEqual(measuredFile.isDirectory, false);
			strictEqual(measuredFile.bytes, 10);

			const measuredDir = measurePath(tempDir);
			strictEqual(measuredDir.exists, true);
			strictEqual(measuredDir.isDirectory, true);
			strictEqual(measuredDir.bytes, 15, "the walk descends into real subdirectories");

			const absent = measurePath(join(tempDir, "nonexistent"));
			strictEqual(absent.exists, false);
			strictEqual(absent.bytes, 0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("counts a symlinked subdirectory as the link and never descends through it", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "presenter-symlink-"));
		try {
			const outside = join(tempDir, "outside");
			mkdirSync(outside);
			writeFileSync(join(outside, "big.bin"), "x".repeat(4096), "utf8");
			const root = join(tempDir, "root");
			mkdirSync(root);
			writeFileSync(join(root, "own.txt"), "1234567890", "utf8");
			symlinkSync(outside, join(root, "linked"));

			// A root that links out to a shared tree reports its own footprint plus
			// the link inode, never the tree behind it. The alternative bills the
			// operator for bytes the delete would not free, and a link back into
			// the root would make the walk loop.
			const rootBytes = measurePath(root).bytes;
			strictEqual(rootBytes, 10 + lstatSync(join(root, "linked")).size);
			ok(rootBytes < 4096, `the 4 KB behind the symlink must not be counted, got ${rootBytes}`);

			const link = measurePath(join(root, "linked"));
			strictEqual(link.exists, true);
			strictEqual(link.isSymbolicLink, true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("renders plain text with no rail, no ANSI, and the same facts as the rail", () => {
		const { stream, text } = capture();
		const presenter = createLifecyclePresenter({ plain: true, stream, columns: 100 });

		presenter.header("Uninstall Clio Coder", "uninstall");
		presenter.step("Installation method: npm global");
		presenter.listItems("The following will be removed", [
			{ label: "Config", path: "/x/config", bytes: 1024, status: "remove" },
			{ label: "Data", path: "/x/data", bytes: 2048, status: "keep", detail: "kept by --keep-data" },
			{ label: "State", path: "/x/state", bytes: 0, status: "absent" },
			{ label: "Shell config", path: "/x/.bashrc", status: "skip", detail: "edit it by hand" },
		]);
		presenter.completedStep("Removed Config");
		presenter.commandAdvice("To remove the launcher, run:", "rm /usr/local/bin/clio-coder");
		presenter.message("Thank you for using Clio Coder.");
		presenter.done("Done");

		const out = text();
		strictEqual(stripAnsi(out), out, "plain-text output must carry no ANSI escapes");
		for (const glyph of ["┌", "│", "└", "●", "▲", "◆", "◇"]) {
			ok(!out.includes(glyph), `plain-text output must carry no rail glyph (${glyph})`);
		}
		ok(out.includes("Uninstall Clio Coder"));
		ok(out.includes("  Installation method: npm global"));
		ok(out.includes("  The following will be removed:"));
		ok(out.includes("    ✓ Config: /x/config (1.0 KB)"));
		ok(out.includes("    – Data: /x/data (2.0 KB) (kept by --keep-data)"));
		ok(out.includes("    – State: /x/state (absent)"), "an absent row shows no size");
		ok(out.includes("    – Shell config: /x/.bashrc (edit it by hand)"));
		ok(out.includes("  ✓ Removed Config"));
		ok(out.includes("    rm /usr/local/bin/clio-coder"));
		ok(out.includes("Thank you for using Clio Coder."));
		match(out, /\nDone\n$/u);
	});

	it("separates unlike blocks with exactly one rail line and keeps like blocks together", () => {
		const { stream, text } = capture();
		const presenter = createLifecyclePresenter({ plain: false, stream, columns: 100 });

		presenter.header("Upgrade", "upgrade");
		presenter.step("Installation method: source checkout");
		presenter.step("Current version: 0.4.2");
		presenter.warn("Already on 0.4.2");
		presenter.done("Done");

		const lines = stripAnsi(text()).split("\n");
		deepStrictEqual(lines, [
			"",
			"┌  Upgrade",
			"│",
			"●  Installation method: source checkout",
			"●  Current version: 0.4.2",
			"│",
			"▲  Already on 0.4.2",
			"│",
			"└  Done",
			"",
			"",
		]);
	});

	it("wraps rail prose so a narrow terminal keeps its rail", () => {
		const { stream, text } = capture();
		const presenter = createLifecyclePresenter({ plain: false, stream, columns: 40 });
		presenter.header("Reset Clio Coder", "reset");
		presenter.note("State holds every session transcript and the audit trail beside it.");

		const lines = stripAnsi(text())
			.split("\n")
			.filter((line) => line.length > 0);
		const prose = lines.filter((line) => line.startsWith("│  "));
		ok(prose.length > 1, "the long note must wrap onto more than one line");
		for (const line of prose) ok(line.length <= 40, `wrapped line exceeded the terminal: ${JSON.stringify(line)}`);
	});

	it("emits one JSON document that includes advice recorded after a failure", () => {
		const { stream, text } = capture();
		const presenter = createLifecyclePresenter({ json: true, stream });

		presenter.header("Reset Clio Coder", "reset");
		presenter.step("Inspecting roots");
		presenter.listItems("Roots", [{ label: "Config", path: "/x/config", bytes: 4096, status: "remove" }]);
		presenter.fail("reset did not clear everything", "EACCES: permission denied");
		presenter.commandAdvice("Fix the permission, then run:", "clio-coder reset --all --force");
		presenter.finish();
		// A second close must not put another document on stdout.
		presenter.finish();

		const parsed = JSON.parse(text());
		strictEqual(parsed.command, "reset");
		strictEqual(parsed.status, "error");
		strictEqual(parsed.items.length, 1);
		strictEqual(parsed.errors[0], "reset did not clear everything: EACCES: permission denied");
		strictEqual(parsed.advice[0].lead, "Fix the permission, then run:");
		strictEqual(parsed.advice[0].command, "clio-coder reset --all --force");
	});

	it("writes no rail to stdout in json mode", () => {
		const { stream, text } = capture();
		const presenter = createLifecyclePresenter({ json: true, stream });
		presenter.header("Upgrade", "upgrade");
		presenter.step("Current version: 0.4.2");
		presenter.warn("Dry run: no changes made");
		presenter.done("Done");
		const out = text();
		strictEqual(out.trimEnd().startsWith("{"), true);
		strictEqual(JSON.parse(out).summary, "Done");
	});

	it("reads a confirmation from the input stream", async () => {
		const inStream = new PassThrough();
		const outStream = new PassThrough();
		const presenter = createLifecyclePresenter({ plain: true, inputStream: inStream, stream: outStream });

		const promise = presenter.confirm("Proceed with uninstall?", false);
		inStream.write("y\n");
		strictEqual(await promise, true);
	});

	it("treats a closed stdin as a refusal rather than a confirmation", async () => {
		const inStream = new PassThrough();
		const outStream = new PassThrough();
		const presenter = createLifecyclePresenter({ plain: true, inputStream: inStream, stream: outStream });

		const promise = presenter.confirm("Proceed with uninstall?", false);
		inStream.end();
		strictEqual(await promise, false);
	});
});
