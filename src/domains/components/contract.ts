import type { ComponentDiff, ComponentSnapshot, ComponentSnapshotOptions, HarnessComponent } from "./types.js";

export interface ComponentsContract {
	list(root: string): Promise<HarnessComponent[]>;
	snapshot(options: ComponentSnapshotOptions): Promise<ComponentSnapshot>;
	diff(from: ComponentSnapshot, to: ComponentSnapshot): ComponentDiff;
}
