export const SELF_DEV_RESTART_ROOT_FILES = new Set([
	"package.json",
	"package-lock.json",
	"tsconfig.json",
	"tsconfig.tests.json",
	"tsup.config.ts",
	"biome.json",
	".gitignore",
	"damage-control-rules.yaml",
]);

export const SELF_DEV_HOT_TOOL_FILES = new Set([
	"src/tools/bash.ts",
	"src/tools/edit.ts",
	"src/tools/find.ts",
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

export function selfDevRestartRequired(rel: string): boolean {
	if (SELF_DEV_RESTART_ROOT_FILES.has(rel)) return true;
	if (rel.startsWith("src/tools/")) {
		return rel.endsWith(".ts") && !SELF_DEV_HOT_TOOL_FILES.has(rel);
	}
	if (rel.startsWith("src/worker/")) return false;
	return (
		rel.startsWith("src/engine/") ||
		rel.startsWith("src/core/") ||
		rel.startsWith("src/domains/") ||
		rel.startsWith("src/interactive/") ||
		rel.startsWith("src/entry/") ||
		rel.startsWith("src/cli/") ||
		rel.startsWith("src/selfdev/harness/") ||
		rel.startsWith("src/")
	);
}
