import { performance } from "node:perf_hooks";
import { resolveClioDirs } from "../core/xdg.js";
import { inspectInstallation } from "../domains/lifecycle/install-method.js";
import { createUpdateCheck, type UpdateNotice } from "../domains/lifecycle/update-check.js";

export interface UpdateMonitorOptions {
	runningVersion: string;
	isIdle: () => boolean;
	onChange: () => void;
	signal: AbortSignal;
	check?: ReturnType<typeof createUpdateCheck>;
	now?: () => number;
}

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
		});
	let pending: UpdateNotice | null = null;
	let displayed: UpdateNotice | null = null;
	let expiresAt = 0;
	let nextProbe = 0;
	let inFlight = false;
	let offeredUpdate = false;
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
			}
			if (options.signal.aborted) return;
			if (pending && !(pending.kind === "available" && offeredUpdate) && !seen.has(pending.key) && options.isIdle()) {
				const notice = pending;
				if (await check.claim(notice, options.isIdle, options.signal)) {
					if (options.signal.aborted || !options.isIdle()) return;
					seen.add(notice.key);
					if (notice.kind === "available") offeredUpdate = true;
					displayed = notice;
					expiresAt = now() + 30_000;
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
