import { strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sandboxCacheFinding, stateStorageFinding } from "../../src/cli/doctor-state-size.js";
import { holdSandboxCacheLease } from "../../src/core/sandbox/sandbox-cache.js";

describe("doctor state storage", () => {
	it("reads a fresh home without a state root as empty, not broken", () => {
		const root = mkdtempSync(join(tmpdir(), "clio-coder-test-state-size-"));
		try {
			const finding = stateStorageFinding(join(root, "state"));
			strictEqual(finding.ok, true);
			strictEqual(finding.level, undefined);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("warns over the sandbox cache cap, prunes least recently used tool dirs on --fix, and skips while leased", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-coder-test-sandbox-cache-"));
		const fill = (cacheDir: string): void => {
			for (const [name, seconds] of [
				["old", 1_000],
				["mid", 2_000],
				["new", 3_000],
			] as const) {
				mkdirSync(join(cacheDir, name, "sub"), { recursive: true });
				const file = join(cacheDir, name, "sub", "blob");
				writeFileSync(file, Buffer.alloc(1_000));
				for (const path of [file, join(cacheDir, name, "sub"), join(cacheDir, name)]) utimesSync(path, seconds, seconds);
			}
			writeFileSync(join(cacheDir, "top-file"), "x");
		};
		const capGiB = 1_500 / 1024 ** 3;
		try {
			const cacheDir = join(root, "free", "sandbox-cache");
			fill(cacheDir);
			const report = await sandboxCacheFinding({ cacheDir, capGiB });
			strictEqual(report.level, "warn");
			strictEqual(readdirSync(cacheDir).length, 4, "plain doctor removes nothing");
			const fixed = await sandboxCacheFinding({ cacheDir, capGiB, fix: true });
			strictEqual(fixed.level, undefined, fixed.detail);
			strictEqual(fixed.detail.includes("pruned old, mid"), true, fixed.detail);
			strictEqual(readdirSync(cacheDir).sort().join(","), "new,top-file");

			const leasedDir = join(root, "leased", "sandbox-cache");
			fill(leasedDir);
			holdSandboxCacheLease(leasedDir);
			const skipped = await sandboxCacheFinding({ cacheDir: leasedDir, capGiB, fix: true });
			strictEqual(skipped.level, "warn");
			strictEqual(skipped.detail.includes("1 running process may use it"), true, skipped.detail);
			strictEqual(existsSync(join(leasedDir, "old")), true, "a leased cache keeps every tool dir");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
