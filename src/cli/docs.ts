import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { resolvePackageRoot } from "../core/package-root.js";
import { printError } from "./argv.js";
import { runWebCommand } from "./web.js";

const HELP = `clio-coder docs [topic] [--no-open]

Open the documentation in the Clio Coder web app. Guides and handmade visual
blueprints share the app's navigation and theme, in both npm installs and checkouts.

Arguments:
  [topic]      a topic such as safety, configuration, or fleet_dispatch, or a
               document path such as architecture/safety-model.md.
               Omit to open the documentation map.

Flags:
  --no-open    print the private launch link without opening a browser.
  --help, -h   this message.

Reuses your installed background app when available. Otherwise starts a local
foreground web server on 127.0.0.1; press Ctrl+C to stop it. No background service
is installed by this command. Your current directory does not affect the docs.
`;

type Blueprint = { topic: string; file: string; documentPath?: string };
const key = (value: string) => value.toLowerCase().replace(/_/g, "-");
const route = (path: string) => `/docs/${path.split("/").map(encodeURIComponent).join("/")}`;

/** Resolve only catalogued destinations; ambiguous basenames require a full path. */
export function docsTopicRoute(
	topic: string | undefined,
	pages: readonly string[],
	blueprints: readonly Blueprint[],
): string | undefined {
	if (topic === undefined) return "/docs";
	if (!topic || /[\\\0?#]/.test(topic) || topic.startsWith("/") || topic.split("/").includes("..")) return;
	const wanted = key(topic.replace(/^docs\//, ""));
	const exact = pages.find((path) => key(path) === wanted || key(path.replace(/\.md$/i, "")) === wanted);
	if (exact) return route(exact);
	const blueprint = blueprints.find(
		(row) => key(row.topic) === wanted || key(row.file) === wanted || key(row.file.replace(/\.html$/i, "")) === wanted,
	);
	if (blueprint) {
		if (blueprint.documentPath && pages.includes(blueprint.documentPath)) return route(blueprint.documentPath);
		return route(`blueprints/${blueprint.file}`);
	}
	const matches = pages.filter((path) => key(basename(path).replace(/\.md$/i, "")) === wanted.replace(/\.md$/, ""));
	const match = matches[0];
	return matches.length === 1 && match ? route(match) : undefined;
}

function catalog(root: string) {
	const pages: string[] = [];
	const scan = (path: string) => {
		for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
			const name = path ? `${path}/${entry.name}` : entry.name;
			if (name === "html") continue;
			if (entry.isDirectory()) scan(name);
			else if (entry.isFile() && /\.md$/i.test(name)) pages.push(name);
		}
	};
	scan("");
	const blueprints: Blueprint[] = [];
	try {
		for (const entry of readdirSync(join(root, "html"), { withFileTypes: true })) {
			if (!entry.isFile() || !/\.html$/i.test(entry.name) || entry.name === "index.html") continue;
			const html = readFileSync(join(root, "html", entry.name), "utf8");
			const documentPath =
				/<meta\b(?=[^>]*\sname\s*=\s*["']clio-markdown-source["'])[^>]*\scontent\s*=\s*["']docs\/([^"']+)["']/i.exec(
					html,
				)?.[1];
			blueprints.push({
				topic: entry.name.replace(/(?:_blueprint)?\.html$/i, ""),
				file: entry.name,
				...(documentPath && pages.includes(documentPath) ? { documentPath } : {}),
			});
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return { pages, blueprints };
}

export async function runDocsCommand(args: readonly string[] = []): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const positionals = args.filter((arg) => arg !== "--no-open");
	const unknownFlag = positionals.find((arg) => arg.startsWith("-"));
	if (unknownFlag || positionals.length > 1) {
		printError(unknownFlag ? `unknown flag: ${unknownFlag}` : "docs accepts at most one [topic]");
		return 2;
	}
	try {
		const { pages, blueprints } = catalog(join(resolvePackageRoot(), "docs"));
		const path = docsTopicRoute(positionals[0], pages, blueprints);
		if (!path) {
			printError(
				`Unknown or ambiguous docs topic: ${positionals[0]}. Run clio-coder docs to browse the documentation map.`,
			);
			return 2;
		}
		return runWebCommand(["--path", path, "--reuse-background", args.includes("--no-open") ? "--no-open" : "--open"]);
	} catch (error) {
		printError(error instanceof Error ? error.message : "Could not open the documentation.");
		return 1;
	}
}
