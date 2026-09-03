import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { createLifecyclePresenter, formatBytes, measurePath, shortenPath } from "../../src/cli/lifecycle-presenter.js";

describe("contracts/lifecycle-presenter", () => {
	it("formats byte sizes correctly across orders of magnitude", () => {
		strictEqual(formatBytes(0), "0 B");
		strictEqual(formatBytes(512), "512 B");
		strictEqual(formatBytes(1024), "1.00 KB");
		strictEqual(formatBytes(12888), "12.6 KB");
		strictEqual(formatBytes(1048576), "1.00 MB");
		strictEqual(formatBytes(21181235), "20.2 MB");
		strictEqual(formatBytes(1073741824), "1.00 GB");
	});

	it("shortens home directory paths to tilde notation", () => {
		const fakeHome = "/user/home/tester";
		strictEqual(shortenPath("/user/home/tester/.config/clio-coder", fakeHome), "~/.config/clio-coder");
		strictEqual(shortenPath("/user/home/tester", fakeHome), "~");
		strictEqual(shortenPath("/var/log/clio.log", fakeHome), "/var/log/clio.log");
	});

	it("measures path sizes accurately for files, directories, and absent entries", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "presenter-measure-"));
		try {
			const fileA = join(tempDir, "fileA.txt");
			writeFileSync(fileA, "1234567890", "utf8"); // 10 bytes
			const fileB = join(tempDir, "fileB.txt");
			writeFileSync(fileB, "12345", "utf8"); // 5 bytes

			const measuredFile = measurePath(fileA);
			strictEqual(measuredFile.exists, true);
			strictEqual(measuredFile.isDirectory, false);
			strictEqual(measuredFile.bytes, 10);

			const measuredDir = measurePath(tempDir);
			strictEqual(measuredDir.exists, true);
			strictEqual(measuredDir.isDirectory, true);
			strictEqual(measuredDir.bytes, 15);

			const absent = measurePath(join(tempDir, "nonexistent"));
			strictEqual(absent.exists, false);
			strictEqual(absent.bytes, 0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("renders clean plain-text output without ANSI escapes", () => {
		const stream = new PassThrough();
		let captured = "";
		stream.on("data", (chunk) => {
			captured += chunk.toString("utf8");
		});

		const presenter = createLifecyclePresenter({
			plain: true,
			stream,
		});

		presenter.header("Uninstall Clio Coder");
		presenter.step("Installation method: npm global");
		presenter.listItems("The following will be removed", [
			{ label: "Config", path: "/tmp/config", bytes: 1024, status: "remove" },
			{ label: "Data", path: "/tmp/data", bytes: 2048, status: "keep" },
			{ label: "State", path: "/tmp/state", bytes: 0, status: "absent" },
		]);
		presenter.warn("Dry run - no changes made");
		presenter.completedStep("Removed cache");
		presenter.commandAdvice("To remove binary manually", "rm /usr/local/bin/clio-coder");
		presenter.message("Thank you for using Clio Coder!");
		presenter.done("Done");

		ok(!captured.includes("["), "plain-text output must not contain ANSI escape codes");
		ok(captured.includes("=== Uninstall Clio Coder ==="));
		ok(captured.includes("* Installation method: npm global"));
		ok(captured.includes("The following will be removed:"));
		ok(captured.includes("Config: /tmp/config (1.00 KB)"));
		ok(captured.includes("(kept)"));
		ok(captured.includes("(absent)"));
		ok(captured.includes("! Warning: Dry run - no changes made"));
		ok(captured.includes("✓ Removed cache"));
		ok(captured.includes("To remove binary manually"));
		ok(captured.includes("rm /usr/local/bin/clio-coder"));
		ok(captured.includes("Thank you for using Clio Coder!"));
		ok(captured.includes("=== Done ==="));
	});

	it("renders box-drawing rail glyphs in TTY mode", () => {
		const stream = new PassThrough();
		let captured = "";
		stream.on("data", (chunk) => {
			captured += chunk.toString("utf8");
		});

		const presenter = createLifecyclePresenter({
			plain: false,
			stream,
		});

		presenter.header("Upgrade");
		presenter.step("Using method: source checkout");
		presenter.warn("Already current");
		presenter.done("Done");

		ok(captured.includes("┌"), "Header should use top box rail");
		ok(captured.includes("│"), "Rail line should be present");
		ok(captured.includes("●"), "Step glyph should be bullet");
		ok(captured.includes("▲"), "Warning glyph should be triangle");
		ok(captured.includes("└"), "Done should use bottom box rail");
	});

	it("produces valid structured JSON in json mode", () => {
		const stream = new PassThrough();
		let captured = "";
		stream.on("data", (chunk) => {
			captured += chunk.toString("utf8");
		});

		const presenter = createLifecyclePresenter({
			json: true,
			stream,
		});

		presenter.header("Reset", "reset");
		presenter.step("Inspecting roots");
		presenter.listItems("Roots", [{ label: "Config", path: "/test/config", bytes: 4096, status: "remove" }]);
		presenter.warn("Cache was empty");
		presenter.completedStep("Reset complete");
		presenter.done("Reset finished");

		const parsed = JSON.parse(captured);
		strictEqual(parsed.command, "reset");
		strictEqual(parsed.title, "Reset");
		strictEqual(parsed.status, "success");
		strictEqual(parsed.items.length, 1);
		strictEqual(parsed.items[0].label, "Config");
		strictEqual(parsed.warnings[0], "Cache was empty");
		strictEqual(parsed.summary, "Reset finished");
	});

	it("handles confirmation with user input", async () => {
		const inStream = new PassThrough();
		const outStream = new PassThrough();

		const presenter = createLifecyclePresenter({
			plain: true,
			inputStream: inStream,
			stream: outStream,
		});

		const promise = presenter.confirm("Proceed with uninstall?", false);
		inStream.write("y\n");
		const result = await promise;
		strictEqual(result, true);
	});
});
