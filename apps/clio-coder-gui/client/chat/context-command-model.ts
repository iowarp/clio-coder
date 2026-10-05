import type { CommandRequest, CommandResult } from "../../contracts/steering.js";
import type { ContextOperation, ContextOperationStatus } from "../../contracts/wire.js";

/**
 * Just enough of a context operation to tell which command started it and whether its card already says
 * what the command's output would. Passing this, not the operation, keeps a progress tick from rendering
 * the composer.
 */
export interface ContextOperationRef {
	id: string;
	kind: ContextOperation["kind"];
	sessionId: string | null;
	origin: ContextOperation["origin"];
	outcome?: NonNullable<ContextOperation["outcome"]>;
	/** The card carries facts, an estimate or a warning, not only its outcome word. */
	told: boolean;
}

export function operationRef(operation: ContextOperation | null | undefined): ContextOperationRef | null {
	if (!operation) return null;
	return {
		id: operation.id,
		kind: operation.kind,
		sessionId: operation.sessionId,
		origin: operation.origin,
		...(operation.outcome ? { outcome: operation.outcome } : {}),
		told: (operation.facts?.length ?? 0) > 0 || operation.tokens !== undefined || (operation.warnings?.length ?? 0) > 0,
	};
}

export function sameOperationRef(a: ContextOperationRef | null, b: ContextOperationRef | null): boolean {
	if (a === null || b === null) return a === b;
	return (
		a.id === b.id &&
		a.kind === b.kind &&
		a.sessionId === b.sessionId &&
		a.origin === b.origin &&
		a.outcome === b.outcome &&
		a.told === b.told
	);
}

/** The operation the session is running, or else the last one it concluded. */
export function currentContextOperation(work: ContextOperationStatus | undefined): ContextOperationRef | null {
	return operationRef(work?.active?.operation ?? work?.latest);
}

// The subcommands of `/context` that open an operation. A bare `/context` only reads the window.
const SUBCOMMAND_KINDS: Readonly<Record<string, ContextOperation["kind"]>> = {
	init: "context-init",
	reset: "context-clear",
	refresh: "context-refresh",
	recall: "context-recall",
	recover: "context-recover",
	compact: "compaction",
};

/** The kind of operation a command opens when it gets as far as starting one, or null for any other command. */
export function contextCommandKind(request: CommandRequest): ContextOperation["kind"] | null {
	if (request.command === "compact") return "compaction";
	if (request.command !== "context") return null;
	const subcommand = request.argv?.[0];
	return subcommand !== undefined && Object.hasOwn(SUBCOMMAND_KINDS, subcommand)
		? (SUBCOMMAND_KINDS[subcommand] ?? null)
		: null;
}

/**
 * The operation this command opened, found by identity: it is new since the command was sent, it is the
 * kind the command opens, it belongs to this session and the operator started it. A command refused before
 * any operation began leaves the previous operation in place, so it matches nothing. An automatic operation
 * of the same kind, such as a compaction that ran while the command was refused, proves nothing about the
 * command; its own card reports it and the refusal stays visible.
 */
export function startedByCommand(
	kind: ContextOperation["kind"] | null,
	sessionId: string,
	baselineId: string | null,
	current: ContextOperationRef | null,
): ContextOperationRef | null {
	if (kind === null || current === null) return null;
	return current.id !== baselineId &&
		current.kind === kind &&
		current.sessionId === sessionId &&
		current.origin === "operator"
		? current
		: null;
}

/** What the command's own result block still shows once an operation card owns the status. */
export interface ContextCommandPresentation {
	/** The generic "Command <level>" mark. */
	status: boolean;
	/** The command's stdout and stderr lines. */
	lines: boolean;
}

const GENERIC: ContextCommandPresentation = { status: true, lines: true };

/**
 * The card owns the status of a context operation, so the command line stops repeating it. The lines stay
 * when they are the only report: the recalled content is the answer to the operator, an unchanged operation
 * with nothing to show is explained by them, and an error the operation's outcome does not account for is a
 * disagreement worth seeing.
 */
export function commandPresentation(
	result: Pick<CommandResult, "level">,
	owner: ContextOperationRef | null,
): ContextCommandPresentation {
	if (owner === null) return GENERIC;
	const outcome = owner.outcome;
	if (outcome === undefined) return { status: false, lines: true };
	if (owner.kind === "context-recall" && outcome === "completed") return { status: false, lines: true };
	if (result.level === "error" && outcome !== "failed" && outcome !== "cancelled") return GENERIC;
	if (outcome === "unchanged" && !owner.told) return { status: false, lines: true };
	return { status: false, lines: false };
}
