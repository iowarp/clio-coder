/**
 * The role class table (DESIGN 4.4): the one ceiling every tool list is held to. A recipe's load-time policy, the
 * worker permit's ceiling, the capability-mismatch check and the envelope's role layer all read this table, so a
 * recipe can never be admitted under one table and narrowed or refused under another.
 *
 * Rows are roles: a run's position in the work graph. A recipe's capability class names the row it runs under when no
 * gate gives it another position; `artifact-write` is the builder row narrowed to terminal artifacts.
 */

import { type ToolName, ToolNames } from "../../core/tool-names.js";
import type { RunRole } from "../dispatch/obligation.js";
import { classify } from "../safety/action-classifier.js";
import type { AgentCapabilityClass } from "./spec.js";

export type RoleClass = RunRole | "coordinator";

/** A table row: the tools its role holds, whether it writes, and what to do about a tool it lacks. */
interface RoleRow {
	/** Why the row holds no such tool, as a clause after "<subject> ceiling", or null when it holds it. */
	excludes(tool: string, action: string): string | null;
	/** Tools every run in the row holds whatever its recipe lists; the request and runtime layers still subtract. */
	holds: ReadonlyArray<ToolName>;
	writes: boolean;
	remedy?: string;
}

/** Every position in the work graph reads code, so every row holds code navigation. */
const NAVIGATION: ReadonlyArray<ToolName> = [ToolNames.CodeNav];

const readOnlyRow = (remedy: string): RoleRow => ({
	excludes: (tool, action) => (action === "read" ? null : `excludes ${action} tool ${tool}`),
	holds: NAVIGATION,
	writes: false,
	remedy,
});

/** A checker and a reviewer run declared checks through typed verification; neither holds a shell or a write tool. */
const checksRow = (remedy: string): RoleRow => ({
	excludes: (tool, action) =>
		action === "read" || tool === ToolNames.Verify
			? null
			: `excludes ${tool === ToolNames.Bash ? "bash" : `${action} tool ${tool}`}; checks run through typed verification`,
	holds: NAVIGATION,
	writes: false,
	remedy,
});

const ROLE_TABLE = {
	coordinator: { excludes: () => null, holds: NAVIGATION, writes: true },
	builder: { excludes: () => null, holds: NAVIGATION, writes: true },
	"artifact-builder": {
		excludes: (tool, action) => {
			if (
				action === "execute" ||
				action === "dispatch" ||
				action === "system_modify" ||
				action === "destructive" ||
				action === "git_destructive"
			)
				return `excludes ${action} tool ${tool}`;
			if (action === "write" && tool !== ToolNames.Artifact) return `allows only the artifact write, not ${tool}`;
			return null;
		},
		holds: NAVIGATION,
		writes: true,
		remedy: "an artifact writer changes only terminal artifacts; dispatch a workspace-edit recipe to change files",
	},
	explorer: readOnlyRow("an explorer changes nothing; dispatch with a write scope to run as a builder"),
	checker: checksRow("a checker runs declared checks through verify and changes nothing"),
	reviewer: checksRow("a reviewer judges from evidence and declared checks and changes nothing"),
	judge: readOnlyRow("a judge chooses from the evidence it is given"),
	seat: readOnlyRow("a council seat answers from reads"),
} satisfies Record<RoleClass | "artifact-builder", RoleRow>;

type RoleRowKey = keyof typeof ROLE_TABLE;

/** The row each capability class runs under when no gate position overrides it. */
const CLASS_ROWS: Record<AgentCapabilityClass, { role: RoleClass; row: RoleRowKey }> = {
	"read-only": { role: "explorer", row: "explorer" },
	verification: { role: "checker", row: "checker" },
	"workspace-edit": { role: "builder", row: "builder" },
	"artifact-write": { role: "builder", row: "artifact-builder" },
	orchestration: { role: "coordinator", row: "coordinator" },
	internal: { role: "builder", row: "builder" },
};

/** The role a capability class runs as by default. */
export function capabilityClassRole(capabilityClass: AgentCapabilityClass): RoleClass {
	return CLASS_ROWS[capabilityClass].role;
}

/** True when the class's row changes nothing in the workspace, whatever the task says. */
export function capabilityClassWritesNothing(capabilityClass: AgentCapabilityClass): boolean {
	return !ROLE_TABLE[CLASS_ROWS[capabilityClass].row].writes;
}

function rowFor(role: RoleClass, capabilityClass: AgentCapabilityClass | string | null): RoleRow {
	// A builder whose recipe writes only artifacts keeps that narrowing in every position that writes.
	if (role === "builder" && capabilityClass === "artifact-write") return ROLE_TABLE["artifact-builder"];
	return ROLE_TABLE[role];
}

/** The action class the shared classifier gives a tool, or the one an MCP attestation gave it. */
export function toolActionClass(tool: string, mcpActionClass?: string): string {
	if (mcpActionClass !== undefined) return mcpActionClass;
	return classify({ tool }).actionClass;
}

/**
 * Why `role` (narrowed by its recipe's class) holds no `tool`, as a clause after "<subject> ceiling", or null. The
 * gateway carries no authority of its own; what it reaches is held to the table by name.
 */
export function roleExcludes(
	role: RoleClass,
	capabilityClass: AgentCapabilityClass | string | null,
	tool: string,
	action: string,
): string | null {
	if (tool === ToolNames.Gateway) return null;
	return rowFor(role, capabilityClass).excludes(tool, action);
}

/** The tools `role` (narrowed by its recipe's class) gives every run in it, whatever the recipe declares. */
export function roleHeldTools(
	role: RoleClass,
	capabilityClass: AgentCapabilityClass | string | null,
): ReadonlyArray<ToolName> {
	return rowFor(role, capabilityClass).holds;
}

/** What would keep a tool `role` does not hold. */
export function roleRemedy(role: RoleClass, capabilityClass: AgentCapabilityClass | string | null): string | undefined {
	return rowFor(role, capabilityClass).remedy;
}

/** Why a capability class's own row excludes `tool` (load-time recipe policy and the permit ceiling), or null. */
export function capabilityClassExcludes(
	capabilityClass: AgentCapabilityClass,
	tool: string,
	action: string,
): string | null {
	return roleExcludes(capabilityClassRole(capabilityClass), capabilityClass, tool, action);
}
