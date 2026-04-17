/**
 * Intelligence domain wire-up. Disabled by default. When
 * `intelligence.enabled === true`, v0.1 fails fast because this build ships no
 * detector implementation.
 */

import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { ConfigContract } from "../config/contract.js";
import type { IntelligenceContract } from "./contracts.js";

type MaybeIntelligenceSettings = { intelligence?: { enabled?: boolean } };

export function createIntelligenceBundle(context: DomainContext): DomainBundle<IntelligenceContract> {
	const maybeConfig = context.getContract<ConfigContract>("config");
	if (!maybeConfig) throw new Error("intelligence domain requires 'config' contract");
	const config: ConfigContract = maybeConfig;
	let enabled = false;

	const extension: DomainExtension = {
		async start() {
			const settings = config.get() as MaybeIntelligenceSettings;
			enabled = settings.intelligence?.enabled === true;
			if (enabled) {
				throw new Error("intelligence.enabled=true but no detector implementation is present in this build");
			}
		},
		async stop() {},
	};

	const contract: IntelligenceContract = {
		enabled: () => enabled,
		observations: () => [],
	};

	return { extension, contract };
}
