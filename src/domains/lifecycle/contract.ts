import type { DoctorFinding } from "./doctor.js";
import type { InstallInfo } from "./install.js";
import type { MigrationRunResult } from "./migrations/index.js";
import type { VersionInfo } from "./version.js";

export interface LifecycleContract {
	version(): VersionInfo;
	install(): InstallInfo | null;
	doctor(): DoctorFinding[];
	runMigrations(dir: string): Promise<MigrationRunResult>;
}
