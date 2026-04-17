import yaml from "yaml";

export interface ParsedFrontmatter {
	frontmatter: Record<string, unknown>;
	body: string;
}

export function parseFrontmatter(raw: string, sourcePath: string): ParsedFrontmatter {
	const opening = raw.match(/^---\r?\n/);
	if (!opening) {
		throw new Error(`frontmatter: ${sourcePath}: missing YAML frontmatter opening delimiter`);
	}

	const closeRegex = /\r?\n---(?:\r?\n|$)/g;
	closeRegex.lastIndex = opening[0].length;
	const closing = closeRegex.exec(raw);
	if (!closing) {
		throw new Error(`frontmatter: ${sourcePath}: missing YAML frontmatter closing delimiter`);
	}

	const frontmatterText = raw.slice(opening[0].length, closing.index);
	const body = raw.slice(closing.index + closing[0].length);

	let parsed: unknown;
	try {
		parsed = yaml.parse(frontmatterText);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(`frontmatter: ${sourcePath}: invalid YAML frontmatter (${reason})`);
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`frontmatter: ${sourcePath}: frontmatter must be a YAML object`);
	}

	return {
		frontmatter: parsed as Record<string, unknown>,
		body,
	};
}
