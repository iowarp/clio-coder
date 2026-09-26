import { type Hex, type PaletteColor, paletteProjection, type ThemeBackground } from "./theme-token-hex.js";

export type TextIntensity = "subdued" | "supporting" | "reading" | "focal" | "strong";
export type AccentIntent = "neutral" | "ivory" | "cyan" | "turquoise" | "action" | "success" | "warning" | "error";
export type ThemeSurface = "application" | "composer" | "composerDock";
export type RoleState = "normal" | "disabled" | "readOnly" | "selected" | "success" | "warning" | "error";
export type ThemeMode = "normal" | "yolo";
export interface ThemeContext {
	readonly surface: ThemeSurface;
	readonly mode: ThemeMode;
}
export const DEFAULT_THEME_CONTEXT: ThemeContext = { surface: "application", mode: "normal" };

interface TextRole {
	readonly intensity: TextIntensity;
	readonly accent: AccentIntent;
	readonly bold?: boolean;
	/** Only these roles project on declared composer surfaces. */
	readonly yolo?: "ivory" | "orange";
}

const text = (
	intensity: TextIntensity,
	accent: AccentIntent = "neutral",
	options: Omit<TextRole, "intensity" | "accent"> = {},
): TextRole => ({ intensity, accent, ...options });

/** Semantic role matrix: importance and accent intent are independent. */
export const TEXT_ROLES = {
	body: text("reading"),
	secondaryDescription: text("supporting"),
	annotation: text("supporting"),
	metadata: text("subdued"),
	heading: text("reading", "action", { bold: true }),
	sectionHeading: text("reading", "action", { bold: true }),
	inputText: text("strong", "neutral", { yolo: "ivory" }),
	inputPlaceholder: text("focal", "ivory", { yolo: "ivory" }),
	commandHint: text("supporting", "cyan", { yolo: "orange" }),
	draftState: text("reading", "neutral", { yolo: "ivory" }),
	thinkingLevel: text("reading", "neutral", { yolo: "ivory" }),
	harnessAction: text("focal", "action", { bold: true }),
	yoloLabel: text("strong", "action", { bold: true }),
	decisionCue: text("focal", "action", { bold: true }),
	menuOption: text("reading", "ivory", { yolo: "ivory" }),
	selectedOption: text("focal", "cyan", { bold: true }),
	menuDescription: text("supporting"),
	groupHeading: text("reading", "ivory", { bold: true, yolo: "ivory" }),
	disabledOption: text("subdued"),
	searchQuery: text("focal", "cyan"),
	emptyState: text("supporting"),
	positionCount: text("supporting"),
	fieldName: text("supporting", "ivory"),
	fieldValue: text("reading", "ivory"),
	changedValue: text("focal", "cyan"),
	defaultValue: text("supporting"),
	readOnlyFact: text("reading"),
	help: text("supporting"),
	configPath: text("supporting"),
	validationError: text("reading", "error"),
	assistantProse: text("strong"),
	userProse: text("strong"),
	boldEmphasis: text("focal", "ivory", { bold: true }),
	proseEmphasis: text("strong", "neutral", { bold: true }),
	inlineCode: text("reading", "cyan"),
	quotation: text("supporting"),
	link: text("reading", "cyan"),
	citation: text("supporting", "cyan"),
	reasoningExcerpt: text("supporting"),
	toolGlyph: text("focal", "cyan"),
	toolAction: text("focal", "action", { bold: true }),
	// Function accents encode structured acts, never a keyword search over prose.
	shellAction: text("focal", "action", { bold: true }),
	dispatchAction: text("focal", "action", { bold: true }),
	shadowDispatchAction: text("reading", "action", { bold: true }),
	skillAction: text("focal", "action", { bold: true }),
	mcpAction: text("focal", "action", { bold: true }),
	extensionAction: text("reading", "action", { bold: true }),
	contextAction: text("reading", "action", { bold: true }),
	decisionAction: text("focal", "action", { bold: true }),
	artifactAction: text("reading", "action", { bold: true }),
	harnessHeading: text("focal", "action", { bold: true }),
	transcriptHeading: text("focal", "action", { bold: true }),
	toolCapability: text("reading", "cyan"),
	skillIdentity: text("reading", "cyan"),
	workerIdentity: text("reading", "cyan", { bold: true }),
	brandDescriptor: text("reading", "ivory", { bold: true }),
	toolTarget: text("reading"),
	toolCommand: text("reading", "ivory"),
	toolArgument: text("reading"),
	toolArgumentName: text("supporting"),
	toolSummary: text("reading"),
	toolMetadata: text("supporting"),
	foldedHint: text("supporting"),
	wordmark: text("strong", "cyan", { bold: true }),
	brandCopper: text("focal", "action", { bold: true }),
	modelIdentity: text("focal", "ivory"),
	footerIdentity: text("reading"),
	workspacePath: text("supporting"),
	branch: text("supporting"),
	guidance: text("focal", "cyan"),
	counter: text("reading"),
	metricValue: text("focal", "ivory"),
	metricUnit: text("supporting"),
	legend: text("supporting"),
	unknownValue: text("supporting"),
	activity: text("reading", "turquoise", { yolo: "orange" }),
	keyboardHint: text("supporting"),
	notice: text("reading"),
	decisionQuestion: text("focal", "ivory", { bold: true }),
	decisionExplanation: text("reading"),
	decisionConsequence: text("supporting"),
	decisionKey: text("focal", "cyan"),
	pendingAnswer: text("focal", "action", { bold: true }),
	success: text("reading", "success"),
	warning: text("reading", "warning"),
	error: text("reading", "error"),
	info: text("supporting", "cyan"),
	attention: text("focal", "action"),
} as const satisfies Record<string, TextRole>;

