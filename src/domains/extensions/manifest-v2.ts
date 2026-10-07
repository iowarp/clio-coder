/**
 * The `runtime` block of an extension manifest at `api: 2`. Everything an
 * extension may do is declared here, so discovery and review stay code-free:
 * registration in code must match these lists exactly.
 */
import type {
	ExtensionContentAccess,
	ExtensionHookPoint,
	ExtensionObservationEventV2,
	WorkspaceRegion,
} from "./public-api-v2.js";

export type ExtensionSlot = "status" | "band" | "card" | "toast" | "panel" | "dock" | "interview";

export interface ExtensionCommandDeclarationV2 {
	name: string;
	description: string;
	timeoutMs: number;
	/** Bundle only: this command owns `/<plugin>:<name>` in place of the package's prompt of that name. */
	replaces?: "prompt";
}

export interface ExtensionHookDeclaration {
	on: ExtensionHookPoint;
	/** Tool names the hook matches; absent means every tool at a tool point. */
	tools?: string[];
	timeoutMs: number;
	/** A gate declares how it fails. `block` makes a missed deadline or a thrown handler refuse the call. */
	onTimeout: "pass" | "block";
	onError: "pass" | "block";
}

export interface ExtensionRuntimeToolDeclaration {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	/** `read` is admitted only when the package declares neither exec nor a write root beyond its store. */
	actionClass: "read" | "execute";
	timeoutMs: number;
}

export interface ExtensionWorkspaceDeclaration {
	id: string;
	title: string;
	regions: Array<WorkspaceRegion | "islands">;
	/** Where the board region is drawn. */
	board?: "band" | "island";
	/** Package-relative path of the skin JSON, validated at discovery. */
	skin?: string;
	/** Leader menu entries live while the workspace is active. */
	keys?: Array<{ key: string; action: string; label: string }>;
}

export interface ExtensionPermissionsDeclaration {
	fs: {
		/** `package` is always readable. */
		read: Array<"workspace" | "home" | string>;
		write: Array<"store" | string>;
	};
	exec: boolean;
	net: boolean;
}

export interface ExtensionConfigField {
	key: string;
	type: "string" | "number" | "boolean";
	default: string | number | boolean;
	description: string;
	/** A string field that lists options is a picker over exactly those values. */
	options?: string[];
}

export interface ExtensionRuntimeDeclarationV2 {
	api: 2;
	entrypoint: string;
	commands: ExtensionCommandDeclarationV2[];
	events: Array<Exclude<ExtensionObservationEventV2, "tick">>;
	/** Tick interval in milliseconds, at least 5000; absent when the extension declares no tick. */
	tickMs?: number;
	/** Workspace-relative globs the host watches for `fs_changed`. */
	watch: string[];
	hooks: ExtensionHookDeclaration[];
	tools: ExtensionRuntimeToolDeclaration[];
	ui: ExtensionSlot[];
	workspaces: ExtensionWorkspaceDeclaration[];
	access: ExtensionContentAccess[];
	permissions: ExtensionPermissionsDeclaration;
	state: { session: boolean; store: boolean };
	/** Host services reachable over the extension IPC only after operator consent. */
	services?: { embedding: boolean };
	config: ExtensionConfigField[];
}

/**
 * The part of a declaration the operator consents to. Its canonical JSON is
 * hashed into the capability envelope: bytes may change freely inside an
 * approved envelope, and a wider one asks again.
 */
export type ExtensionCapabilityEnvelope = Pick<
	ExtensionRuntimeDeclarationV2,
	"hooks" | "ui" | "watch" | "access" | "permissions" | "events" | "tickMs"
> & {
	commands: string[];
	/** `<plugin>:<command>` prompt names the package's commands take over; absent when none. */
	takesOver?: string[];
	/**
	 * Host-held state the package keeps: per-session values and the cross-session
	 * store. Absent when it keeps neither, which keeps those digests stable.
	 */
	state?: ExtensionRuntimeDeclarationV2["state"];
	services?: { embedding: boolean };
	tools: Array<Pick<ExtensionRuntimeToolDeclaration, "name" | "actionClass">>;
	workspaces: Array<Pick<ExtensionWorkspaceDeclaration, "id" | "regions" | "board" | "keys">>;
};
