import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clampTimeoutMs } from "../../src/core/bash-exec.js";
import { validateFrontendTool } from "../../src/tools/validate-frontend.js";
import { extractWebFetchContent } from "../../src/tools/web-fetch.js";

const TIMEOUT_MAX = 2_147_483_647;

describe("contracts/tool-hardening clampTimeoutMs", () => {
	it("passes normal timeouts through, floored", () => {
		strictEqual(clampTimeoutMs(300_000), 300_000);
		strictEqual(clampTimeoutMs(1500.9), 1500);
	});
	it("caps huge and non-finite timeouts at the max schedulable delay", () => {
		// Before the fix these overflowed setTimeout and were silently clamped to 1ms.
		strictEqual(clampTimeoutMs(3_000_000_000), TIMEOUT_MAX);
		strictEqual(clampTimeoutMs(Number.POSITIVE_INFINITY), TIMEOUT_MAX);
	});
	it("disables the timeout for zero, negative, or NaN input", () => {
		strictEqual(clampTimeoutMs(0), 0);
		strictEqual(clampTimeoutMs(-5), 0);
		strictEqual(clampTimeoutMs(Number.NaN), 0);
	});
});

describe("contracts/tool-hardening web_fetch extraction", () => {
	it("does not throw on out-of-range numeric entities and keeps the escape text", () => {
		const html = `<!doctype html><html><head><title>t</title></head><body><p>bad &#1114112; and &#xFFFFFFFF; entity</p></body></html>`;
		const extracted = extractWebFetchContent(html, "text/html", "https://example.com/", "auto");
		strictEqual(extracted.format, "markdown");
		ok(extracted.content.includes("&#1114112;"));
		ok(extracted.content.includes("entity"));
	});

	it("preserves newlines and $-patterns inside <pre> code blocks", () => {
		const html = `<!doctype html><html><body><pre><code>line1\nline2 $&amp; $1 $\`</code></pre></body></html>`;
		const extracted = extractWebFetchContent(html, "text/html", "https://example.com/", "auto");
		ok(extracted.content.includes("line1\nline2"), "newline preserved inside code fence");
		ok(extracted.content.includes("$& $1 $`"), "literal $-patterns preserved, entity decoded");
	});
});

describe("contracts/tool-hardening validate_frontend html structure", () => {
	let scratch: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "clio-vf-"));
		mkdirSync(scratch, { recursive: true });
		process.chdir(scratch);
	});
	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(scratch, { recursive: true, force: true });
	});

	async function structureCheck(html: string): Promise<{ status: string; message: string }> {
		writeFileSync(join(scratch, "page.html"), html, "utf8");
		const result = await validateFrontendTool.run({ path: "page.html", browser: "off" }, undefined);
		const details = result.details as { checks?: Array<{ name: string; status: string; message: string }> } | undefined;
		const check = details?.checks?.find((c) => c.name === "html structure");
		return { status: check?.status ?? "missing", message: check?.message ?? "" };
	}

	it("does not treat tags inside comments as real elements", async () => {
		const { status } = await structureCheck(
			`<!doctype html><html><body><!-- <section> commented out --><p>ok</p></body></html>`,
		);
		strictEqual(status, "pass");
	});

	it("accepts HTML5 elements with omitted optional end tags", async () => {
		const { status } = await structureCheck(
			`<!doctype html><html><body><ul><li>a<li>b</ul><table><tr><td>x<td>y</tr></table></body></html>`,
		);
		strictEqual(status, "pass");
	});

	it("still fails on a genuine mismatched non-optional tag", async () => {
		const { status } = await structureCheck(`<!doctype html><html><body><div><span></div></body></html>`);
		strictEqual(status, "fail");
	});
});
