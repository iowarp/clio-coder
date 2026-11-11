/**
 * Whether a repository-relative path ships in the npm tarball, judged by the
 * package.json `files` list: later patterns win, `!` excludes, a pattern
 * naming a directory covers everything under it. npm's always-included files
 * (package.json, README, LICENSE) need no special case for the docs checks.
 */

function patternToRegExp(pattern: string): RegExp {
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i] ?? "";
		if (char === "*" && pattern[i + 1] === "*") {
			i++;
			if (pattern[i + 1] === "/") {
				i++;
				source += "(?:.*/)?";
			} else source += ".*";
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else source += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
	}
	return new RegExp(`^${source}(?:/.*)?$`, "u");
}

export function isPackagedPath(path: string, files: readonly string[]): boolean {
	const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
	let included = false;
	for (const entry of files) {
		const negated = entry.startsWith("!");
		const pattern = (negated ? entry.slice(1) : entry).replace(/^\.\//u, "").replace(/\/$/u, "");
		if (patternToRegExp(pattern).test(normalized)) included = !negated;
	}
	return included;
}
