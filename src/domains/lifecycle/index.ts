import type { DomainModule } from "../../core/domain-loader.js";
import { createLifecycleBundle } from "./extension.js";
import { LifecycleManifest } from "./manifest.js";

export const LifecycleDomainModule: DomainModule = {
	manifest: LifecycleManifest,
	createExtension: createLifecycleBundle,
};

export type { LifecycleContract } from "./contract.js";
export { getVersionInfo, type VersionInfo } from "./version.js";
export { readInstallInfo, ensureInstalled, type InstallInfo } from "./install.js";
export { runDoctor, formatDoctorReport, type DoctorFinding } from "./doctor.js";
