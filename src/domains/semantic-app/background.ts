import { readSettings } from "../../core/config.js";

/** Session-scoped optional refresh. A failed or interrupted job keeps its last complete generation. */
export function createSemanticBackgroundRefresh() {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let active: Promise<void> | null = null;
	let controller: AbortController | null = null;
	let pendingRoot: string | null = null;

	const enabled = (): boolean => {
		try {
			const settings = readSettings().context.semantic;
			return settings.enabled && settings.background;
		} catch {
			return false;
		}
	};
	const start = (): void => {
		if (stopped || active || !pendingRoot || !enabled()) return;
		const projectRoot = pendingRoot;
		pendingRoot = null;
		controller = new AbortController();
		const signal = controller.signal;
		active = import("./index.js")
			.then(async ({ refreshSemantic }) => {
				if (!signal.aborted) await refreshSemantic({ projectRoot }, signal);
			})
			.catch(() => {
				// The checkpoint/status surface owns failures; source edits and turns stay usable.
			})
			.finally(() => {
				active = null;
				controller = null;
				if (pendingRoot && !stopped) schedule(pendingRoot);
			});
	};
	const schedule = (projectRoot: string): void => {
		if (stopped || !enabled()) return;
		pendingRoot = projectRoot;
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
