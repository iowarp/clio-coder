import { performance } from "node:perf_hooks";
import { resolveClioDirs } from "../core/xdg.js";
import { inspectInstallation } from "../domains/lifecycle/install-method.js";
import { createUpdateCheck, type UpdateNotice } from "../domains/lifecycle/update-check.js";

export interface UpdateMonitorOptions {
	runningVersion: string;
	isIdle: () => boolean;
	onChange: () => void;
	signal: AbortSignal;
	/** Live `interface.autoUpdate` (#436). */
	autoUpdate?: () => boolean;
	/**
	 * Receives the synchronous starter of a deferred package-manager update,
	 * once, for the owner to run from a shutdown hook (#436).
	 */
	onDeferredUpdate?: (start: () => boolean) => void;
	check?: Pick<UpdateCheck, "probe" | "claim"> & Partial<Pick<UpdateCheck, "maybeInstall" | "spawnDeferred">>;
	now?: () => number;
}

type UpdateCheck = ReturnType<typeof createUpdateCheck>;

/** Starts only after hydration. Timers are unref'ed and all failures are silent. */
export function startUpdateMonitor(options: UpdateMonitorOptions) {
	const now = options.now ?? Date.now;
	const check =
		options.check ??
		createUpdateCheck({
			installation: inspectInstallation(),
			runningVersion: options.runningVersion,
			cacheDir: resolveClioDirs().cache,
			processStartedAt: Date.now() - performance.now(),
			...(options.autoUpdate ? { autoUpdate: options.autoUpdate } : {}),
		});
	let pending: UpdateNotice | null = null;
	let displayed: UpdateNotice | null = null;
	let expiresAt = 0;
	let nextProbe = 0;
	let inFlight = false;
	let offeredUpdate = false;
	let installStarted = false;
	let deferredArmed = false;
	const seen = new Set<string>();
	function text(): string | null {
		if (!displayed || options.signal.aborted || now() >= expiresAt) return null;
		return options.isIdle() ? displayed.text : null;
	}
	async function tick(): Promise<void> {
		if (options.signal.aborted || inFlight) return;
		inFlight = true;
		try {
			if (now() >= nextProbe) {
				nextProbe = now() + 60_000;
				pending = await check.probe(options.signal);
				// The install does not wait for idle and does not hold the tick:
				// probes and notices keep running while it works, and its outcome
				// surfaces through the next probe (#436).
				if (pending?.defer && !deferredArmed && check.spawnDeferred && options.onDeferredUpdate) {
					deferredArmed = true;
					options.onDeferredUpdate(check.spawnDeferred);
				}
				if (pending?.install && !installStarted && check.maybeInstall) {
					installStarted = true;
					void check
						.maybeInstall(options.signal)
						.catch(() => false)
						.then((ok) => {
							// A cache-lock timeout, a sibling's lease or a held installer
							// lock is not this session's verdict: the next scheduled probe
							// (at most 60 s away) may start the install again. Success
							// re-probes at once to show the Updated notice.
							if (ok) nextProbe = 0;
							else installStarted = false;
						});
				}
			}
			if (options.signal.aborted) return;
			if (pending && !(pending.kind === "available" && offeredUpdate) && !seen.has(pending.key) && options.isIdle()) {
				const notice = pending;
				if (await check.claim(notice, options.isIdle, options.signal)) {
					if (options.signal.aborted || !options.isIdle()) return;
					seen.add(notice.key);
					if (notice.kind === "available") offeredUpdate = true;
					displayed = notice;
					// Lifecycle action remains discoverable after the first nudge. It is
					// still rendered only while the whole application is idle and can be
					// dismissed with the ordinary notification action, so persistence
					// does not turn it into a modal or steal space during work.
					expiresAt = Number.POSITIVE_INFINITY;
					options.onChange();
				} else if (options.isIdle()) seen.add(notice.key);
			}
			if (displayed && now() >= expiresAt) {
				displayed = null;
				options.onChange();
			}
		} catch {
			// Advisory work cannot produce diagnostics or break a session.
		} finally {
			inFlight = false;
		}
	}
	const timer = setInterval(() => void tick(), 1000);
	timer.unref();
	const stop = () => clearInterval(timer);
	options.signal.addEventListener("abort", stop, { once: true });
	if (options.signal.aborted) stop();
	return {
		text,
		tick,
		dismiss() {
			displayed = null;
			options.onChange();
		},
	};
}
