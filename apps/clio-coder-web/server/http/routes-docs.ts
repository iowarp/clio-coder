import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { DocsService } from "../services/docs.js";
import type { EventHub } from "../services/event-hub.js";
import { register } from "./validate.js";

export function docsRoutes(app: Hono, hub: EventHub, docs: DocsService) {
	register(app, hub, routes.docsTree, () => docs.read({ kind: "tree" }, routes.docsTree.response));
	register(app, hub, routes.docsPage, ({ query }) =>
		docs.read({ kind: "page", path: query.path }, routes.docsPage.response),
	);
	register(app, hub, routes.docsSearch, ({ query }) =>
		docs.read({ kind: "search", q: query.q }, routes.docsSearch.response),
	);
}
