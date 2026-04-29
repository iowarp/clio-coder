export const COMPONENT_KINDS = [
	"prompt-fragment",
	"context-file",
	"tool-implementation",
	"tool-helper",
	"middleware",
	"agent-recipe",
	"runtime-descriptor",
	"safety-rule-pack",
	"config-schema",
	"session-schema",
	"receipt-schema",
	"memory",
	"eval-suite",
	"doc-spec",
] as const;

export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export const COMPONENT_AUTHORITIES = ["advisory", "descriptive", "enforcing", "runtime-critical"] as const;

export type ComponentAuthority = (typeof COMPONENT_AUTHORITIES)[number];

export const COMPONENT_RELOAD_CLASSES = ["hot", "next-dispatch", "restart-required", "static"] as const;

export type ComponentReloadClass = (typeof COMPONENT_RELOAD_CLASSES)[number];

export interface HarnessComponent {
	id: string;
	kind: ComponentKind;
	path: string;
	ownerDomain: string;
	mutable: boolean;
	authority: ComponentAuthority;
	reloadClass: ComponentReloadClass;
	contentHash: string;
	description?: string;
}

export interface ComponentSnapshot {
	version: 1;
	generatedAt: string;
	root: string;
	components: HarnessComponent[];
}

export interface ComponentSnapshotOptions {
	root: string;
	generatedAt?: Date;
}

export type ComponentFieldName = keyof HarnessComponent;

export interface ComponentSnapshotRef {
	root: string;
	generatedAt: string;
	componentCount: number;
}

export interface ComponentDiffSummary {
	added: number;
	removed: number;
	changed: number;
	unchanged: number;
}

export interface ChangedHarnessComponent {
	id: string;
	before: HarnessComponent;
	after: HarnessComponent;
	changedFields: ComponentFieldName[];
}

export interface ComponentDiff {
	version: 1;
	from: ComponentSnapshotRef;
	to: ComponentSnapshotRef;
	summary: ComponentDiffSummary;
	added: HarnessComponent[];
	removed: HarnessComponent[];
	changed: ChangedHarnessComponent[];
}
