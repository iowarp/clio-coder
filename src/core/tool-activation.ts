/**
 * Model-driven tool activation. The palette attaches a small default schema
 * surface per turn; everything else stays names-only in the Tool Catalog.
 * `activate_tools` lets the model widen its own active surface mid-run, but
 * only inside the deterministic session bound (registered tools after profile,
 * worker, and skill narrowing). Policy always wins: a grant can never add a
 * tool the harness did not already allow for this run.
 */

export interface ToolActivationRequest {
	/** Tool and group names the model asked for, as given. */
	requested: ReadonlyArray<string>;
	/** Subset granted after the policy bound was applied. */
	granted: ReadonlyArray<string>;
	/** Subset rejected because the session policy does not include them. */
	rejected: ReadonlyArray<string>;
	/** Model-stated reason, recorded for audit. */
	reason: string;
}

export interface ToolActivationPolicy {
	/**
	 * Current activation bound: every tool the model may activate this run.
	 * The chat loop narrows this when a loaded skill narrows the surface.
	 */
	availableTools: ReadonlyArray<string>;
	/** Tools whose schemas are already attached (seeded from the turn palette). */
	activated: Set<string>;
	/** Validated grants awaiting schema attachment on the next continuation. */
	granted: Set<string>;
	/** Full request history for receipts and diagnostics. */
	requests: ToolActivationRequest[];
}

export function createToolActivationPolicy(
	availableTools: ReadonlyArray<string>,
	activeTools: ReadonlyArray<string>,
): ToolActivationPolicy {
	return {
		availableTools: [...availableTools],
		activated: new Set(activeTools),
		granted: new Set<string>(),
		requests: [],
	};
}

export interface ToolActivationGrant {
	granted: ReadonlyArray<string>;
	alreadyActive: ReadonlyArray<string>;
	rejected: ReadonlyArray<string>;
}

/**
 * Validate one activation request against the policy bound and record it.
 * Pure with respect to inputs other than `policy`, which accumulates the
 * grant; the harness consumes `policy.granted` at the next continuation.
 */
export function grantToolActivation(
	policy: ToolActivationPolicy,
	requestedTools: ReadonlyArray<string>,
	reason: string,
): ToolActivationGrant {
	const bound = new Set(policy.availableTools);
	const seen = new Set<string>();
	const granted: string[] = [];
	const alreadyActive: string[] = [];
	const rejected: string[] = [];
	for (const raw of requestedTools) {
		const name = raw.trim();
		if (name.length === 0 || seen.has(name)) continue;
		seen.add(name);
		if (!bound.has(name)) {
			rejected.push(name);
			continue;
		}
		if (policy.activated.has(name) || policy.granted.has(name)) {
			alreadyActive.push(name);
			continue;
		}
		policy.granted.add(name);
		granted.push(name);
	}
	policy.requests.push({
		requested: [...seen],
		granted,
		rejected,
		reason,
	});
	return { granted, alreadyActive, rejected };
}

/**
 * Grants ready to attach, intersected with the current bound. Called by the
 * continuation guard; moves consumed grants into `activated` so a later pass
 * does not re-attach them.
 */
export function consumeToolActivationGrants(policy: ToolActivationPolicy): string[] {
	if (policy.granted.size === 0) return [];
	const bound = new Set(policy.availableTools);
	const out: string[] = [];
	for (const name of policy.granted) {
		if (bound.has(name) && !policy.activated.has(name)) out.push(name);
		policy.activated.add(name);
	}
	policy.granted.clear();
	return out;
}

/**
 * Narrow the activation bound after a loaded skill narrowed the run surface.
 * Host-wins: the new bound is an intersection, never a widening, and pending
 * grants outside the new bound are dropped.
 */
export function narrowToolActivationBound(policy: ToolActivationPolicy, surface: ReadonlyArray<string>): void {
	const allowed = new Set(surface);
	policy.availableTools = policy.availableTools.filter((tool) => allowed.has(tool));
	for (const name of [...policy.granted]) {
		if (!allowed.has(name)) policy.granted.delete(name);
	}
}
