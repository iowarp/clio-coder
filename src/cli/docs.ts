import { basename, join } from "node:path";
import { resolvePackageRoot } from "../core/package-root.js";
import { printError } from "./argv.js";

const HELP = `clio-coder docs

Documentation pages open in the Clio Coder graphical application, which is not
part of this release. The Markdown those pages render ships with the package and
reads as ordinary files; this command prints the directory that holds it.

Clio reads the same corpus herself. Ask her a documentation question in a session
and she answers from these files.

Flags:
  --help, -h   this message.
`;

const key = (value: string) => value.toLowerCase().replace(/_/g, "-");
const route = (path: string) => `/docs/${path.split("/").map(encodeURIComponent).join("/")}`;

/** Resolve only catalogued destinations; ambiguous basenames require a full path. */
export function docsTopicRoute(topic: string | undefined, pages: readonly string[]): string | undefined {
	if (topic === undefined) return "/docs";
	if (!topic || /[\\\0?#]/.test(topic) || topic.startsWith("/") || topic.split("/").includes("..")) return;
	const wanted = key(topic.replace(/^docs\//, ""));
	const topics: Record<string, string> = {
		safety: "architecture/safety-model.md",
		configuration: "guide/configuration-and-targets.md",
		trace: "architecture/trace-store.md",
	};
	const preferred = topics[wanted];
	if (preferred && pages.includes(preferred)) return route(preferred);
	const exact = pages.find((path) => key(path) === wanted || key(path.replace(/\.md$/i, "")) === wanted);
	if (exact) return route(exact);
	const name = wanted.replace(/\.md$/, "");
	const exactNames = pages.filter((path) => key(basename(path).replace(/\.md$/i, "")) === name);
	const matches = exactNames.length
		? exactNames
		: pages.filter((path) => key(basename(path).replace(/\.md$/i, "")).startsWith(`${name}-`));
	const match = matches[0];
	return matches.length === 1 && match ? route(match) : undefined;
}

/**
 * Routing stays in `docsTopicRoute` above, where the application will pick it
 * up again. Until the graphical application ships, this command answers with
 * the one thing an operator can act on: where the Markdown actually is.
 */
export async function runDocsCommand(args: readonly string[] = []): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	printError(
		`Documentation pages open in the Clio Coder graphical application, which is not part of this release; the Markdown they render ships at ${join(resolvePackageRoot(), "docs")}.`,
	);
	return 2;
}
