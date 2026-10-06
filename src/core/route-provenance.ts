/**
 * Where each active model route comes from. Session-only routes live in
 * process memory, so a compaction summary that drops them must not decide
 * what Clio says about them (DF-7). Callers recompute this from live state on
 * every read: the effective session view, the saved layered settings, and the
 * layer that set each saved leaf.
 */

import type { ClioSettings } from "./config.js";
import { getAtPath, resolveMemoryRoute } from "./session-routing.js";
import type { SettingsOrigin } from "./settings-layers.js";

/** `chat` means the route is unset and follows the chat route. */
export type RouteSource = "session" | "project" | "user" | "built-in" | "chat";

export type RouteName = "chat" | "memory" | "compaction" | "fleet";

export const ROUTE_NAMES: ReadonlyArray<RouteName> = ["chat", "memory", "compaction", "fleet"];

const ROUTE_PATHS: Readonly<Record<RouteName, ReadonlyArray<string>>> = {
	chat: ["chat.target", "chat.model", "chat.thinkingLevel"],
	memory: ["context.memory.target", "context.memory.model"],
	compaction: ["context.compaction.model"],
	fleet: ["fleet.default.target", "fleet.default.model", "fleet.default.thinkingLevel"],
};

const LAYER_RANK: Readonly<Record<SettingsOrigin, number>> = {
	"built-in": 0,
	user: 1,
	project: 2,
	"project.local": 3,
	cli: 4,
};

export interface RouteProvenance {
	/** Source of the route this session uses now. */
	active: Readonly<Record<RouteName, RouteSource>>;
	/** Source of the saved route a session override hides; equal to `active` otherwise. */
	saved: Readonly<Record<RouteName, RouteSource>>;
	/** Saved values of the routes a session override hides, keyed by the route's own fields. */
	savedRoutes: Readonly<Partial<Record<RouteName, Readonly<Record<string, unknown>>>>>;
}

/** A route's own fields, under the names the settings projection shows. */
export function routeFields(route: RouteName, settings: Readonly<ClioSettings>): Record<string, unknown> {
	if (route === "memory") {
		const { target, model } = resolveMemoryRoute(settings);
		return { target, model };
	}
	const fields: Record<string, unknown> = {};
	for (const path of ROUTE_PATHS[route])
		fields[path.slice(path.lastIndexOf(".") + 1)] = getAtPath(settings, path) ?? null;
	return fields;
}

function savedSourceFor(
	route: RouteName,
	saved: Readonly<ClioSettings>,
	originOf: (path: string) => SettingsOrigin,
): RouteSource {
	if (route === "memory" && resolveMemoryRoute(saved).source === "chat") return "chat";
	if (route === "compaction" && (saved.context.compaction.model ?? null) === null) return "chat";
	let top: SettingsOrigin = "built-in";
	for (const path of ROUTE_PATHS[route]) {
		const origin = originOf(path);
		if (LAYER_RANK[origin] > LAYER_RANK[top]) top = origin;
	}
	// A CLI flag applies to this process only, which is what a session route is.
	return top === "project.local" ? "project" : top === "cli" ? "session" : top;
}

export function resolveRouteProvenance(
	effective: Readonly<ClioSettings>,
	saved: Readonly<ClioSettings>,
	originOf: (path: string) => SettingsOrigin,
): RouteProvenance {
	const active = {} as Record<RouteName, RouteSource>;
	const savedSources = {} as Record<RouteName, RouteSource>;
	const savedRoutes: Partial<Record<RouteName, Record<string, unknown>>> = {};
	for (const route of ROUTE_NAMES) {
		const savedSource = savedSourceFor(route, saved, originOf);
		const overridden = ROUTE_PATHS[route].some(
			(path) => (getAtPath(effective, path) ?? null) !== (getAtPath(saved, path) ?? null),
		);
		savedSources[route] = savedSource;
		active[route] =
			route === "memory" && resolveMemoryRoute(effective).source === "chat"
				? "chat"
				: overridden
					? "session"
					: savedSource;
		if (overridden) savedRoutes[route] = routeFields(route, saved);
	}
	return { active, saved: savedSources, savedRoutes };
}

/** One prompt line; recomputed per compile so it never depends on a summary. */
export function formatRouteSources(active: Readonly<Record<RouteName, RouteSource>>): string {
	const label = (source: RouteSource): string => (source === "chat" ? "=chat" : source);
	return `Routes: ${ROUTE_NAMES.map((route) =>
		route === "memory" && active[route] === "chat"
			? "memory =chat (no memory model set)"
			: `${route} ${label(active[route])}`,
	).join(", ")}.`;
}
