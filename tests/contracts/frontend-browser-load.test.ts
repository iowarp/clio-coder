import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runFrontendCheck } from "../../src/tools/verify/frontend.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=";

async function withBrowser(body: string, check: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(path.join(tmpdir(), "clio-frontend-browser-"));
	const oldCwd = process.cwd();
	const oldPath = process.env.PATH;
	try {
		writeFileSync(
			path.join(dir, "page.html"),
			`<!doctype html><html><head><title>Large page</title></head><body><!--${"x".repeat(700_000)}--><p>Loaded</p></body></html>`,
		);
		const browser = path.join(dir, "chromium");
		writeFileSync(
			browser,
			`#!${process.execPath}\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nfs.writeFileSync("browser-args.json", JSON.stringify(args));\n${body}\n`,
		);
		chmodSync(browser, 0o755);
		process.chdir(dir);
		process.env.PATH = dir;
		await check(dir);
	} finally {
		process.chdir(oldCwd);
		if (oldPath === undefined) delete process.env.PATH;
		else process.env.PATH = oldPath;
		rmSync(dir, { recursive: true, force: true });
	}
}

function browserCheck(result: Awaited<ReturnType<typeof runFrontendCheck>>) {
	const checks = result.details?.checks as Array<{ name: string; status: string; message: string }>;
	const check = checks.find((value) => value.name === "browser load");
	assert.ok(check);
	return check;
}

describe("frontend browser load", { skip: process.platform === "win32" }, () => {
	it("loads a large document without charging its DOM to the diagnostic cap and removes its private profile", async () => {
		await withBrowser(
			`
if (args.includes("--dump-dom")) process.stdout.write(fs.readFileSync("page.html"));
else fs.writeFileSync(args.find(x => x.startsWith("--screenshot=")).slice(13), Buffer.from(${JSON.stringify(PNG)}, "base64"));
`,
			async (dir) => {
				const result = await runFrontendCheck({ path: "page.html", browser: "required" });
				assert.equal(browserCheck(result).status, "pass");
				const args: string[] = JSON.parse(readFileSync(path.join(dir, "browser-args.json"), "utf8"));
				assert.ok(!args.includes("--dump-dom"));
				for (const prefix of ["--screenshot=", "--user-data-dir="]) {
					const arg = args.find((value) => value.startsWith(prefix));
					assert.ok(arg);
					assert.equal(existsSync(arg.slice(prefix.length)), false);
				}
			},
		);
	});

	it("refuses an exit-zero browser that did not render a screenshot", async () => {
		await withBrowser("process.exit(0);", async () => {
			const check = browserCheck(await runFrontendCheck({ path: "page.html", browser: "required" }));
			assert.equal(check.status, "fail");
			assert.match(check.message, /screenshot/);
		});
	});

	it("retains a browser failure even if it produced an image", async () => {
		await withBrowser(
			`
const screenshot = args.find(x => x.startsWith("--screenshot="));
if (screenshot) fs.writeFileSync(screenshot.slice(13), Buffer.from(${JSON.stringify(PNG)}, "base64"));
process.exit(17);
`,
			async () => {
				const check = browserCheck(await runFrontendCheck({ path: "page.html" }));
				assert.equal(check.status, "fail");
				assert.match(check.message, /exited with 17/);
			},
		);
	});

	it("names diagnostic overflow instead of claiming a successful exit is a browser failure", async () => {
		await withBrowser('process.stderr.write("x".repeat(700000));', async () => {
			const check = browserCheck(await runFrontendCheck({ path: "page.html", browser: "required" }));
			assert.equal(check.status, "fail");
			assert.match(check.message, /output exceeded 600000 bytes/);
		});
	});

	it("reports timeout and cancellation independently of browser exit status", async () => {
		await withBrowser("setInterval(() => {}, 1000);", async () => {
			const timeout = browserCheck(await runFrontendCheck({ path: "page.html", timeout_ms: 200 }));
			assert.equal(timeout.status, "fail");
			assert.match(timeout.message, /timed out after 200ms/);
			const controller = new AbortController();
			controller.abort();
			const aborted = browserCheck(await runFrontendCheck({ path: "page.html" }, { signal: controller.signal }));
			assert.equal(aborted.status, "fail");
			assert.match(aborted.message, /aborted/);
		});
	});
});
