import { execFileSync } from "node:child_process";
import { type OverlayHandle, Text, type TUI } from "../../engine/tui.js";
import { showClioOverlayFrame } from "../overlay-frame.js";

const MAX_DIFF_LINES = 200;
const WIDTH = 118;

function git(repoRoot: string, args: ReadonlyArray<string>): string {
	try {
		return execFileSync("git", ["-C", repoRoot, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trimEnd();
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

export function renderDevDiffOverlay(repoRoot: string): string {
	const stat = git(repoRoot, ["diff", "--stat", "--no-color"]).trim();
	const diff = git(repoRoot, ["diff", "--no-color"]);
	const diffLines = diff.length > 0 ? diff.split(/\r?\n/).slice(0, MAX_DIFF_LINES) : ["no changes"];
	return ["git diff --stat", stat.length > 0 ? stat : "no changes", "", "git diff (first 200 lines)", ...diffLines].join(
		"\n",
	);
}

export function openDevDiffOverlay(tui: TUI, repoRoot: string): OverlayHandle {
	return showClioOverlayFrame(tui, new Text(renderDevDiffOverlay(repoRoot), 0, 0), {
		anchor: "center",
		title: "selfdev diff",
		width: WIDTH,
	});
}
