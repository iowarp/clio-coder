import { type FSWatcher, watch } from "node:fs";
import { settingsPath } from "../../core/config.js";

export type WatcherCallback = (raw: { at: number }) => void;

export interface ConfigWatcher {
	stop(): void;
}

export function startConfigWatcher(cb: WatcherCallback): ConfigWatcher {
	const path = settingsPath();

	let watcher: FSWatcher | null = null;
	let debounceTimer: NodeJS.Timeout | null = null;

	try {
		watcher = watch(path, { persistent: false }, () => {
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
