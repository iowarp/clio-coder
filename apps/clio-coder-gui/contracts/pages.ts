// Every address the client router owns. The server answers each one with index.html so a reload or a
// pasted link lands on the page; anything else is an asset or a 404. One list, because two lists
// drifted: /settings/effective was routed in the client and refused by the server.
// tests/pages.test.ts holds this list to the routes client/main.tsx actually declares.

export const PAGE_PATHS = [
	"/",
	"/sessions",
	"/sessions/:id",
	"/workspaces/:workspaceId/sessions",
	"/traces",
	"/traces/:runId",
	"/toolchain",
	"/docs",
	"/docs/*",
	"/settings",
	"/settings/effective",
	"/settings/why",
	"/settings/targets",
	"/settings/routing",
	"/fleet",
	"/fleet/:id",
	"/fleet/dispatches/:id",
	"/evidence",
	"/evidence/:id",
	"/evals",
	"/evals/:id",
	"/usage",
	"/library",
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

/** Whether a request path is a client page rather than an asset. */
export const isPagePath = (path: string): boolean => matchers.some((matcher) => matcher.test(path));
