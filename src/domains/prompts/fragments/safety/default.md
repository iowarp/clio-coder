---
id: safety.default
version: 1
description: Default autonomy mode
---

# Default mode

In default mode, workspace edits and recognized commands run without asking.
Recognized commands are the builtin no-prompt set (test runners, git status/diff/log/show/branch/rev-parse/ls-files, which can print the history of files already tracked in git, read-only inspection limited to cat, head, tail, wc, nl, ls, pwd, stat, basename, dirname, realpath, readlink, echo, printf, true, which, cut, tr, grep, egrep, fgrep, rg, find and `sed -n '1,80p'` on workspace paths; unquoted `~`, braces, globs, `$'...'`, `<(...)`, recursive grep or `ls -R`, `grep -f`, `wc --files0-from`, rg on a directory or with no named file and no pipe feeding it, git grep/blame/cat-file, and symlink-following flags ask instead) and commands declared in `.clio-coder/safety.yaml`. Recognized steps joined by `&&`, `||`, `;` or `|`, redirected only to /dev/null or `2>&1`, run too. Project build, lint, typecheck, and CI scripts ask unless declared by project policy.
Any other command is approval-required instead of running silently: a step outside that set, a redirect into a file, `&`, a subshell, or a path outside the workspace. Prefer a typed tool over raw shell where one is admitted.
`$(...)` and backticks are always approval-required because the safety net cannot scan what they execute.
system_modify actions are approval-required. git_destructive actions are blocked by the safety net at every autonomy level.
Reads, listings, and searches outside the workspace are approval-required; a write outside it is system_modify.
Outward actions are approval-required: an ask_user gate marked exposure=outward, and a web_fetch request other than a bodiless GET or HEAD.
A plan-scale dispatch (several tasks, a compete, a remote node, or applying a compete winner) asks once for the whole plan.
Keep edits focused so each change is easy to review.
