# Codewiki S6 Notes
- Added wiki staleness, prompt/wiki-nav surfacing, refresh opt-in wiring, dashboard surfacing, and builtin-agent guidance.
- Refresh wiki generation remains unreachable unless `wiki: true` or `clio context refresh --wiki` is explicit.
- Mechanical implementation-file exception: `src/tools/bootstrap.ts` promptHint now lists `wiki` so the byte-tested tool contract matches `code_nav`.
- Question: CLIO.md normally asks for CHANGELOG.md on user-visible CLI behavior, but Slice 6 did not allow CHANGELOG.md, so I left it untouched.
