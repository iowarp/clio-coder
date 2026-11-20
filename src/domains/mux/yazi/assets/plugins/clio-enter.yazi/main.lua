--- @sync entry
-- Enter in Clio's files pane: a directory is entered. In the companion pane,
-- which carries a pick token, anything else runs the command the keymap passes
-- in, the one Ctrl+Y runs to send the selection to Clio. Yazi's default Enter
-- there opens $EDITOR, whose screen would go to Yazi's stdout, the pane's
-- event stream. Without a token this is the one-shot chooser, where Yazi's own
-- `open` writes the chooser file and quits.
return {
	entry = function(_, job)
		local hovered = cx.active.current.hovered
		if not hovered then
			return
		end
		if hovered.cha.is_dir then
			ya.emit("enter", {})
		elseif job.args[1] and (os.getenv("CLIO_CODER_YAZI_PICK_TOKEN") or "") ~= "" then
			ya.emit("shell", { job.args[1] })
		else
			ya.emit("open", {})
		end
	end,
}
