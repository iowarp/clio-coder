import { existsSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { threadId } from "node:worker_threads";
import {
	describeResolution,
	findPinnedTool,
	installPinnedTool,
	installTool,
	PINNED_TOOLS,
	type PinnedTool,
	removeTool,
	type ToolFetcher,
	toolchainRoot,
	toolStatus,
	toolStatuses,
} from "../../../../../src/domains/toolchain/index.js";
import { AppProblem } from "../../services/problem.js";

/** Check the requested URL before invoking the fetcher (including injected fetchers). */
export function pinnedFetcher(pins: readonly PinnedTool[], fetcher: ToolFetcher): ToolFetcher {
	const allowed = new Set(
		pins.flatMap((pin) => [
			...Object.values(pin.downloads).map((download) => download.url),
			...pin.documents.map((document) => document.url),
		]),
	);
	return async (url) => {
		if (!allowed.has(url)) throw new AppProblem("unsupported", "Download URL is outside the pinned tool registry.");
		return fetcher(url);
	};
}
export function toolDownloader(network: typeof fetch): ToolFetcher {
	return async (url: string): Promise<Buffer> => {
		// GitHub's pinned release URLs redirect to signed asset URLs. Hash verification
		// remains owned by installTool; arbitrary entry URLs never reach this function.
		const response = await network(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
		if (!response.ok) throw new Error(`Pinned download returned HTTP ${response.status}.`);
		return Buffer.from(await response.arrayBuffer());
	};
}
function containedTool(id: string) {
	const root = resolve(toolchainRoot());
	const canonical = (path: string): string => {
		let parent = path;
		while (!existsSync(parent)) parent = dirname(parent);
		return resolve(realpathSync(parent), relative(parent, path));
	};
	const difference = relative(canonical(root), canonical(resolve(root, id)));
	if (difference === ".." || difference.startsWith(`..${sep}`) || difference.startsWith(sep))
		throw new AppProblem("validation", "Tool directory escapes the toolchain root.");
}
export function toolchainAdapter(options: { pins?: readonly PinnedTool[]; fetcher?: ToolFetcher } = {}) {
	const pins = options.pins ?? PINNED_TOOLS;
	const fetcher = pinnedFetcher(pins, options.fetcher ?? toolDownloader(globalThis.fetch));
	const known = (id: string) => {
		const entry = pins.find((pin) => pin.id === id);
		if (!entry || !findPinnedTool(id)) throw new AppProblem("not_found", "Unknown pinned tool.");
		containedTool(id);
		containedTool(`${id}/${entry.version}`);
		return entry;
	};
	return {
		list() {
			const statuses = options.pins ? pins.map(toolStatus) : toolStatuses();
			return {
				threadId,
				rows: statuses.map((status) => ({
					id: status.id,
					version: status.version,
					summary: pins.find((pin) => pin.id === status.id)?.summary ?? "",
					license: status.license,
					platform: status.platform,
					supported: status.supported,
					installed: status.installed,
					installDir: status.installDir,
					resolution: {
						source: status.resolution.source,
						binaryPath: status.resolution.binaryPath,
						version: status.resolution.version,
						vendoredPath: status.resolution.vendoredPath,
						pathCandidate: status.resolution.pathCandidate,
						description: describeResolution(status),
					},
				})),
			};
		},
		async install(id: string, force: boolean, onProgress: (message: string) => void) {
			const entry = known(id);
			const settings = { force, onProgress, fetch: fetcher };
			const result = options.pins ? await installPinnedTool(entry, settings) : await installTool(id, settings);
			if (!result.ok) {
				const problem = new AppProblem(
					"operation_failed",
					"Pinned tool installation failed. See the server log for details.",
				);
				console.error(`[clio-coder:web] ${problem.problem.instance} ${result.message}`);
				throw problem;
			}
			return { id: result.id, message: result.message };
		},
		remove(id: string) {
			known(id);
			const result = removeTool(id);
			if (!result.ok) throw new AppProblem("operation_failed", "Vendored tool removal failed.");
			return { id: result.id, message: result.message };
		},
	};
}
