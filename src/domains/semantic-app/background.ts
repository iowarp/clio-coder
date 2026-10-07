import type { ClioSettings } from "../../core/config.js";

/**
 * Session-scoped optional refresh. A failed or interrupted job keeps its last complete generation.
 * `getSettings` is the layered view the context tool searches with, so a refresh builds the same
 * profile namespace a search reads and a trusted project recipe gates both alike.
 */
export function createSemanticBackgroundRefresh(getSettings: () => Readonly<ClioSettings> | undefined) {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let active: Promise<void> | null = null;
	let controller: AbortController | null = null;
	let pendingRoot: string | null = null;

	const enabledSettings = (): Readonly<ClioSettings> | undefined => {
		const settings = getSettings();
		return settings?.context.semantic.enabled && settings.context.semantic.background ? settings : undefined;
	};
	const start = (): void => {
		if (stopped || active || !pendingRoot) return;
		const settings = enabledSettings();
		if (!settings) return;
		const projectRoot = pendingRoot;
		pendingRoot = null;
		controller = new AbortController();
		const signal = controller.signal;
		active = import("./index.js")
			.then(async ({ refreshSemantic }) => {
				if (!signal.aborted) await refreshSemantic({ projectRoot, settings }, signal);
			})
			.catch(() => {
				// The checkpoint/status surface owns failures; source edits and turns stay usable.
			})
			.finally(() => {
				active = null;
				controller = null;
				start();
			});
	};
	const schedule = (projectRoot: string): void => {
		if (stopped || !enabledSettings()) return;
		pendingRoot = projectRoot;
		// Commits during a run coalesce into the one follow-up its settlement starts.
		if (active) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			start();
		}, 750);
	};
	return {
		schedule,
		async stop() {
			stopped = true;
			pendingRoot = null;
			if (timer) clearTimeout(timer);
			timer = null;
			controller?.abort();
			await active;
		},
	};
}
