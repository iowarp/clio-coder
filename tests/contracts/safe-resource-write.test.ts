import { ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { safeResourceWrite } from "../../src/core/safe-resource-write.js";

describe("contracts/safe-resource-write", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(path.join(tmpdir(), "clio-safe-resource-write-"));
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("keeps the target unchanged until rename and removes the temp path after success", () => {
		const target = path.join(scratch, "nested", "resource.txt");
		safeResourceWrite(target, "old\n", { encoding: "utf8" });
		let observedTemp = "";
		let sawBeforeRename = false;

		const result = safeResourceWrite(target, "new\n", {
			encoding: "utf8",
			beforeRename: ({ tempPath }) => {
				observedTemp = tempPath;
				sawBeforeRename = true;
				ok(path.dirname(tempPath) === path.dirname(target));
				ok(existsSync(tempPath));
				strictEqual(readFileSync(tempPath, "utf8"), "new\n");
				strictEqual(readFileSync(target, "utf8"), "old\n");
			},
		});

		strictEqual(sawBeforeRename, true);
		strictEqual(result.tempPath, observedTemp);
		strictEqual(readFileSync(target, "utf8"), "new\n");
		strictEqual(existsSync(result.tempPath), false);
	});

	it("removes the temp path and preserves the target when rename is blocked", () => {
		const target = path.join(scratch, "resource.txt");
		writeFileSync(target, "old\n", "utf8");
		let tempPath = "";

		throws(
			() =>
				safeResourceWrite(target, "new\n", {
					encoding: "utf8",
					beforeRename: (context) => {
						tempPath = context.tempPath;
						throw new Error("stop before rename");
					},
				}),
			/stop before rename/,
		);

		strictEqual(readFileSync(target, "utf8"), "old\n");
		strictEqual(existsSync(tempPath), false);
	});

	it("creates a bak file before overwriting an existing target", () => {
		const target = path.join(scratch, "resource.txt");
		writeFileSync(target, "old\n", "utf8");

		const result = safeResourceWrite(target, "new\n", { backup: true, encoding: "utf8" });

		strictEqual(result.backupPath, `${target}.bak`);
		strictEqual(readFileSync(target, "utf8"), "new\n");
		strictEqual(readFileSync(`${target}.bak`, "utf8"), "old\n");
	});
});
