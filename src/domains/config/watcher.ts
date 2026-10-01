import { existsSync, type FSWatcher, realpathSync, watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import { settingsPath } from "../../core/config.js";

export type WatcherCallback = (raw: { at: number }) => void;

export interface ConfigWatcher {
	stop(): void;
}

// How often a session without a project settings directory re-checks for one.
// fs.watch cannot be trusted to deliver the first event for a directory that
// appears right after the watch starts (macOS FSEvents starts its stream
// asynchronously), so correctness rests on this poll, not on the event.
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
	let workspaceWatcher: FSWatcher | null = null;
	let projectPoll: NodeJS.Timeout | null = null;
	let debounceTimer: NodeJS.Timeout | null = null;
	let stopped = false;
	const schedule = (): void => {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => cb({ at: Date.now() }), 80);
	};
	const stopProjectPoll = (): void => {
		if (projectPoll) clearInterval(projectPoll);
		projectPoll = null;
	};
	// A watcher that attaches after startup may have missed the write that
	// created the directory, so it reports one change when notify is set.
	const attachProjectWatcher = (notify: boolean): void => {
		if (stopped || projectWatcher || !existsSync(projectDir)) return;
		try {
			projectWatcher = watch(projectDir, { persistent: false }, (_event, filename) => {
				if (filename !== null && filename !== "settings.yaml" && filename !== "settings.local.yaml") return;
				schedule();
			});
		} catch {
			// The poll retries while no project watcher is attached.
			return;
		}
		stopProjectPoll();
		workspaceWatcher?.close();
		workspaceWatcher = null;
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
	if (!projectWatcher) {
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
		if (!projectWatcher) {
			projectPoll = setInterval(() => attachProjectWatcher(true), PROJECT_DIR_POLL_MS);
			projectPoll.unref();
		}
	}

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
