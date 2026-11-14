import type { FollowLatest } from "./follow-latest.js";
import "./follow-latest.css";

/** One control, one name. New output below the reader marks it rather than renaming it. */
export function JumpToLatest({ follow }: { follow: FollowLatest }) {
	if (follow.following) return null;
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
