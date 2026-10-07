/** External peers receive access tokens, so stop explicitly rather than replaying work after expiry. */
export function watchCredentialExpiry(expiresAt: number | undefined, expire: () => void): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	const schedule = (): void => {
		if (closed || expiresAt === undefined) return;
		const remaining = expiresAt - Date.now();
		if (remaining <= 0) {
			expire();
			return;
		}
		timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
		timer.unref();
	};
	schedule();
	return () => {
		closed = true;
		if (timer !== undefined) clearTimeout(timer);
	};
}
