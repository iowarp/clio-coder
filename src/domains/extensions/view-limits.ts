/**
 * Bounds of the view vocabulary and of each surface that draws one. The
 * validator and every renderer read the same numbers, so a view accepted at
 * the protocol boundary always fits the surface it was sent to.
 */
export const VIEW_LIMITS = {
	depth: 6,
	nodes: 400,
	textChars: 2000,
	markdownChars: 8000,
	artLines: 12,
	artColumns: 120,
	kvItems: 32,
	tableColumns: 8,
	tableRows: 100,
	listItems: 100,
	steps: 12,
	boardColumns: 8,
	boardCards: 60,
	cardBadges: 4,
	treeNodes: 200,
	sparkValues: 64,
	actions: 6,
	labelChars: 120,
} as const;

/** Row and column budgets per surface, in terminal cells. */
export const SURFACE_LIMITS = {
	statusChars: 160,
	toastChars: 200,
	bandRows: 3,
	cardRows: 24,
	headerRows: 6,
	boardBandRows: 12,
	boardIslandColumns: 48,
	railColumns: 40,
	footerRows: 2,
	islands: 4,
	islandColumns: 48,
	islandRows: 10,
	interviewQuestions: 4,
	interviewOptions: 12,
	workspaceKeys: 12,
	watchGlobs: 8,
	watchPaths: 64,
} as const;
