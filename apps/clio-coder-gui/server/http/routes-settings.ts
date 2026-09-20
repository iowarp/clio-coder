import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { EventHub } from "../services/event-hub.js";
import type { SettingsService } from "../services/settings.js";
import { register } from "./validate.js";

export function settingsRoutes(app: Hono, hub: EventHub, settings: SettingsService) {
	register(app, hub, routes.workspaceSettings, ({ params }) => settings.settings(params.id));
	register(app, hub, routes.configGraph, ({ params }) => settings.graph(params.id));
}
