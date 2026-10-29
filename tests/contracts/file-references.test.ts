import { deepStrictEqual, rejects } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expandInlineFileReferencesAsync } from "../../src/core/file-references.js";

describe("contracts/file references", () => {
	it("an already-aborted signal stops a PDF expansion with an abort error and no extracted text", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "clio-file-refs-"));
		try {
			writeFileSync(join(cwd, "report.pdf"), "%PDF-1.4\n%%EOF\n", "utf8");
			const controller = new AbortController();
			controller.abort();
			const extracted: string[] = [];
			await rejects(
				expandInlineFileReferencesAsync("summarize @report.pdf", {
					cwd,
					signal: controller.signal,
					onExtract: (filePath) => extracted.push(filePath),
				}),
				{ name: "AbortError" },
			);
			deepStrictEqual(extracted, []);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
