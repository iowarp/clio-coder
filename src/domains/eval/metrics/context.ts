import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { enumerateWorkspaceFiles } from "../../../core/workspace-files.js";
import { readCodewiki, structuralCodewikiHash } from "../../context/codewiki/artifact.js";
import { renderCodewikiDigest } from "../../context/codewiki/digest.js";
import { detectProjectProfile } from "../../session/workspace/project-type.js";

export function collectContextMetrics(cwd: string): Record<string, number | string | null> {
	try {
		const codewiki = readCodewiki(cwd);
		if (!codewiki) throw new Error("codewiki unavailable");
		const visiblePaths = new Set(enumerateWorkspaceFiles(cwd));
		const artifactSourceFiles = codewiki.files.filter((file) => file.lang !== "config");
		const indexedFiles = artifactSourceFiles.filter((file) => visiblePaths.has(file.path)).length;
		let contentValidFiles = 0;
		let missingFiles = 0;
		for (const file of artifactSourceFiles) {
			try {
				// Match the indexer's UTF-8 source identity, including legacy records
				// whose missing hash cannot establish content validity.
				const hash = createHash("sha256")
					.update(readFileSync(join(cwd, file.path), "utf8"))
					.digest("hex")
					.slice(0, 16);
				if (visiblePaths.has(file.path) && file.hash === hash) contentValidFiles += 1;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT" || code === "ENOTDIR") missingFiles += 1;
			}
		}
		const staleFiles = artifactSourceFiles.length - contentValidFiles;
		const sourceFiles = detectProjectProfile(cwd).sourceFiles;
		const digest = renderCodewikiDigest(codewiki);
		return {
			"context.indexedFiles": indexedFiles,
			"context.artifactFiles": artifactSourceFiles.length,
			"context.staleFiles": staleFiles,
			"context.contentValidFiles": contentValidFiles,
			"context.missingFiles": missingFiles,
			"context.coverage": sourceFiles === 0 ? (artifactSourceFiles.length === 0 ? 1 : 0) : indexedFiles / sourceFiles,
			"context.structuralHash": structuralCodewikiHash(codewiki),
			"context.digestTokens": Math.ceil(digest.length / 4),
		};
	} catch {
		return {
			"context.indexedFiles": 0,
			"context.artifactFiles": 0,
			"context.staleFiles": 0,
			"context.contentValidFiles": 0,
			"context.missingFiles": 0,
			"context.coverage": 0,
			"context.structuralHash": null,
			"context.digestTokens": 0,
		};
	}
}
