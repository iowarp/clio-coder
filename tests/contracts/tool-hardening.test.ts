import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clampTimeoutMs } from "../../src/core/bash-exec.js";
import { bashTool } from "../../src/tools/bash.js";
import { grepTool } from "../../src/tools/grep.js";
import { truncateHead, truncateTail } from "../../src/tools/truncate.js";
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

describe("contracts/tool-hardening truncate primitives", () => {
	it("truncateTail keeps the LAST lines, not the first", () => {
		const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
		const result = truncateTail(content, { maxLines: 3, maxBytes: 64 * 1024 });
		ok(result.truncated);
		strictEqual(result.truncatedBy, "lines");
		strictEqual(result.content, "line 8\nline 9\nline 10");
		strictEqual(result.totalLines, 10);
	});

	it("truncateTail keeps the end of an oversized final line (partial edge case)", () => {
		const content = `${"x".repeat(100)}TAIL`;
		const result = truncateTail(content, { maxLines: 2000, maxBytes: 8 });
		ok(result.truncated);
		ok(result.lastLinePartial);
		strictEqual(result.content, "xxxxTAIL");
	});

	it("splitLinesForCounting-backed counts do not over-report newline-terminated files", () => {
		// A 3-line, newline-terminated file must count as 3 lines, not 4.
		const result = truncateHead("a\nb\nc\n", { maxLines: 2000, maxBytes: 64 * 1024 });
		strictEqual(result.totalLines, 3);
	});
});

describe("contracts/tool-hardening bash tail-biased non-destructive output", () => {
	const roots: string[] = [];

	afterEach(() => {
		while (roots.length > 0) {
			const dir = roots.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("surfaces the TAIL (FAIL) of a >1MB output and spills the full output to an offload file", async () => {
		const sessionId = `hardening-${process.pid}`;
		const toolCallId = `bash-tail-${Date.now()}`;
		// ~1.049MB of "A\n" then a trailing "FAIL" with no newline: the actionable
		// tail lives past clio's old 1MB head-truncation point.
		const result = await bashTool.run({ command: "yes A | head -c 1049000; printf FAIL" }, { sessionId, toolCallId });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		ok(result.output.includes("FAIL"), "model-facing output must include the trailing FAIL");
		ok(result.output.includes("tail-truncated"), "output should announce tail truncation");

		const resultSize = (result.details as { resultSize?: { offloadPath?: string; bytes?: number } } | undefined)
			?.resultSize;
		ok(resultSize?.offloadPath, "full output should be offloaded to a scratch file");
		const offloadPath = resultSize?.offloadPath as string;
		roots.push(offloadPath);
		const spilled = readFileSync(offloadPath, "utf8");
		ok(spilled.includes("FAIL"), "offload file must contain the full output including FAIL");
		ok(spilled.length > 1_000_000, "offload file must hold the full >1MB output, not a 1MB head slice");
	});

	it("returns small output verbatim with no truncation or offload", async () => {
		const result = await bashTool.run({ command: "printf 'hello\\nworld\\n'" }, undefined);
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		strictEqual(result.output.trim(), "hello\nworld");
		strictEqual((result.details as { resultSize?: unknown } | undefined)?.resultSize, undefined);
	});
});

describe("contracts/tool-hardening grep pure-Node fallback", () => {
	let scratch: string;
	let originalPath: string | undefined;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-grep-"));
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "a.ts"), "export function findMe() {}\nconst other = 1;\n", "utf8");
		writeFileSync(join(scratch, "src", "b.md"), "# doc\nfindMe is documented here\n", "utf8");
		// Force rg-resolution failure by pointing PATH at an rg-free directory.
		originalPath = process.env.PATH;
		process.env.PATH = join(scratch, "empty-bin");
		mkdirSync(process.env.PATH, { recursive: true });
	});
	afterEach(() => {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		rmSync(scratch, { recursive: true, force: true });
	});

	it("returns matches in path:line: format when ripgrep is unavailable", async () => {
		const result = await grepTool.run({ pattern: "findMe", path: scratch }, undefined);
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		ok(result.output.includes("src/a.ts:1: export function findMe() {}"), result.output);
		ok(result.output.includes("src/b.md:2: findMe is documented here"), result.output);
	});

	it("honors the glob filter in the fallback", async () => {
		const result = await grepTool.run({ pattern: "findMe", path: scratch, glob: "*.ts" }, undefined);
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		ok(result.output.includes("src/a.ts:1:"), result.output);
		ok(!result.output.includes("b.md"), "glob *.ts must exclude the markdown match");
	});

	it("honors ignoreCase and literal in the fallback", async () => {
		const insensitive = await grepTool.run({ pattern: "FINDME", path: scratch, ignoreCase: true }, undefined);
		strictEqual(insensitive.kind, "ok");
		if (insensitive.kind === "ok") ok(insensitive.output.includes("src/a.ts:1:"), insensitive.output);

		const literal = await grepTool.run({ pattern: "findMe()", path: scratch, literal: true }, undefined);
		strictEqual(literal.kind, "ok");
		if (literal.kind === "ok") ok(literal.output.includes("src/a.ts:1:"), literal.output);
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
