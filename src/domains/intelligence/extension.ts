/**
 * Intelligence domain wire-up. Disabled by default: when the settings file has
 * no `intelligence.enabled === true` flag, extension.start() short-circuits and
 * no bus subscriptions are registered. The contract still answers queries so
 * callers don't have to guard for undefined.
 */

import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { ConfigContract } from "../config/contract.js";
import type { IntelligenceContract } from "./contracts.js";
import { type IntentDetector, createIntentDetectorStub } from "./intent-detector.js";

type MaybeIntelligenceSettings = { intelligence?: { enabled?: boolean } };

export function createIntelligenceBundle(context: DomainContext): DomainBundle<IntelligenceContract> {
	const maybeConfig = context.getContract<ConfigContract>("config");
	if (!maybeConfig) throw new Error("intelligence domain requires 'config' contract");
	const config: ConfigContract = maybeConfig;
	const detector: IntentDetector = createIntentDetectorStub();
	let enabled = false;

	const extension: DomainExtension = {
		async start() {
			const settings = config.get() as MaybeIntelligenceSettings;
			enabled = settings.intelligence?.enabled === true;
			if (!enabled) return;
			detector.start();
		},
		async stop() {
			if (!enabled) return;
			detector.stop();
		},
	};

	const contract: IntelligenceContract = {
		enabled: () => enabled,
		observations: () => (enabled ? detector.latest() : []),
	};

	return { extension, contract };
}
