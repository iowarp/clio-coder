import { readSettings } from "../core/config.js";
import { yoloRootRefusal } from "../core/yolo-host.js";
import { effectiveYoloConfinement } from "../domains/safety/autonomy.js";

/**
 * Why `research` or `arena` cannot hand its agent runs yolo here, or null when they can. Both run every agent as a
 * headless `clio-coder run --autonomy yolo`, which takes its confinement from the operator's user settings; these
 * surfaces promise contained yolo (sandbox, safety judge, autonomous caps, open decisions), so an operator whose
 * settings choose unconfined yolo is refused rather than handed it. Root outside a container is refused as `run` does.
 */
export function containedYoloRefusal(surface: "research" | "arena"): string | null {
	const root = yoloRootRefusal();
	if (root !== null) return root;
	if (effectiveYoloConfinement(readSettings().safety) === "unconfined")
		return `${surface} runs yolo contained only, and your user settings choose unconfined yolo (safety.yoloConfinement); set it back to contained to use --autonomy yolo here`;
	return null;
}
