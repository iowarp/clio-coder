import { strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveSafeCwd, runCommandVector } from "../../src/core/safe-exec.js";
import { packageScriptToolSpec } from "../../src/tools/safe-exec.js";
import { validateFrontendTool } from "../../src/tools/validate-frontend.js";

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

	it("validate_frontend checks HTML, linked CSS, and linked JavaScript without shell access", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-frontend-valid-"));
		const previous = process.cwd();
		try {
			process.chdir(root);
			mkdirSync("assets");
			writeFileSync(
				"index.html",
				'<!doctype html><link rel="stylesheet" href="assets/app.css"><script src="assets/app.js"></script><main>ok</main>',
				"utf8",
			);
			writeFileSync(join("assets", "app.css"), "main { color: red; }\n", "utf8");
			writeFileSync(join("assets", "app.js"), "const answer = 42;\n", "utf8");

			const result = await validateFrontendTool.run({ path: "index.html", browser: "off" });

			strictEqual(result.kind, "ok");
			if (result.kind === "ok") {
				strictEqual(result.output.includes("pass html structure"), true);
				strictEqual(result.output.includes("pass css syntax"), true);
				strictEqual(result.output.includes("pass javascript syntax"), true);
			}
		} finally {
			process.chdir(previous);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("validate_frontend rejects malformed artifacts", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-frontend-invalid-"));
		const previous = process.cwd();
		try {
			process.chdir(root);
			writeFileSync("broken.html", "<main><section>missing close</main>", "utf8");

			const result = await validateFrontendTool.run({ path: "broken.html", browser: "off" });

			strictEqual(result.kind, "error");
			if (result.kind === "error") strictEqual(result.message.includes("html structure"), true);
		} finally {
			process.chdir(previous);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("validate_frontend skips non-JavaScript script references", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-frontend-json-script-"));
		const previous = process.cwd();
		try {
			process.chdir(root);
			writeFileSync("index.html", '<script type="application/json" src="data.json"></script>', "utf8");
			writeFileSync("data.json", '{"name": "clio"}', "utf8");

			const result = await validateFrontendTool.run({ path: "index.html", browser: "off" });

			strictEqual(result.kind, "ok");
			if (result.kind === "ok") {
				strictEqual(result.output.includes("skip script reference"), true);
				strictEqual(result.output.includes("non-JavaScript script type skipped"), true);
			}
		} finally {
			process.chdir(previous);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
