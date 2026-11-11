/** How long a fresh permission card ignores Enter, so a key already in flight cannot allow it unread. */
export const PERMISSION_SETTLE_MS = 400;

/**
 * The window after a permission card opens in which Enter does not allow it.
 * The allow row is dimmed while the window runs and nothing else may paint when
 * it ends, so the window asks for one frame of its own then.
 */
export interface PermissionSettleWindow {
	/** A card opened now: restart the window and its one end-of-window frame. */
	open(): void;
	/** Whether the last card opened less than `PERMISSION_SETTLE_MS` ago. */
	settling(): boolean;
	/** Drop the pending frame; nothing paints after the lifecycle is gone. */
	dispose(): void;
}

export function createPermissionSettleWindow(deps: {
	now: () => number;
	requestRender: () => void;
}): PermissionSettleWindow {
	let openedAt = Number.NEGATIVE_INFINITY;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const clear = (): void => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	};
	return {
		open() {
			openedAt = deps.now();
			clear();
			timer = setTimeout(() => {
				timer = null;
				deps.requestRender();
			}, PERMISSION_SETTLE_MS);
			timer.unref?.();
		},
		settling: () => deps.now() - openedAt < PERMISSION_SETTLE_MS,
		dispose: clear,
	};
}
