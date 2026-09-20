import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { resolvePackageRoot } from "../core/package-root.js";
import { printError } from "./argv.js";
import {
	backgroundAppInstalled,
	DOCS_IDLE_EXIT_MS,
	ensureDocsServer,
	openInBrowser,
	stopDocsServer,
} from "./docs-server.js";
import { runGuiCommand } from "./gui.js";

const HELP = `clio-coder docs [topic] [--no-open] [--foreground]
clio-coder docs --stop

Open the documentation in your browser. Pages, navigation and outlines are
rendered from the same Markdown reference shipped with Clio.

Arguments:
  [topic]        a topic such as safety, configuration, or fleet_dispatch, or a
                 document path such as architecture/safety-model.md.
                 Omit to open the documentation map.

Flags:
  --no-open      print the private launch link without opening a browser.
  --foreground   serve privately in this terminal until Ctrl+C. It neither starts nor
                 reuses the background app or the shared documentation server.
  --stop         stop the documentation server this command started.
  --help, -h     this message.

Your installed background app is used when you have one. Otherwise a local server
starts on 127.0.0.1 in the background, so this terminal stays free, and later
calls reuse it. It stops by itself 15 minutes after the last page closes, or with
--stop. No login service is installed. Your current directory does not affect the docs.
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
	return pages;
}

export async function runDocsCommand(args: readonly string[] = []): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const flags = new Set(["--no-open", "--foreground", "--stop"]);
	const positionals = args.filter((arg) => !flags.has(arg));
	const unknownFlag = positionals.find((arg) => arg.startsWith("-"));
	if (unknownFlag || positionals.length > 1) {
		printError(unknownFlag ? `unknown flag: ${unknownFlag}` : "docs accepts at most one [topic]");
		return 2;
	}
	const stop = args.includes("--stop");
	if (stop && args.length > 1) {
		printError("--stop takes no topic or other flags");
		return 2;
	}
	const noOpen = args.includes("--no-open");
	try {
		if (stop) {
			const result = await stopDocsServer();
			process.stdout.write(
				result.stopped
					? `Stopped the documentation server (pid ${result.pid}).\n`
					: result.survived
						? `The documentation server (pid ${result.pid}) is still running after SIGTERM and SIGKILL. Its record is kept; run clio-coder docs --stop again.\n`
						: result.unverified
							? `Process ${result.pid} did not answer as the documentation server and this platform cannot prove it is one, so it was not signalled. Its record was cleared; a stale documentation server exits by itself when idle.\n`
							: "No documentation server is running.\n",
			);
			return result.survived ? 1 : 0;
		}
		const root = resolvePackageRoot();
		const pages = catalog(join(root, "docs"));
		const path = docsTopicRoute(positionals[0], pages);
		if (!path) {
			printError(
				`Unknown or ambiguous docs topic: ${positionals[0]}. Run clio-coder docs to browse the documentation map.`,
			);
			return 2;
		}
		// A foreground request is a private server for this terminal; it never adopts the background app.
		if (args.includes("--foreground")) return runGuiCommand(["--path", path, noOpen ? "--no-open" : "--open"]);
		if (backgroundAppInstalled())
			return runGuiCommand(["--path", path, "--reuse-background", noOpen ? "--no-open" : "--open"]);
		const server = await ensureDocsServer(root);
		const link = `${server.origin}${path}#token=${server.token}`;
		process.stdout.write(`${link}\n`);
		const opened = noOpen ? false : await openInBrowser(link, root);
		if (!noOpen && !opened) process.stderr.write("Could not open a browser here. Open the link above in your browser.\n");
		process.stderr.write(
			`Documentation server ${server.reused ? "already running" : "started"} (pid ${server.pid}). It stops ${DOCS_IDLE_EXIT_MS / 60_000} minutes after the last page closes, or run: clio-coder docs --stop\n`,
		);
		return 0;
	} catch (error) {
		printError(error instanceof Error ? error.message : "Could not open the documentation.");
		return 1;
	}
}
