/**
 * The one path `/council` takes into execution: the dispatch tool, admitted by
 * the ordinary tool registry.
 *
 * The registry is where classification, safety, autonomy, middleware, and the
 * operator approval park all live. A council started from the composer is a
 * plan-scale dispatch exactly as a council the model asks for is, so it is
 * admitted the same way and parks the same approval overlay. Nothing here
 * builds a request, resolves a route, or touches the dispatch domain.
 */

import { ToolNames } from "../core/tool-names.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { CouncilDispatchOutcome } from "./slash-commands.js";

/**
 * Invoke the dispatch tool with prepared council arguments and report the
 * verdict in the command's own vocabulary. A tool that is not visible in this
 * posture and a call the operator declined are both reported as what they are,
 * because a council that never ran must never read as one that did.
 */
export async function dispatchCouncilThroughRegistry(
	registry: Pick<ToolRegistry, "invoke">,
	args: Readonly<Record<string, unknown>>,
): Promise<CouncilDispatchOutcome> {
	const verdict = await registry.invoke({ tool: ToolNames.Dispatch, args: { ...args } });
	if (verdict.kind === "blocked") return { status: "blocked", reason: verdict.reason };
	if (verdict.kind === "not_visible") return { status: "error", message: verdict.reason };
	return verdict.result.kind === "error" ? { status: "error", message: verdict.result.message } : { status: "ok" };
}
