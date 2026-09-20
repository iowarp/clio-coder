import type { FollowLatest } from "./follow-latest.js";
import "./follow-latest.css";

export function JumpToLatest({ follow }: { follow: FollowLatest }) {
	if (follow.following) return null;
	return (
		<button type="button" className={`jump-to-latest${follow.unseen ? " has-unseen" : ""}`} onClick={follow.jumpToLatest}>
			<span aria-hidden="true">↓</span>
			{follow.unseen ? "New activity below" : "Jump to latest"}
		</button>
	);
}
