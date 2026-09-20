import { useId, useState } from "react";
import { tokenFromLaunchInput } from "../api/auth-state.js";
import { adoptToken } from "../api/token.js";

/**
 * Shown when this browser has no launch token or the server refused the one it had. A refused token
 * never starts working again, so this names the two commands that print a fresh link and accepts one.
 */
export function Reconnect({ refused }: { refused: boolean }) {
	const field = useId();
	const [text, setText] = useState("");
	const token = tokenFromLaunchInput(text);
	return (
		<div className="reconnect" role="alert">
			<h1>{refused ? "This browser is no longer connected" : "Open your launch link"}</h1>
			<p>
				{refused
					? "The server refused this browser's launch token. That happens when the server restarted with a new token, or the app was reinstalled. Nothing is wrong with your data, and the old token has been removed from this browser."
					: "This browser has no launch token yet."}
			</p>
			<p>
				Run <code className="reconnect__command">clio-coder gui --open</code> for a foreground server, or{" "}
				<code className="reconnect__command">clio-coder gui background open</code> if the app runs in the background. Either
				opens a fresh link. You can also paste the printed link here.
			</p>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (token) adoptToken(token);
				}}
			>
				<label htmlFor={field}>Launch link or token</label>
				<input
					id={field}
					value={text}
					autoComplete="off"
					spellCheck={false}
					placeholder="http://127.0.0.1:4317/#token=…"
					onChange={(event) => setText(event.target.value)}
				/>
				{text.trim() !== "" && !token && <p className="reconnect__problem">That text holds no launch token.</p>}
				<div className="actions">
					<button type="submit" className="primary" disabled={!token}>
						Connect this browser
					</button>
				</div>
			</form>
		</div>
	);
}
