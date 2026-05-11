import { strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveSafeCwd, runCommandVector } from "../../src/core/safe-exec.js";
import { packageScriptToolSpec } from "../../src/tools/safe-exec.js";

describe("safe execution tools", () => {
	it("runs fixed command vectors without a shell", async () => {
		const result = await runCommandVector(process.execPath, ["-e", "process.stdout.write(process.argv[1])", "ok"]);
		strictEqual(result.exitCode, 0);
		strictEqual(result.stdout, "ok");
	});

	it("rejects cwd escapes", () => {
		const root = mkdtempSync(join(tmpdir(), "clio-safe-exec-"));
		try {
			strictEqual(resolveSafeCwd(".", root), root);
			try {
				resolveSafeCwd("..", root);
				throw new Error("expected cwd escape block");
			} catch (err) {
				strictEqual(err instanceof Error && err.message.includes("cwd escapes workspace root"), true);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("package_script only admits standard script names", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-package-script-"));
		try {
			writeFileSync(
				join(root, "package.json"),
				JSON.stringify({ scripts: { custom: "echo unsafe", test: "node -e \"process.stdout.write('test')\"" } }),
				"utf8",
			);
			const custom = await packageScriptToolSpec.run({ script: "custom", cwd: root });
			strictEqual(custom.kind, "error");
			if (custom.kind === "error") strictEqual(custom.message.includes("standard allowlist"), true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("package_script rejects cwd escapes before reading package metadata", async () => {
		const result = await packageScriptToolSpec.run({ script: "test", cwd: ".." });
		strictEqual(result.kind, "error");
		if (result.kind === "error") strictEqual(result.message.includes("cwd escapes workspace root"), true);
	});
});
