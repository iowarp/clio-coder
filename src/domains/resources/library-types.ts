/** Catalog identity is separate from skill identity: bundles never enter the skill installer. */
export type LibraryEntryKind = "skill" | "agent" | "prompt" | "fleet" | "plugin";
export type LibraryRequirementRef = `${LibraryEntryKind}:${string}`;
