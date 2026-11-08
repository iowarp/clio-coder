// Every address the client router owns. The server answers each one with index.html so a reload or a
// pasted link lands on the page; anything else is an asset or a 404. One list, because two lists
// drifted: /settings/effective was routed in the client and refused by the server.
// tests/pages.test.ts holds this list to the routes client/main.tsx actually declares.

export const PAGE_PATHS = [
	"/",
	"/sessions",
	"/machines",
	"/sessions/:id",
	"/workspaces/:workspaceId/sessions",
	"/traces",
	"/traces/:runId",
	"/toolchain",
	"/docs",
	"/docs/*",
	"/settings",
	"/settings/general",
	"/settings/models",
	"/settings/safety",
	"/settings/context",
	"/settings/advanced",
	"/settings/effective",
	"/settings/why",
	"/settings/targets",
	"/settings/routing",
	"/fleet",
	"/fleet/:id",
	"/fleet/dispatches/:id",
	"/evidence",
	"/evidence/:id",
	"/arena",
	"/research",
	"/usage",
	"/metrics",
	"/library",
	"/skills",
	"/setup",
	"/system",
	"/system/interop",
] as const;

const matchers = PAGE_PATHS.map((pattern) => {
	const source = pattern
		.split("/")
		.map((segment) =>
			segment === "*" ? ".*" : segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
		)
		.join("/");
	return new RegExp(`^${source}$`);
});

/**
 * `/m/<machine>` in front of a page addresses a registered node's own GUI through this app. The id
 * is a fleet node id, so `local` is never one.
 */
const MACHINE_PREFIX = /^\/m\/((?!local(?:\/|$))[A-Za-z0-9][A-Za-z0-9_-]{0,63})(?=\/|$)/;
export function machinePrefix(path: string): { id: string; prefix: string; rest: string } | null {
	const match = MACHINE_PREFIX.exec(path);
	const id = match?.[1];
	if (id === undefined) return null;
	const prefix = `/m/${id}`;
	return { id, prefix, rest: path.slice(prefix.length) || "/" };
}

/** Whether a request path is a client page rather than an asset, on this machine or through a node prefix. */
export const isPagePath = (path: string): boolean => {
	const page = machinePrefix(path)?.rest ?? path;
	return matchers.some((matcher) => matcher.test(page));
};
