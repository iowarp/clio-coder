import { type FSWatcher, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { settingsPath } from "../../core/config.js";

export type WatcherCallback = (raw: { at: number }) => void;

export interface ConfigWatcher {
	stop(): void;
}

export function startConfigWatcher(cb: WatcherCallback): ConfigWatcher {
	const path = settingsPath();
	const settingsFile = basename(path);

	let watcher: FSWatcher | null = null;
	let debounceTimer: NodeJS.Timeout | null = null;

	try {
		// Watch the config directory, not the file: settings writes go through
		// temp-file + rename, which replaces the inode a file-level watch is
		// pinned to. The exact-name filter also keeps .lock and .tmp-* churn
		// from other Clio processes out of the reload path.
		watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
			if (filename !== null && filename !== settingsFile) return;
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				cb({ at: Date.now() });
			}, 80);
		});
	} catch (err) {
		console.error("[clio:config] watcher setup failed:", err);
	}

	return {
		stop() {
			if (debounceTimer) clearTimeout(debounceTimer);
			watcher?.close();
			watcher = null;
		},
	};
}
