import type { Hono, MiddlewareHandler } from "hono";
import { routes } from "../../contracts/routes.js";
import type { DocsService } from "../services/docs.js";
import type { EventHub } from "../services/event-hub.js";
import { AppProblem } from "../services/problem.js";
import { register } from "./validate.js";

// Node preserves the raw target here; URL/Request normalization would otherwise erase dot segments.
export const docsPathGuard: MiddlewareHandler = async (context, next) => {
	const raw = (context.env as { incoming?: { url?: string } } | undefined)?.incoming?.url ?? context.req.path;
	if (raw.startsWith("/docs-html/")) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(raw.split(/[?#]/)[0] ?? "");
		} catch {
			throw new AppProblem("validation", "Malformed documentation URL.", 400);
		}
		if (decoded.includes("\\") || decoded.includes("\0") || decoded.split("/").includes(".."))
			throw new AppProblem("unauthorized", "Documentation path is outside the allowed root.", 403);
	}
	await next();
};

export function docsRoutes(app: Hono, hub: EventHub, docs: DocsService) {
	register(app, hub, routes.docsTree, () => docs.read({ kind: "tree" }, routes.docsTree.response));
	register(app, hub, routes.docsPage, ({ query }) =>
		docs.read({ kind: "page", path: query.path }, routes.docsPage.response),
	);
	register(app, hub, routes.docsSearch, ({ query }) =>
		docs.read({ kind: "search", q: query.q }, routes.docsSearch.response),
	);
	register(app, hub, routes.docsBlueprints, () => docs.read({ kind: "blueprints" }, routes.docsBlueprints.response));
	app.all("/docs-html/*", async (context) => {
		context.header("Allow", "GET, HEAD");
		if (context.req.method !== "GET" && context.req.method !== "HEAD")
			throw new AppProblem("unsupported", "Only GET and HEAD are supported for blueprints.", 405);
		const file = await docs.blueprint(context.req.path.slice("/docs-html/".length));
		context.header("Content-Type", file.type);
		context.header("Content-Length", String(file.size));
		context.header("Cache-Control", "no-store");
		// Blueprint scripts cannot inherit the application's origin, token or API access.
		context.header(
			"Content-Security-Policy",
			"sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'",
		);
		return context.req.method === "HEAD" ? context.body(null) : context.body(new Uint8Array(file.body));
	});
}
