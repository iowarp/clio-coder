import type { MiddlewareContract, MiddlewareHost, MiddlewareRegistrar } from "../../src/domains/middleware/index.js";

/** A test that composes middleware holds both halves, as the composition root does. */
export function middlewareOwner(host: MiddlewareHost): MiddlewareContract & MiddlewareRegistrar {
	return { ...host.contract, ...host.registrar };
}
