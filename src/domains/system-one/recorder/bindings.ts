/**
 * Where each site is bound, described from settings alone.
 *
 * Doctor, the settings overlay and `clio-coder systemone status` run without a
 * live session, so they cannot ask a constructed System One for `describe()`.
 * This reads `systemOne.sites` and `systemOne.engines` the way the runtime
 * resolves them and names the first reason a binding cannot answer, so a site
 * that stays silent is distinguishable from one nobody bound. It constructs no
 * engine and reads no credential.
 */

import type { ClioSettings } from "../../../core/config.js";
import type { RuntimeDescriptor } from "../../providers/types/runtime-descriptor.js";
import type { DecisionTask } from "../contract.js";
import { SITE_TASKS } from "../contract.js";
import type { SiteBindingInfo } from "../types.js";
import { SITE_IDS } from "../types.js";

export interface RuntimeLookup {
	get(id: string): RuntimeDescriptor | null;
}

export function describeBindings(settings: Readonly<ClioSettings>, runtimes?: RuntimeLookup): SiteBindingInfo[] {
	const { sites, engines } = settings.systemOne;
	return SITE_IDS.map((site): SiteBindingInfo => {
		const binding = sites[site];
		if (binding === undefined) return { site, engine: null };
		const name = typeof binding === "string" ? binding : binding.engine;
		const timeoutMs = typeof binding === "string" ? undefined : binding.timeoutMs;
		const routed = typeof binding === "string" ? undefined : binding.tasks;
		const deadline = timeoutMs === undefined ? {} : { deadlineMs: timeoutMs };
		const engine = Object.hasOwn(engines, name) ? engines[name] : undefined;
		if (engine === undefined) {
			return { site, engine: name, ...deadline, problem: `engine '${name}' is not defined in systemOne.engines` };
		}
		const described = {
			site,
			engine: name,
			kind: engine.kind,
			target: engine.target,
			model: engine.model ?? null,
			...deadline,
			...(routed !== undefined && Object.keys(routed).length > 0 ? { routes: routed } : {}),
		};
		for (const [task, routedTo] of Object.entries(routed ?? {})) {
			if (!SITE_TASKS[site].includes(task as DecisionTask)) {
				return { ...described, problem: `task ${task} is not asked at site ${site}` };
			}
			if (routedTo !== undefined && !Object.hasOwn(engines, routedTo)) {
				return { ...described, problem: `task ${task} routes to engine '${routedTo}', which is not defined` };
			}
		}
		const target = settings.targets.find((entry) => entry.id === engine.target);
		if (target === undefined) {
			return { ...described, problem: `target '${engine.target}' is not defined in targets` };
		}
		if (runtimes !== undefined) {
			const runtime = runtimes.get(target.runtime);
			if (runtime === null) return { ...described, problem: `runtime '${target.runtime}' is not registered` };
			if (engine.kind === "systemone" && runtime.decide === undefined) {
				return { ...described, problem: `runtime '${runtime.id}' does not answer typed decisions` };
			}
		}
		return described;
	});
}
