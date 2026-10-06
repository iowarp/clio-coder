import { decodePrintableKey, isKeyRelease, isKeyRepeat, type Keybinding, matchesKey } from "../engine/tui.js";

/**
 * A leader entry is a keybinding, or an entry the host adds for something
 * that is not one, such as an extension workspace's keys, which runs itself.
 */
export type LeaderTarget =
	| { key: string; id: Keybinding; label?: string; disabledReason?: string; run?: undefined }
	| { key: string; id?: undefined; label: string; disabledReason?: string; run: () => void };
export type LeaderKeyState = { status: "idle" } | { status: "pending"; selected: number; notice?: string };
export const IDLE_LEADER_STATE: LeaderKeyState = { status: "idle" };
export interface LeaderKeyRouteDeps {
	matchesLeader(data: string): boolean;
	leaderTargets: ReadonlyArray<LeaderTarget>;
	dispatchAction(id: Keybinding): boolean;
	isRelease?: (data: string) => boolean;
}
export interface LeaderKeyRouteResult {
	state: LeaderKeyState;
	consumed: boolean;
}

export function routeLeaderKey(data: string, state: LeaderKeyState, deps: LeaderKeyRouteDeps): LeaderKeyRouteResult {
	if (isKeyRelease(data)) return { state, consumed: state.status === "pending" };
	if (matchesKey(data, "ctrl+c")) return { state: IDLE_LEADER_STATE, consumed: false };
	if (state.status === "idle") {
		return deps.matchesLeader(data) && !isKeyRepeat(data)
			? { state: { status: "pending", selected: 0 }, consumed: true }
			: { state, consumed: false };
	}
	if (isKeyRepeat(data) && !matchesKey(data, "up") && !matchesKey(data, "down")) return { state, consumed: true };
	if (matchesKey(data, "escape") || deps.matchesLeader(data)) return { state: IDLE_LEADER_STATE, consumed: true };
	const count = deps.leaderTargets.length;
	if (matchesKey(data, "up") || matchesKey(data, "down")) {
		const delta = matchesKey(data, "up") ? -1 : 1;
		return {
			state: { status: "pending", selected: count ? (state.selected + delta + count) % count : 0 },
			consumed: true,
		};
	}
	const key = data.includes("\x1b[200~")
		? null
		: (decodePrintableKey(data) ?? (data.length === 1 ? data : undefined))?.toLowerCase();
	const target = matchesKey(data, "enter")
		? deps.leaderTargets[state.selected]
		: deps.leaderTargets.find(
				(entry) =>
					entry.key &&
					(entry.key === key ||
						(entry.key === "home" && matchesKey(data, "home")) ||
						(entry.key === "end" && matchesKey(data, "end"))),
			);
	if (!target) return { state: { ...state, notice: "No action for this key" }, consumed: true };
	if (target.disabledReason) return { state: { ...state, notice: target.disabledReason }, consumed: true };
	if (target.run) target.run();
	else deps.dispatchAction(target.id);
	return { state: IDLE_LEADER_STATE, consumed: true };
}

export interface LeaderKeyControllerDeps {
	matchesLeader(data: string): boolean;
	leaderTargets(): ReadonlyArray<LeaderTarget>;
	dispatchAction(id: Keybinding): boolean;
	isRelease: (data: string) => boolean;
	onStateChange?: (pending: boolean) => void;
	onMenuChange?: (state: LeaderKeyState, targets: ReadonlyArray<LeaderTarget>) => void;
}
export interface LeaderKeyController {
	isPending(): boolean;
	route(data: string): boolean;
	reset(): void;
	dispose(): void;
}
export function createLeaderKeyController(deps: LeaderKeyControllerDeps): LeaderKeyController {
	let state: LeaderKeyState = IDLE_LEADER_STATE;
	const setState = (next: LeaderKeyState): void => {
		const changed = state.status !== next.status;
		state = next;
		deps.onMenuChange?.(state, deps.leaderTargets());
		if (changed) deps.onStateChange?.(state.status === "pending");
	};
	return {
		isPending: () => state.status === "pending",
		route(data) {
			const result = routeLeaderKey(data, state, { ...deps, leaderTargets: deps.leaderTargets() });
			if (result.state !== state) setState(result.state);
			return result.consumed;
		},
		reset: () => setState(IDLE_LEADER_STATE),
		dispose: () => setState(IDLE_LEADER_STATE),
	};
}
