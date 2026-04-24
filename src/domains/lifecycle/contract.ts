import type { DoctorFinding } from "./doctor.js";
import type { MigrationRunResult } from "./migrations/index.js";
import type { StateInfo } from "./state.js";
import type { VersionInfo } from "./version.js";

export interface LifecycleContract {
	version(): VersionInfo;
	state(): StateInfo | null;
	doctor(): DoctorFinding[];
	runMigrations(dir: string): Promise<MigrationRunResult>;
}
