/**
 * Resolves which providers are ACTIVE given current settings + present
 * credentials. Pure function; callers supply the credential-presence set.
 */

import type { ClioSettings } from "../../core/config.js";
import { PROVIDER_CATALOG, type ProviderId } from "./catalog.js";

export interface ProviderAvailability {
	id: ProviderId;
	available: boolean;
	reason: string;
	hasCredential: boolean;
}

export function discoverProviders(opts: {
	settings: Readonly<ClioSettings>;
	credentialsPresent: ReadonlySet<string>;
}): ReadonlyArray<ProviderAvailability> {
	const enabled = new Set<string>(opts.settings.runtimes?.enabled ?? []);

	return PROVIDER_CATALOG.map((spec) => {
		const credEnv = spec.credentialsEnvVar;
		const hasCredential = credEnv === undefined ? true : opts.credentialsPresent.has(credEnv);
		const isEnabled = enabled.has(spec.id);

		let reason: string;
		let available: boolean;
		if (!isEnabled) {
			available = false;
			reason = "disabled";
		} else if (!hasCredential) {
			available = false;
			reason = "missing credential";
		} else {
			available = true;
			reason = "active in settings";
		}

		return {
			id: spec.id,
			available,
			reason,
			hasCredential,
		};
	});
}