/** Structural and category roles are independent of the text intensity ladder. */
export const STRUCTURAL_ROLES = {
	border: "border",
	divider: "divider",
	gutter: "border",
	listMarker: "cyanSupporting",
	scrollMarker: "cyanReading",
	composerRail: "cyanFocal",
	attentionRail: "orangeReading",
	meterFill: "cyanReading",
	activityLow: "cyanSupporting",
	activityMedium: "cyanReading",
	activityHigh: "cyanFocal",
	meterFree: "border",
	meterReserve: "divider",
	meterSystem: "cyanSupporting",
	syntaxKeyword: "orangeFocal",
	syntaxKey: "cyanFocal",
	syntaxString: "success",
	syntaxLiteral: "syntaxLiteral",
	syntaxComment: "neutralSupporting",
	meterTools: "neutralSupporting",
	meterResults: "neutralReading",
	meterAgents: "turquoise",
	meterSkills: "cyanDeep",
	meterMemory: "cyanReading",
	meterProject: "neutralSubdued",
	meterConversation: "cyanFocal",
	selectionBackground: "selectionSurface",
	raisedSurface: "surface",
	composerSurface: "yoloSurface",
	// Explicit inverse pair: use onSelection with selectionBadge as background.
	selectionBadge: "cyanFocal",
	onSelection: "onAccent",
} as const satisfies Record<string, PaletteColor>;

/** Declared function vocabulary; caller data and outcomes keep their own roles. */
export const FUNCTION_ROLES = {
	builtin: "toolAction",
	shell: "shellAction",
	dispatch: "dispatchAction",
	shadowDispatch: "shadowDispatchAction",
	skill: "skillAction",
	mcp: "mcpAction",
	extension: "extensionAction",
	context: "contextAction",
	decision: "decisionAction",
	artifact: "artifactAction",
} as const satisfies Record<string, keyof typeof TEXT_ROLES>;
export type HarnessFunction = keyof typeof FUNCTION_ROLES;

export type SemanticRole = keyof typeof TEXT_ROLES | keyof typeof STRUCTURAL_ROLES;
export interface ResolvedRole {
	readonly color: PaletteColor;
	readonly bold?: boolean;
}

