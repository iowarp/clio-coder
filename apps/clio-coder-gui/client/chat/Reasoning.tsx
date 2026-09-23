/**
 * Reported reasoning, behind a disclosure. Thinking is provenance, not prose: collapsed it is one quiet
 * line with its first sentence, and the words "reported by Clio Coder" travel with it for assistive
 * technology and appear above the full text once opened. The body is only rendered while open, so a
 * long streamed thought does not re-lay out a closed line on every frame.
 */

import { useState } from "react";
import type { TimelineItem } from "../../contracts/sessions.js";
import { REASONING_LABEL, REASONING_SOURCE, reasoningPreview } from "./chat-turn.js";

export function ReasoningDisclosure({ item, compact = false }: { item: TimelineItem; compact?: boolean }) {
	const [open, setOpen] = useState(false);
	return (
		<details
			className={`reasoning${compact ? " reasoning--row" : ""}`}
			onToggle={(event) => setOpen(event.currentTarget.open)}
		>
			<summary className="reasoning__summary" title={`${REASONING_LABEL}, ${REASONING_SOURCE}`}>
				<span className="reasoning__glyph" aria-hidden="true">
					✎
				</span>
				<span className="reasoning__label">{REASONING_LABEL}</span>
				<span className="sr-only">{REASONING_SOURCE}</span>
				<span className="reasoning__preview">{reasoningPreview(item.text, item.status === "in_progress")}</span>
			</summary>
			{open ? (
				<div className="reasoning__body">
					<p className="reasoning__source">{REASONING_SOURCE}</p>
					<p className="reasoning__text">{item.text}</p>
				</div>
			) : null}
		</details>
	);
}
