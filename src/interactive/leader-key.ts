import type { ClioKeybinding } from "../domains/config/keybindings.js";
import { isKeyRelease, type KeyId, matchesKey } from "../engine/tui.js";

export interface LeaderTarget {
	key: string;
	id: ClioKeybinding;
}

export type LeaderKeyState = { status: "idle" } | { status: "pending"; expiresAt: number };

export interface LeaderKeyRouteDeps {
	matchesLeader: (data: string) => boolean;
	leaderTargets: ReadonlyArray<LeaderTarget>;
	dispatchAction: (id: ClioKeybinding) => boolean;
	now: number;
	timeoutMs?: number;
	isRelease?: (data: string) => boolean;
}

export interface LeaderKeyRouteResult {
	state: LeaderKeyState;
	consumed: boolean;
}

export const LEADER_TIMEOUT_MS = 1500;
export const IDLE_LEADER_STATE: LeaderKeyState = { status: "idle" };

function baseLetterFromInput(data: string): string | null {
	if (data.length === 1) {
		const lower = data.toLowerCase();
		return lower >= "a" && lower <= "z" ? lower : null;
	}
	for (let code = 97; code <= 122; code += 1) {
		const key = String.fromCharCode(code) as KeyId;
		if (matchesKey(data, key) || matchesKey(data, `shift+${key}` as KeyId)) return key;
	}
	return null;
}

function isEscapeKey(data: string): boolean {
	return matchesKey(data, "escape") && !isKeyRelease(data);
}

/** Pure leader-key router: returns the next leader state and whether input was swallowed. */
export function routeLeaderKey(data: string, state: LeaderKeyState, deps: LeaderKeyRouteDeps): LeaderKeyRouteResult {
	const timeoutMs = deps.timeoutMs ?? LEADER_TIMEOUT_MS;
	if (state.status === "pending") {
		if (deps.now > state.expiresAt) return { state: IDLE_LEADER_STATE, consumed: true };
		if (deps.isRelease?.(data) ?? false) return { state, consumed: true };
		if (isEscapeKey(data)) return { state: IDLE_LEADER_STATE, consumed: true };
		const base = baseLetterFromInput(data);
		const target = base ? deps.leaderTargets.find((entry) => entry.key === base) : undefined;
		if (target) {
			deps.dispatchAction(target.id);
			return { state: IDLE_LEADER_STATE, consumed: true };
		}
		return { state: IDLE_LEADER_STATE, consumed: true };
	}
	if (deps.isRelease?.(data) ?? false) return { state, consumed: false };
	if (!deps.matchesLeader(data)) return { state, consumed: false };
	return { state: { status: "pending", expiresAt: deps.now + timeoutMs }, consumed: true };
}

export interface LeaderKeyTimeout {
	unref?(): void;
}

export interface LeaderKeyControllerDeps {
	matchesLeader: (data: string) => boolean;
	leaderTargets: () => ReadonlyArray<LeaderTarget>;
	dispatchAction: (id: ClioKeybinding) => boolean;
	isRelease: (data: string) => boolean;
	now?: () => number;
	timeoutMs?: number;
	scheduleTimeout?: (callback: () => void, delayMs: number) => LeaderKeyTimeout;
	clearScheduledTimeout?: (timeout: LeaderKeyTimeout) => void;
	/**
	 * Fired when the leader arms or disarms, including on timeout.
	 *
	 * Ctrl+G is the fallback for terminals where Alt is broken, and the frame
	 * between it and the next key was identical to the idle frame: nothing said
	 * the leader had taken, on the one surface whose users cannot test it with a
	 * working Alt shortcut.
	 */
	onStateChange?: (pending: boolean) => void;
}

export interface LeaderKeyController {
	isPending(): boolean;
	route(data: string): boolean;
	reset(): void;
	dispose(): void;
}

export function createLeaderKeyController(deps: LeaderKeyControllerDeps): LeaderKeyController {
	const now = deps.now ?? Date.now;
	const scheduleTimeout = deps.scheduleTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
	const clearScheduledTimeout =
		deps.clearScheduledTimeout ?? ((timeout: LeaderKeyTimeout) => clearTimeout(timeout as ReturnType<typeof setTimeout>));
	let state: LeaderKeyState = IDLE_LEADER_STATE;
	let timer: LeaderKeyTimeout | null = null;

	const setState = (next: LeaderKeyState): void => {
		const wasPending = state.status === "pending";
		state = next;
		if (timer) {
			clearScheduledTimeout(timer);
			timer = null;
		}
		if (next.status !== "pending") {
			if (wasPending) deps.onStateChange?.(false);
			return;
		}
		if (!wasPending) deps.onStateChange?.(true);
		timer = scheduleTimeout(
			() => {
				state = IDLE_LEADER_STATE;
				timer = null;
				deps.onStateChange?.(false);
			},
			Math.max(0, next.expiresAt - now()),
		);
		timer.unref?.();
	};

	return {
		isPending: () => state.status === "pending",
		route: (data) => {
			const result = routeLeaderKey(data, state, {
				matchesLeader: deps.matchesLeader,
				leaderTargets: deps.leaderTargets(),
				dispatchAction: deps.dispatchAction,
				now: now(),
				...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
				isRelease: deps.isRelease,
			});
			if (result.state !== state) setState(result.state);
			return result.consumed;
		},
		reset: () => setState(IDLE_LEADER_STATE),
		dispose: () => setState(IDLE_LEADER_STATE),
	};
}