const NEUTRAL: Record<TextIntensity, PaletteColor> = {
	subdued: "neutralSubdued",
	supporting: "neutralSupporting",
	reading: "neutralReading",
	focal: "neutralFocal",
	strong: "neutralStrong",
};
const IVORY: Record<TextIntensity, PaletteColor> = {
	subdued: "ivorySupporting",
	supporting: "ivorySupporting",
	reading: "ivoryReading",
	focal: "ivoryFocal",
	strong: "ivoryStrong",
};
const CYAN: Record<TextIntensity, PaletteColor> = {
	subdued: "cyanSupporting",
	supporting: "cyanSupporting",
	reading: "cyanReading",
	focal: "cyanFocal",
	strong: "cyanStrong",
};
const ORANGE: Record<TextIntensity, PaletteColor> = {
	subdued: "orangeSupporting",
	supporting: "orangeSupporting",
	reading: "orangeReading",
	focal: "orangeFocal",
	strong: "orangeStrong",
};

/** These two surfaces alone participate; errors and selection have no mode override. */
export function projectsYolo(context: ThemeContext): boolean {
	return context.mode === "yolo" && (context.surface === "composer" || context.surface === "composerDock");
}

function resolve(role: SemanticRole, context: ThemeContext): ResolvedRole {
	if (Object.hasOwn(STRUCTURAL_ROLES, role)) return { color: STRUCTURAL_ROLES[role as keyof typeof STRUCTURAL_ROLES] };
	const spec: TextRole = TEXT_ROLES[role as keyof typeof TEXT_ROLES];
	const { intensity, accent } = spec;
	const bold = spec.bold ?? false;
	// Status and selection roles never declare a mode projection. Read-only and
	// disabled are separate roles, so they cannot erase a warning on the same fact.
	if (projectsYolo(context) && spec.yolo) return { color: (spec.yolo === "ivory" ? IVORY : ORANGE)[intensity], bold };
	const color =
		accent === "ivory"
			? IVORY[intensity]
			: accent === "neutral"
				? NEUTRAL[intensity]
				: accent === "cyan"
					? CYAN[intensity]
					: accent === "action"
						? ORANGE[intensity]
						: accent === "turquoise"
							? "turquoise"
							: accent;
	return { color, bold };
}

const NORMAL_CONTEXT: ThemeContext = DEFAULT_THEME_CONTEXT;
const YOLO_CONTEXT: ThemeContext = { surface: "composer", mode: "yolo" };
const ROLE_NAMES = [...Object.keys(TEXT_ROLES), ...Object.keys(STRUCTURAL_ROLES)] as SemanticRole[];
const NORMAL = Object.fromEntries(ROLE_NAMES.map((role) => [role, resolve(role, NORMAL_CONTEXT)])) as Record<
	SemanticRole,
	ResolvedRole
>;
const YOLO = Object.fromEntries(ROLE_NAMES.map((role) => [role, resolve(role, YOLO_CONTEXT)])) as Record<
	SemanticRole,
	ResolvedRole
>;

/** Lookup only: no per-character ramp calculations or component-owned intensity. */
export function resolveRole(
	role: SemanticRole,
	context: ThemeContext = DEFAULT_THEME_CONTEXT,
	state: RoleState = "normal",
): ResolvedRole {
	// Explicit outcomes precede selection and availability; mode is last.
	if (state === "error" || state === "warning" || state === "success") return NORMAL[state];
	// A status role itself is never attenuated by a disabled/read-only state.
	if (role === "error" || role === "warning" || role === "success" || role === "validationError") return NORMAL[role];
	if (state === "selected") return NORMAL.selectedOption;
	if (state === "disabled") return NORMAL.disabledOption;
	if (state === "readOnly") return NORMAL.readOnlyFact;
	return (projectsYolo(context) ? YOLO : NORMAL)[role];
}
export function isSemanticRole(value: string): value is SemanticRole {
	return Object.hasOwn(NORMAL, value);
}
export function roleHex(
	role: SemanticRole,
	background: ThemeBackground | null = null,
	context: ThemeContext = DEFAULT_THEME_CONTEXT,
): Hex {
	return paletteProjection(
		resolveRole(role, context).color,
		projectsYolo(context) ? (background ?? "dark") : background,
	)[0];
}
