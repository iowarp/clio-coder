import { isAbsolute, relative, sep } from "node:path";

export type ChangeClass = "hot" | "restart" | "worker-next-dispatch" | "ignore";

export interface ClassifyResult {
	class: ChangeClass;
	reason: string;
}

export const ROOT_CONFIG_FILES = new Set([
	"package.json",
	"package-lock.json",
	"tsconfig.json",
	"tsconfig.tests.json",
	"tsup.config.ts",
	"biome.json",
	".gitignore",
	"damage-control-rules.yaml",
]);

const HOT_TOOL_FILES = new Set([
	"src/tools/bash.ts",
	"src/tools/edit.ts",
	"src/tools/glob.ts",
	"src/tools/grep.ts",
	"src/tools/ls.ts",
	"src/tools/read.ts",
	"src/tools/web-fetch.ts",
	"src/tools/write-plan.ts",
	"src/tools/write-review.ts",
	"src/tools/write.ts",
	"src/tools/codewiki/entry-points.ts",
	"src/tools/codewiki/find-symbol.ts",
	"src/tools/codewiki/where-is.ts",
]);
const IGNORE_EXTENSIONS = new Set([".md", ".mdx"]);

function toPosix(p: string): string {
	return p.split(sep).join("/");
}

/**
 * Pure classifier. Given an absolute path and the repo root, returns which
 * runtime action the harness should take when this file changes. No I/O.
 */
export function classifyChange(absPath: string, repoRoot: string): ClassifyResult {
	if (!isAbsolute(absPath)) {
		return { class: "ignore", reason: "not an absolute path" };
	}
	const rel = toPosix(relative(repoRoot, absPath));
	if (rel === "" || rel.startsWith("..")) {
		return { class: "ignore", reason: "outside repo root" };
	}

	// Ignore dirs first.
	if (rel.startsWith("dist/") || rel.startsWith("node_modules/") || rel.startsWith(".git/")) {
		return { class: "ignore", reason: "generated or vendored path" };
	}
	if (rel.startsWith(".github/")) {
		return { class: "ignore", reason: "CI config does not affect the running process" };
	}
	if (rel.startsWith("tests/") || rel.startsWith("docs/")) {
		return { class: "ignore", reason: "tests/docs do not affect runtime" };
	}

	const lastDot = rel.lastIndexOf(".");
	const ext = lastDot >= 0 ? rel.slice(lastDot) : "";
	if (IGNORE_EXTENSIONS.has(ext)) {
		return { class: "ignore", reason: "markdown has no runtime impact" };
	}

	// Root config files: full restart.
	if (!rel.includes("/") && ROOT_CONFIG_FILES.has(rel)) {
		return { class: "restart", reason: `root config file ${rel} changes the build graph` };
	}
	if (!rel.includes("/")) {
		return { class: "ignore", reason: "top-level non-source file" };
	}

	if (rel.startsWith("src/tools/")) {
		const basename = rel.slice("src/tools/".length);
		if (!basename.endsWith(".ts")) {
			return { class: "ignore", reason: `non-ts tool file ${basename}` };
		}
		if (HOT_TOOL_FILES.has(rel)) {
			return { class: "hot", reason: `tool spec ${basename} is self-contained and re-registerable` };
		}
		return { class: "restart", reason: `${basename} is tool infrastructure or an unregistered tool module` };
	}

	if (rel.startsWith("src/worker/")) {
		return { class: "worker-next-dispatch", reason: "workers re-spawn each dispatch" };
	}

	if (rel.startsWith("src/engine/")) {
		return { class: "restart", reason: "engine owns pi-mono; re-import mid-run is ill-defined" };
	}
	if (rel.startsWith("src/core/")) {
		return { class: "restart", reason: "core is boot foundation held in singletons" };
	}
	if (rel.startsWith("src/domains/")) {
		return { class: "restart", reason: "domain extensions hold untracked bus subscriptions" };
	}
	if (rel.startsWith("src/interactive/")) {
		return { class: "restart", reason: "interactive root statically imports its children" };
	}
	if (rel.startsWith("src/entry/")) {
		return { class: "restart", reason: "boot composition root" };
	}
	if (rel.startsWith("src/cli/")) {
		return { class: "restart", reason: "argv already parsed" };
	}
	if (rel.startsWith("src/harness/")) {
		return { class: "restart", reason: "changing hot-reload code while hot-reload runs is a footgun" };
	}

	if (rel.startsWith("src/")) {
		return { class: "restart", reason: `unknown src subtree ${rel}` };
	}

	return { class: "ignore", reason: `unhandled path ${rel}` };
}
