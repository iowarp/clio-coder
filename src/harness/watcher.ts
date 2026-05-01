import { existsSync, type FSWatcher, statSync, watch } from "node:fs";
import { extname, join, basename as pathBasename, resolve } from "node:path";
import { ROOT_CONFIG_FILES } from "./classifier.js";

export interface FileChangeEvent {
	path: string;
	kind: "change" | "rename" | "delete";
}

export interface WatchOptions {
	debounceMs?: number;
}

export interface WatchHandle {
	close(): void;
}

const DEFAULT_DEBOUNCE_MS = 50;
function isSidecar(name: string): boolean {
	if (name.endsWith("~")) return true;
	if (name.endsWith(".swp") || name.endsWith(".swx") || name === "4913") return true;
	if (name.startsWith(".")) return true;
	return false;
}

function looksLikeFilePath(absPath: string): boolean {
	return extname(absPath).length > 0 || ROOT_CONFIG_FILES.has(pathBasename(absPath));
}

/**
 * Watch src/ recursively and a small set of root config files. Emits a
 * FileChangeEvent per path after a per-path debounce window.
 */
export function watchRepo(
	repoRoot: string,
	onChange: (event: FileChangeEvent) => void,
	options: WatchOptions = {},
): WatchHandle {
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const pending = new Map<string, NodeJS.Timeout>();
	const watchers: FSWatcher[] = [];

	const fire = (absPath: string, kind: FileChangeEvent["kind"]): void => {
		const existing = pending.get(absPath);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			pending.delete(absPath);
			// macOS fs-events emit change events for parent directories alongside
			// the file itself; Linux inotify usually doesn't. Stat-gate so only
			// real files reach the classifier.
			try {
				const stat = statSync(absPath);
				if (!stat.isFile()) return;
			} catch {
				if (!looksLikeFilePath(absPath)) return;
				onChange({ path: absPath, kind: "delete" });
				return;
			}
			onChange({ path: absPath, kind });
		}, debounceMs);
		pending.set(absPath, timer);
	};

	const srcDir = join(repoRoot, "src");
	if (existsSync(srcDir)) {
		try {
			const w = watch(srcDir, { recursive: true }, (_event, filename) => {
				if (!filename) return;
				const name = filename.toString();
				const basename = name.split(/[\\/]/).pop() ?? name;
				if (isSidecar(basename)) return;
				fire(resolve(srcDir, name), _event === "rename" ? "rename" : "change");
			});
			watchers.push(w);
		} catch {
			// recursive watch unsupported; caller can degrade
		}
	}

	try {
		const rootWatcher = watch(repoRoot, (_event, filename) => {
			if (!filename) return;
			const name = filename.toString();
			if (name.includes("/") || name.includes("\\")) return;
			if (!ROOT_CONFIG_FILES.has(name)) return;
			fire(resolve(repoRoot, name), _event === "rename" ? "rename" : "change");
		});
		watchers.push(rootWatcher);
	} catch {
		for (const root of ROOT_CONFIG_FILES) {
			const p = join(repoRoot, root);
			if (!existsSync(p)) continue;
			try {
				const w = watch(p, (_event) => fire(p, _event === "rename" ? "rename" : "change"));
				watchers.push(w);
			} catch {
				// ignore
			}
		}
	}

	return {
		close(): void {
			for (const w of watchers) {
				try {
					w.close();
				} catch {
					// ignore
				}
			}
			for (const timer of pending.values()) clearTimeout(timer);
			pending.clear();
		},
	};
}
