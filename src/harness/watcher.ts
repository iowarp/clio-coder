import { existsSync, type FSWatcher, watch } from "node:fs";
import { join, resolve } from "node:path";

export interface FileChangeEvent {
	path: string;
}

export interface WatchOptions {
	debounceMs?: number;
}

export interface WatchHandle {
	close(): void;
}

const DEFAULT_DEBOUNCE_MS = 50;
const ROOT_FILES = [
	"package.json",
	"package-lock.json",
	"tsconfig.json",
	"tsconfig.tests.json",
	"tsup.config.ts",
	"biome.json",
];

function isSidecar(name: string): boolean {
	if (name.endsWith("~")) return true;
	if (name.endsWith(".swp") || name.endsWith(".swx") || name === "4913") return true;
	if (name.startsWith(".")) return true;
	return false;
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

	const fire = (absPath: string): void => {
		const existing = pending.get(absPath);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			pending.delete(absPath);
			onChange({ path: absPath });
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
				fire(resolve(srcDir, name));
			});
			watchers.push(w);
		} catch {
			// recursive watch unsupported; caller can degrade
		}
	}

	for (const root of ROOT_FILES) {
		const p = join(repoRoot, root);
		if (!existsSync(p)) continue;
		try {
			const w = watch(p, () => fire(p));
			watchers.push(w);
		} catch {
			// ignore
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
