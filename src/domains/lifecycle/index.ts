import type { DomainModule } from "../../core/domain-loader.js";
import { createLifecycleBundle } from "./extension.js";
import { LifecycleManifest } from "./manifest.js";

export const LifecycleDomainModule: DomainModule = {
	manifest: LifecycleManifest,
	createExtension: createLifecycleBundle,
};

export type { LifecycleContract } from "./contract.js";
export { type DoctorFinding, formatDoctorReport, runDoctor } from "./doctor.js";
export { ensureInstalled, type InstallInfo, readInstallInfo } from "./install.js";
export {
	listMigrations,
	type Migration,
	type MigrationManifest,
	type MigrationRunResult,
	runPending,
} from "./migrations/index.js";
export { getVersionInfo, type VersionInfo } from "./version.js";
