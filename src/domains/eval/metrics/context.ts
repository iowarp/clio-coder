import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function collectContextMetrics(cwd: string): Record<string, number | string | null> {
	try {
		const raw = readFileSync(join(cwd, ".clio", "codewiki.json"), "utf8");
		const parsed = JSON.parse(raw) as { files?: unknown[]; digestTokens?: unknown; structuralHash?: unknown };
		const indexedFiles = Array.isArray(parsed.files) ? parsed.files.length : 0;
		return {
			"context.indexedFiles": indexedFiles,
			"context.coverage": indexedFiles > 0 ? 1 : 0,
			"context.structuralHash":
				typeof parsed.structuralHash === "string" ? parsed.structuralHash : createHash("sha256").update(raw).digest("hex"),
			"context.digestTokens": typeof parsed.digestTokens === "number" ? parsed.digestTokens : 0,
		};
	} catch {
		return {
			"context.indexedFiles": 0,
			"context.coverage": 0,
			"context.structuralHash": null,
			"context.digestTokens": 0,
		};
	}
}
