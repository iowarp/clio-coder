import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { LifecycleContract } from "./contract.js";
import { runDoctor } from "./doctor.js";
import { readInstallInfo } from "./install.js";
import { runPending } from "./migrations/index.js";
import { getVersionInfo } from "./version.js";

export function createLifecycleBundle(_context: DomainContext): DomainBundle<LifecycleContract> {
	const extension: DomainExtension = {
		async start() {
			// lifecycle data is pure read-on-demand; nothing to wire
		},
	};

	const contract: LifecycleContract = {
		version: getVersionInfo,
		install: readInstallInfo,
		doctor: runDoctor,
		runMigrations: (dir: string) => runPending(dir),
	};

	return { extension, contract };
}
