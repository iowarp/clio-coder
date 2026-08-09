import { createInteractiveApplication, type InteractiveDeps } from "./interactive-application.js";

export * from "./interactive-application.js";

/**
 * Process-boundary composition entry point. The application module owns the
 * terminal lifecycle while its collaborators own independently testable state.
 */
export async function startInteractive(deps: InteractiveDeps): Promise<number> {
	return createInteractiveApplication(deps);
}
