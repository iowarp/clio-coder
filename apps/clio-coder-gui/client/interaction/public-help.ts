import catalog from "../../../../site/public-docs.json" with { type: "json" };

/** Never turn an arbitrary local path into a public URL. */
export const PUBLIC_HELP = "https://coder.iowarp.ai/docs.html";

const GUIDE_PATH_RE = /^guide\/([a-z0-9-]+)\.md$/u;

/**
 * The guides the website publishes, read from site/public-docs.json, the list
 * site/build.mjs renders, so a guide added there is linkable here without a
 * second edit. Its `README.md` entry is the docs index, PUBLIC_HELP itself.
 */
export const PUBLIC_GUIDES: readonly string[] = catalog.flatMap(({ path }) => GUIDE_PATH_RE.exec(path)?.[1] ?? []);

/** Launch tokens, query strings, internal architecture pages and arbitrary anchors are never forwarded. */
export function publicHelpUrl(legacyPath = ""): string {
	const path = legacyPath.replace(/^\/docs\/?/u, "");
	const match = GUIDE_PATH_RE.exec(path);
	return match?.[1] && PUBLIC_GUIDES.includes(match[1])
		? `https://coder.iowarp.ai/docs/guide/${match[1]}.html`
		: PUBLIC_HELP;
}
