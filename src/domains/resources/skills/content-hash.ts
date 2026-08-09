import { createHash } from "node:crypto";

/**
 * Top-level frontmatter keys owned by the install lifecycle. Stripped before
 * hashing so upstream and installed copies compare on content, not on when or
 * how a copy was installed. Registry identity (`registry-id`, `registry-url`)
 * is deliberately NOT here: it names which audited catalog entry a skill
 * claims to be, travels with the content through installs, and participates
 * in the pinned hash.
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

function isProvenanceLine(line: string): boolean {
	const match = line.match(/^([A-Za-z][A-Za-z0-9-]*):/);
	return match?.[1] !== undefined && PROVENANCE_KEYS.has(match[1]);
}

/**
 * Frontmatter lines with the install-lifecycle keys removed, along with the
 * lines that belong to them.
 *
 * A key's value may span lines (`audit: >` followed by an indented block), and
 * filtering the key line alone left those orphans behind: they stayed in the
 * installed copy where YAML then read them as part of whatever key preceded
 * them. Only an indented line can continue a key, so the next unindented line
 * ends the removal.
 */
export function stripProvenanceLines(lines: ReadonlyArray<string>): string[] {
	const kept: string[] = [];
	let dropping = false;
	for (const line of lines) {
		if (isProvenanceLine(line)) {
			dropping = true;
			continue;
		}
		if (dropping && /^[ \t]/.test(line) && line.trim().length > 0) continue;
		dropping = false;
		kept.push(line);
	}
	return kept;
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
