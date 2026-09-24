import { existsSync, type FSWatcher, watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import { settingsPath } from "../../core/config.js";

export type WatcherCallback = (raw: { at: number }) => void;

export interface ConfigWatcher {
	stop(): void;
}

export function startConfigWatcher(cb: WatcherCallback, workspaceRoot = process.cwd()): ConfigWatcher {
	const path = settingsPath();
	const settingsFile = basename(path);
	const projectDir = join(workspaceRoot, ".clio-coder");

	let userWatcher: FSWatcher | null = null;
	let projectWatcher: FSWatcher | null = null;
	let workspaceWatcher: FSWatcher | null = null;
	let debounceTimer: NodeJS.Timeout | null = null;
	const schedule = (): void => {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => cb({ at: Date.now() }), 80);
	};
	const attachProjectWatcher = (): void => {
		if (projectWatcher || !existsSync(projectDir)) return;
		try {
			projectWatcher = watch(projectDir, { persistent: false }, (_event, filename) => {
				if (filename !== null && filename !== "settings.yaml" && filename !== "settings.local.yaml") return;
				schedule();
			});
			workspaceWatcher?.close();
			workspaceWatcher = null;
		} catch {
			// Keep watching the workspace and retry if the directory is created.
		}
	};

	try {
		// Watch the config directory, not the file: settings writes go through
		// temp-file + rename, which replaces the inode a file-level watch is
		// pinned to. The exact-name filter also keeps .lock and .tmp-* churn
		// from other Clio processes out of the reload path.
		userWatcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
			if (filename !== null && filename !== settingsFile) return;
			schedule();
		});
	} catch (err) {
		console.error("[clio-coder:config] watcher setup failed:", err);
	}
	attachProjectWatcher();
	if (!projectWatcher) {
		try {
			workspaceWatcher = watch(workspaceRoot, { persistent: false }, (_event, filename) => {
				if (filename !== null && filename !== ".clio-coder") return;
				attachProjectWatcher();
				// The local settings file may have been renamed before we attached.
				schedule();
			});
		} catch {
			// A missing workspace has no project settings to watch yet.
		}
	}

	return {
		stop() {
			if (debounceTimer) clearTimeout(debounceTimer);
			userWatcher?.close();
			projectWatcher?.close();
			workspaceWatcher?.close();
			userWatcher = null;
			projectWatcher = null;
			workspaceWatcher = null;
		},
	};
}
