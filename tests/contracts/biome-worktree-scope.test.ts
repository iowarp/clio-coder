import { ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";

// Clio's task worktrees live under .clio-coder/worktrees and Claude Code's under .claude/worktrees.
// Biome matches `!**/.clio-coder` against the worktree's own absolute path, ignores every file in it,
// and `biome check .` fails with "No files were processed", so `pnpm run ci` cannot pass there.
// Root-anchored exclusions keep the nested worktrees out of the parent checkout's lint without that.
it("biome excludes agent worktree roots only at the checkout root", () => {
	const config = JSON.parse(readFileSync(new URL("../../biome.json", import.meta.url), "utf8")) as {
		files: { includes: string[] };
	};
	const includes = config.files.includes;
	for (const dir of [".clio-coder", ".claude"]) {
		ok(includes.includes(`!${dir}`), `biome.json must exclude !${dir}`);
		ok(!includes.includes(`!**/${dir}`), `!**/${dir} also matches a worktree that lives under ${dir}`);
	}
});
