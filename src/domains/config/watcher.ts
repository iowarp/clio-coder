import { type FSWatcher, realpathSync, statSync, watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import { settingsPath } from "../../core/config.js";

export type WatcherCallback = (raw: { at: number }) => void;

export interface ConfigWatcher {
	stop(): void;
}

const PROJECT_DIR_POLL_MS = 250;

// FSEvents reports paths in their resolved form, so watch the resolved path.
// A path that does not exist yet (or cannot be resolved) is watched as given.
function resolveExisting(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

export function startConfigWatcher(cb: WatcherCallback, workspaceRoot = process.cwd()): ConfigWatcher {
	const path = settingsPath();
	const settingsFile = basename(path);
	const projectDir = join(resolveExisting(workspaceRoot), ".clio-coder");

	let userWatcher: FSWatcher | null = null;
	let projectWatcher: FSWatcher | null = null;
	let projectIdentity: string | null = null;
	let workspaceWatcher: FSWatcher | null = null;
	let projectPoll: NodeJS.Timeout | null = null;
	let debounceTimer: NodeJS.Timeout | null = null;
	let stopped = false;
	const schedule = (): void => {
		if (stopped) return;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => cb({ at: Date.now() }), 80);
	};
	const stopProjectPoll = (): void => {
		if (projectPoll) clearInterval(projectPoll);
		projectPoll = null;
	};
	const attachProjectWatcher = (notify: boolean): void => {
		if (stopped) return;
		let identity: string | null = null;
		try {
			const stat = statSync(projectDir);
			if (stat.isDirectory()) identity = `${stat.dev}:${stat.ino}`;
		} catch {
			// Y7: a directory replacement can briefly leave no path to watch.
		}
		if (identity !== projectIdentity) {
			projectWatcher?.close();
			projectWatcher = null;
			projectIdentity = identity;
			if (notify) schedule();
		}
		if (projectWatcher || identity === null) return;
		try {
			const attachedWatcher = watch(projectDir, { persistent: false }, (_event, filename) => {
				attachProjectWatcher(true);
				if (filename !== null && filename !== "settings.yaml" && filename !== "settings.local.yaml") return;
				schedule();
			});
			projectWatcher = attachedWatcher;
			attachedWatcher.on("error", () => {
				if (projectWatcher !== attachedWatcher) return;
				attachedWatcher.close();
				projectWatcher = null;
				schedule();
			});
		} catch {
			// The poll retries while no project watcher is attached.
			return;
		}
		if (notify) schedule();
	};

	try {
		// Watch the config directory, not the file: settings writes go through
		// temp-file + rename, which replaces the inode a file-level watch is
		// pinned to. The exact-name filter also keeps .lock and .tmp-* churn
		// from other Clio processes out of the reload path.
		userWatcher = watch(resolveExisting(dirname(path)), { persistent: false }, (_event, filename) => {
			if (filename !== null && filename !== settingsFile) return;
			schedule();
		});
	} catch (err) {
		console.error("[clio-coder:config] watcher setup failed:", err);
	}
	attachProjectWatcher(false);
	// Y7: a directory watch follows its inode after rename. Keep the parent
	// watch and identity poll alive so replacement never strands that handle.
	try {
		workspaceWatcher = watch(resolveExisting(workspaceRoot), { persistent: false }, (_event, filename) => {
			if (filename !== null && filename !== ".clio-coder") return;
			attachProjectWatcher(true);
			// The local settings file may have been renamed before we attached.
			schedule();
		});
	} catch {
		// A missing workspace has no project settings to watch yet.
	}
	// The directory can appear between the first check and the workspace
	// watch starting, and the workspace watch can miss it entirely.
	attachProjectWatcher(true);
	projectPoll = setInterval(() => attachProjectWatcher(true), PROJECT_DIR_POLL_MS);
	projectPoll.unref();

	return {
		stop() {
			stopped = true;
			stopProjectPoll();
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
