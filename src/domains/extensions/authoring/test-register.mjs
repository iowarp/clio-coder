import { registerHooks } from "node:module";

// Only this import is redirected. The absolute preload belongs to the CLI's install, never the package's dependencies or PATH.
const kit = new URL("../../../../dist/extensions/testing.js", import.meta.url).href;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@iowarp/clio-coder/extensions/testing") return { url: kit, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
