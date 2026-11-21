/**
 * Opens the citation check's reminder, which also reaches the transcript as a notice.
 *
 * A leaf with no imports: src/cli/run.ts matches it before boot, and importing it
 * through citation-grounding.ts pulled the safety, tool and model SDK graph into
 * the headless run's pre-boot closure.
 */
export const CITATION_CHECK_PREFIX = "[CLIO Coder] Citation check:";
