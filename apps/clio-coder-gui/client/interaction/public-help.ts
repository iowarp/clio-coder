/** Intentional projection of site/public-docs.json. Never turn an arbitrary local path into a public URL. */
export const PUBLIC_HELP = "https://coder.iowarp.ai/docs.html";
export const PUBLIC_GUIDES = [
	"hpc-clusters",
	"configuration-and-targets",
	"commands-and-modes",
	"tool-usage",
	"context-continuity",
	"panes-and-files",
	"gui",
	"fleet-dispatch",
	"resource-library",
	"plugins",
	"interop",
	"slurm",
	"doctor",
	"troubleshooting",
	"configuration-reference",
	"quality-policy",
	"environment-variables",
] as const;

/** Launch tokens, query strings, internal architecture pages and arbitrary anchors are never forwarded. */
export function publicHelpUrl(legacyPath = ""): string {
	const path = legacyPath.replace(/^\/docs\/?/u, "");
	const match = /^guide\/([a-z-]+)\.md$/u.exec(path);
	return match && PUBLIC_GUIDES.some((guide) => guide === match[1])
		? `https://coder.iowarp.ai/docs/guide/${match[1]}.html`
		: PUBLIC_HELP;
}
