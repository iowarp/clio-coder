import { type Static, Type } from "typebox";

const closed = { additionalProperties: false };

/** The project surfaces `clio-coder config trust` reviews and approves. */
export const TrustSurface = Type.Union([
	Type.Literal("safety"),
	Type.Literal("hooks"),
	Type.Literal("settings"),
	Type.Literal("extensions"),
	Type.Literal("plugins"),
	Type.Literal("handbook"),
]);
export type TrustSurface = Static<typeof TrustSurface>;
export const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
/** As the memory store mints and validates them; never starts with a dash and holds no whitespace. */
export const MemoryId = Type.String({ pattern: "^mem-[a-f0-9]{16}$" });

/** The longest file text one preview carries; longer text arrives cut here with its original length. */
export const TRUST_PREVIEW_TEXT_MAX = 262_144;
export const TRUST_PREVIEW_FILES_MAX = 64;

export const TrustPreviewFile = Type.Object(
	{
		path: Type.String({ maxLength: 4096 }),
		/** Exact captured text; null for an absent or unreadable file. */
		text: Type.Union([Type.String({ maxLength: TRUST_PREVIEW_TEXT_MAX }), Type.Null()]),
		hash: Type.Union([Type.String({ maxLength: 128 }), Type.Null()]),
		error: Type.Optional(Type.String({ maxLength: 4096 })),
		/** Set when `text` was cut to its first 262,144 characters: the original length in characters. */
		truncatedFrom: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	closed,
);
export type TrustPreviewFile = Static<typeof TrustPreviewFile>;
export const TrustPreviewPackage = Type.Object(
	{
		id: Type.String({ maxLength: 1024 }),
		source: Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]),
		kind: Type.Union([Type.String({ maxLength: 256 }), Type.Null()]),
		enabled: Type.Boolean(),
	},
	closed,
);
export const TrustPreview = Type.Object(
	{
		workspaceRoot: Type.String({ maxLength: 4096 }),
		surface: TrustSurface,
		files: Type.Array(TrustPreviewFile, { maxItems: TRUST_PREVIEW_FILES_MAX }),
		/** Null when any file could not be read; such a preview cannot be approved. */
		contentHash: Type.Union([Sha256, Type.Null()]),
		verdict: Type.Union([Type.Literal("trusted"), Type.Literal("untrusted"), Type.Literal("changed")]),
		/** Hooks only: the repository scripts the hooks name. */
		scripts: Type.Optional(Type.Array(TrustPreviewFile, { maxItems: TRUST_PREVIEW_FILES_MAX })),
		/** Extensions and plugins only: the package identities an approval covers. */
		packages: Type.Optional(Type.Array(TrustPreviewPackage, { maxItems: 1024 })),
	},
	closed,
);
export type TrustPreview = Static<typeof TrustPreview>;
export const TrustApproveRequest = Type.Object({ hash: Sha256 }, closed);

export const MemoryDecision = Type.Union([Type.Literal("approve"), Type.Literal("reject")]);
export type MemoryDecision = Static<typeof MemoryDecision>;
export const MemoryDecideRequest = Type.Object({ decision: MemoryDecision }, closed);
const line = Type.String({ maxLength: 4096 });
const lines = Type.Array(line, { maxItems: 64 });
export const MemoryReviewRecord = Type.Object(
	{
		id: MemoryId,
		scope: Type.String({ maxLength: 64 }),
		key: Type.String({ maxLength: 1024 }),
		lesson: Type.String({ maxLength: 16_384 }),
		appliesWhen: lines,
		avoidWhen: lines,
		confidence: Type.Number({ minimum: 0, maximum: 1 }),
		evidenceRefs: lines,
		createdAt: Type.String({ maxLength: 64 }),
		approved: Type.Boolean(),
		rejectedAt: Type.Optional(Type.String({ maxLength: 64 })),
		/** Repository-scoped lessons name the canonical path they apply to. */
		repository: Type.Optional(Type.Object({ key: Type.String({ maxLength: 4096 }) }, closed)),
	},
	closed,
);
export type MemoryReviewRecord = Static<typeof MemoryReviewRecord>;
export const MEMORY_PENDING_MAX = 200;
export const MemoryPending = Type.Object(
	{ records: Type.Array(MemoryReviewRecord, { maxItems: MEMORY_PENDING_MAX }) },
	closed,
);
export type MemoryPending = Static<typeof MemoryPending>;
