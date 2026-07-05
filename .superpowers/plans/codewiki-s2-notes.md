# Codewiki S2 Notes
- Unified `buildCodewiki` and `updateCodewikiPaths` use a cached tree-sitter extractor; regex symbols run only on unsupported or failed parses, with regex imports unioned on AST success.
- Deleted `buildCodewikiWithTreeSitter` and updated callers; context start is fire-and-forget, while context stop awaits the final codewiki write.
- C# uses `tree-sitter-c_sharp` for declarations, `using_directive` imports, properties as `var`, and static readonly or const fields as `const`.
- TS/JS tree-sitter exports now come from `export_statement` clauses and declarations; Python, Go, Rust, Java, and Ruby keep prior cheap export conventions.
- Ruby WASM currently throws on parse in this environment, so Ruby files degrade per file to regex fallback; import coverage remains from `require` and `require_relative`.
- Measurement S2 worktree: files 777, symbols 8624, edges 4245, internal edges 3083, size 1.55 MB.
- S1 baseline measured in `../clio-s1`: edges 4240, internal edges 3080, size 1.62 MB; S2 is +5 total edges and +3 internal edges.
- Touched outside core list: `tests/contracts/code-nav-cap-stub.test.ts` and `tests/contracts/prompts.test.ts` for mechanical `await buildCodewiki` compile fixes.
- Architect question: should Ruby remain listed as tree-sitter-covered while the shipped WASM throws, or should a later slice disable that grammar until `tree-sitter-wasms` fixes it?
