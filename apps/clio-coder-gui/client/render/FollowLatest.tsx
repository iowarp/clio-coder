import type { FollowLatest } from "./follow-latest.js";
import "./follow-latest.css";

/**
 * One control, one name. New output below the reader marks it rather than renaming it. It shows only while there is
 * something below to jump to: a reader who left a transcript that then fit has no latest to reach.
 */
export function JumpToLatest({ follow }: { follow: FollowLatest }) {
	if (follow.following || !follow.below) return null;
	return (
		<button
			type="button"
			className={`jump-to-latest${follow.unseen ? " has-unseen" : ""}`}
			onClick={follow.jumpToLatest}
			title={follow.unseen ? "New activity below" : undefined}
		>
			<span aria-hidden="true">↓</span>
			Jump to latest
			{follow.unseen ? <span className="sr-only">, new activity below</span> : null}
		</button>
	);
}
