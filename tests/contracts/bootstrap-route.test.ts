import { match, throws } from "node:assert/strict";
import { it } from "node:test";
import { resolveBootstrapRoute } from "../../src/cli/bootstrap-generate.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";

it("names the current fleet settings keys when bootstrap has no route", () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.agentProfiles = {};
	settings.fleet.default = { ...settings.fleet.default, target: null };
	throws(
		() => resolveBootstrapRoute(settings),
		(error: Error) => {
			match(error.message, /fleet\.agentProfiles\.context-bootstrap is unbound/);
			match(error.message, /fleet\.default has no target/);
			match(error.message, /set fleet\.default\.target/);
			return !/workers\./.test(error.message);
		},
	);
});
