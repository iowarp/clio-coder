--- @sync entry
-- Enter in Clio's files pane: a directory is entered, and anything else runs
-- the command the keymap passes in, which is the one Ctrl+Y runs to send the
-- selection to Clio. Yazi's default Enter opens with $EDITOR, whose screen
-- would go to Yazi's stdout, the pane's event stream.
return {
	entry = function(_, job)
		local hovered = cx.active.current.hovered
		if not hovered then
			return
		end
		if hovered.cha.is_dir then
			ya.emit("enter", {})
		elseif job.args[1] then
			ya.emit("shell", { job.args[1] })
		end
	end,
}
