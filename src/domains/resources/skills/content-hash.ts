import { createHash } from "node:crypto";

/**
 * Frontmatter keys owned by the install lifecycle, recognized both at the top
 * level (legacy flat form) and nested under the reserved `clio:` block.
 * Stripped before hashing so upstream and installed copies compare on
 * content, not on when or how a copy was installed. Registry identity
 * (`registry-id`, `registry-url`) is deliberately NOT here: it names which
 * audited catalog entry a skill claims to be, travels with the content
 * through installs, and participates in the pinned hash.
 */
export const PROVENANCE_KEYS = new Set([
	"source-url",
	"sourceUrl",
	"install-url",
	"installed-at",
	"installedAt",
	"updated-at",
	"updatedAt",
	"installed-hash",
	"installedHash",
	"audit",
	"installed-by",
	"installedBy",
]);

export interface FrontmatterRegion {
	/** Raw text before the frontmatter lines (opening delimiter inclusive). */
	head: string;
	lines: string[];
	/** Raw text from the closing delimiter to the end. */
	tail: string;
}

export function frontmatterRegion(rawText: string): FrontmatterRegion | null {
	const opening = rawText.match(/^---\r?\n/);
	if (!opening) return null;
	const closeRegex = /\r?\n---(?:\r?\n|$)/g;
	closeRegex.lastIndex = opening[0].length;
	const closing = closeRegex.exec(rawText);
	if (!closing) return null;
	const frontmatterText = rawText.slice(opening[0].length, closing.index);
	return {
		head: opening[0],
		lines: frontmatterText.split(/\r?\n/),
		tail: rawText.slice(closing.index),
	};
}

/**
 * Frontmatter lines with the install-lifecycle keys removed, along with the
 * lines that belong to them.
 *
 * A key's value may span lines (`audit: >` followed by an indented block), and
 * filtering the key line alone left those orphans behind: they stayed in the
 * installed copy where YAML then read them as part of whatever key preceded
 * them. Only a more-indented line can continue a key, so the next line at or
 * above the dropped key's indent ends the removal.
 *
 * Lifecycle keys are recognized at the top level and one level down inside a
 * top-level `clio:` block; the same keys nested under any other mapping are
 * content and survive.
 */
export function stripProvenanceLines(lines: ReadonlyArray<string>): string[] {
	const kept: string[] = [];
	let dropIndent: number | null = null;
	let inClioBlock = false;
	for (const line of lines) {
		const indent = line.length - line.trimStart().length;
		if (dropIndent !== null && line.trim().length > 0 && indent > dropIndent) continue;
		dropIndent = null;
		const keyMatch = line.match(/^([ \t]*)([A-Za-z][A-Za-z0-9-]*):/);
		const key = keyMatch?.[2];
		if (key !== undefined) {
			if (indent === 0) inClioBlock = key === "clio";
			if (PROVENANCE_KEYS.has(key) && (indent === 0 || inClioBlock)) {
				dropIndent = indent;
				continue;
			}
		}
		kept.push(line);
	}
	// A `clio:` mapping whose children were all lifecycle keys is now empty;
	// keep it and a source that never had the block reads as drifted from its
	// own installed copy. Drop the dangling key line.
	return kept.filter((line, index) => {
		if (!/^clio:\s*$/.test(line)) return true;
		for (let next = index + 1; next < kept.length; next += 1) {
			const candidate = kept[next] as string;
			if (candidate.trim().length === 0) continue;
			return /^[ \t]/.test(candidate);
		}
		return false;
	});
}

/** Remove install-lifecycle frontmatter lines so content compares across copies. */
export function stripProvenanceFrontmatter(rawText: string): string {
	const region = frontmatterRegion(rawText);
	if (!region) return rawText;
	return `${region.head}${stripProvenanceLines(region.lines).join("\n")}${region.tail}`;
}

/** Content hash of a SKILL.md, ignoring install-lifecycle provenance frontmatter. */
export function normalizedSkillHash(rawText: string): string {
	return createHash("sha256").update(stripProvenanceFrontmatter(rawText), "utf8").digest("hex");
}
