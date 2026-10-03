/**
 * Persistent fleet routing is operator-owned. A coordinator asked to run one
 * worker on a named model once rewrote fleet.profiles and fleet.agentProfiles
 * in yolo with nobody asked; a one-off belongs on the dispatch call instead.
 */
export const FLEET_ROUTING_KEYS: ReadonlyArray<string> = [
	"fleet.default",
	"fleet.profiles",
	"fleet.agentProfiles",
	"fleet.rosters",
	"fleet.adaptiveRouting",
];

export function isFleetRoutingPath(path: string): boolean {
	return FLEET_ROUTING_KEYS.some((key) => path === key || path.startsWith(`${key}.`));
}

/** The alternative every routing refusal names, so a headless model can still finish the task. */
export const ROUTING_PIN_HINT =
	"For a one-off run, pin the worker with dispatch's per-call target and model fields instead of saving routing.";
