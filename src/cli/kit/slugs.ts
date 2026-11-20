/**
 * The closed set of CLI error slugs (CLI convention C17). A `--json` failure
 * document carries one in `error.code`, and `schema help` publishes the list,
 * so a new slug is a contract change, not a local choice.
 *
 * Leaf of the CLI kit: imports nothing.
 */
export const ERROR_SLUGS = [
	"usage",
	"unknown_command",
	"unknown_flag",
	"flag_conflict",
	"empty_task",
	"task_file_conflict",
	"task_flag_conflict",
	"task_authority",
	"schema_unsupported",
	"not_found",
	"ambiguous",
	"confirmation_required",
	"declined",
	"session_live",
	"session_has_children",
	"not_configured",
	"admission_refused",
	"unsupported_on_route",
	"busy",
	"io",
	"context_overflow",
] as const;

export type ErrorSlug = (typeof ERROR_SLUGS)[number];
