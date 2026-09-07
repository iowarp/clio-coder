/** Synthetic valid-format reply for tests of unrelated compaction mechanics. */
export function syntheticCompactionSummary(detail: string): string {
	return `## Goal
${detail}

## Constraints & Preferences
(none)

## Progress
### Done
(none)
### In Progress
(none)
### Blocked
(none)

## Key Decisions
(none)

## Next Steps
(none)

## Critical Context
(none)`;
}
