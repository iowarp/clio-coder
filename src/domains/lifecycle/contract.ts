import type { DoctorFinding } from "./doctor.js";
import type { InstallInfo } from "./install.js";
import type { VersionInfo } from "./version.js";

export interface LifecycleContract {
	version(): VersionInfo;
	install(): InstallInfo | null;
	doctor(): DoctorFinding[];
}
