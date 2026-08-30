/**
 * Recovery for requests the browser aborts while the GUI is launching.
 *
 * Chrome cancels every in-flight request with net::ERR_NETWORK_CHANGED when a
 * network interface appears or disappears, which WSL2 and VPN hosts do during
 * the first seconds after launch. A cancelled fetch rejects with a TypeError
 * and a cancelled stylesheet is never retried by the browser, so without this
 * the app would show its failure screen or mount unstyled.
 */

export const NETWORK_RETRY_DELAYS_MS: readonly number[] = [250, 750, 1500];

/**
 * Runs `request` again after each network failure, once per delay. A TypeError
 * is the only rejection retried: HTTP errors are returned, not thrown, and an
 * abort rejects with a DOMException.
 */
export async function fetchWithNetworkRetry(
	request: () => Promise<Response>,
	signal: AbortSignal,
	delays: readonly number[] = NETWORK_RETRY_DELAYS_MS,
): Promise<Response> {
	for (let attempt = 0;; attempt += 1) {
		try {
			return await request();
		} catch (error) {
			const delay = delays[attempt];
			if (signal.aborted || !(error instanceof TypeError) || delay === undefined) throw error;
			await new Promise<void>((resolve) => setTimeout(resolve, delay));
		}
	}
}

export const STYLESHEET_RELOAD_ATTEMPTS = 3;

/**
 * Whether a same-origin stylesheet link failed to load. Chrome gives a failed
 * link an empty sheet whose rules cannot be read, so neither `sheet === null`
 * nor an error event (long fired by the time a module script runs) is usable.
 */
export function stylesheetFailed(link: HTMLLinkElement): boolean {
	if (link.sheet === null) return true;
	try {
		return link.sheet.cssRules.length === 0;
	} catch {
		return true;
	}
}

/**
 * Replaces every stylesheet link whose fetch failed so the browser requests it
 * again. Module scripts run only after each pending stylesheet has loaded or
 * failed, so at module evaluation every link has settled. Returns the number
 * of links being reloaded.
 */
export function reloadFailedStylesheets(root: Document, maxAttempts = STYLESHEET_RELOAD_ATTEMPTS): number {
	let reloading = 0;
	for (const link of root.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
		if (!stylesheetFailed(link)) continue;
		reloading += 1;
		let attempts = 0;
		const retry = (failed: HTMLLinkElement) => {
			if (attempts >= maxAttempts) return;
			attempts += 1;
			const fresh = failed.cloneNode() as HTMLLinkElement;
			fresh.addEventListener("error", () => setTimeout(() => retry(fresh), 500 * attempts), { once: true });
			failed.replaceWith(fresh);
		};
		retry(link);
	}
	return reloading;
}
