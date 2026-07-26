/** Reports credentials available to configured provider runtimes. */

import { openAuthStorage } from "./auth/index.js";
import { getRuntimeRegistry } from "./registry.js";

export function credentialsPresent(): Set<string> {
	const present = new Set<string>();
	const registry = getRuntimeRegistry();
	const auth = openAuthStorage();
	for (const desc of registry.list()) {
		const envVar = desc.credentialsEnvVar;
		if (!envVar) continue;
		const providerId = desc.id;
		const status = auth.status(providerId, { explicitEnvVar: envVar, includeFallback: false });
		if (status.available) {
			present.add(envVar);
		}
	}
	return present;
}
