import { existsSync, type FSWatcher, watch } from "node:fs";
import path from "node:path";

export const RUNTIME_WATCH_LIMITS = {
	debounceMs: 500,
	maxPaths: 64,
	/** How often a glob whose base directory does not exist yet looks for it. */
	rearmMs: 2000,
} as const;

export interface ExtensionGlobWatch {
	close(): void;
}

const GLOB_CHARS = /[*?[{]/u;

/** The longest leading directory of a workspace-relative glob that holds no glob syntax. */
function staticBase(glob: string): string {
	const base: string[] = [];
	for (const segment of glob.split("/").slice(0, -1)) {
		if (GLOB_CHARS.test(segment)) break;
		base.push(segment);
	}
	return base.join("/");
}

/**
 * Host-side watch for an extension's declared globs. Only the static base of
 * each glob is watched, so `.research/**` costs one recursive watch on
 * `.research`, never the whole repository. Changes are debounced and
 * delivered as one batch of workspace-relative paths; the runtime itself never
 * watches anything.
 */
export function watchExtensionGlobs(
	workspace: string,
	globs: ReadonlyArray<string>,
	onChange: (paths: string[]) => void,
): ExtensionGlobWatch {
	const pending = new Set<string>();
	const watchers = new Map<string, FSWatcher>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	const bases = [...new Set(globs.map(staticBase))];

	const flush = (): void => {
		timer = undefined;
		if (closed || pending.size === 0) return;
		const paths = [...pending].sort().slice(0, RUNTIME_WATCH_LIMITS.maxPaths);
		pending.clear();
		try {
			onChange(paths);
		} catch {
			/* Delivery belongs to the caller; the watch keeps running. */
		}
	};
	const arm = (base: string): void => {
		if (closed || watchers.has(base)) return;
		const directory = path.join(workspace, base);
		if (!existsSync(directory)) return;
		try {
			const watcher = watch(directory, { recursive: true, persistent: false }, (_event, filename) => {
				if (closed || filename === null) return;
				const relative = path.posix.join(base.split(path.sep).join("/"), String(filename).split(path.sep).join("/"));
				if (!globs.some((glob) => path.posix.matchesGlob(relative, glob))) return;
				pending.add(relative);
				timer ??= setTimeout(flush, RUNTIME_WATCH_LIMITS.debounceMs);
			});
			watcher.on("error", () => {
				// A removed base directory ends its watch; the re-arm loop picks it up again.
				watcher.close();
				watchers.delete(base);
			});
			watchers.set(base, watcher);
		} catch {
			// No watch on this filesystem; the re-arm loop retries it.
		}
	};
	for (const base of bases) arm(base);
	const rearm = setInterval(() => {
		for (const base of bases) arm(base);
	}, RUNTIME_WATCH_LIMITS.rearmMs);
	rearm.unref();
	return {
		close() {
			closed = true;
			clearInterval(rearm);
			if (timer) clearTimeout(timer);
			for (const watcher of watchers.values()) watcher.close();
			watchers.clear();
			pending.clear();
		},
	};
}
