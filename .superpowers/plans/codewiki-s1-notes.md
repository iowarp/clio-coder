Slice 1 decisions: Kept schema v3 and symbol shape unchanged.
Regex fallback now admits TS/JS const, let, and var only at column 0 or with export.
TS/JS fallback methods now require class-like indentation and block control-flow names.
Tree-sitter now skips TS/JS variable declarators and Python/Ruby assignments inside function-like ancestors.
Python class assignments stay indexed in the tree-sitter tier because class bodies are not treated as function-like.
writeCodewiki now emits one-line JSON with a trailing newline and preserves the legacy "version": 3 marker.
Dead v3 doc-summary work was removed; v2 summary validation was left intact.
Before reference: 788 files, 31,547 symbols, 4,281 edges, 6.25 MB.
After tree-sitter build: 777 files, 9,280 symbols, 4,240 edges, 1.62 MB.
After regex-only build: 777 files, 8,563 symbols, 4,240 edges, 1.55 MB.
Target result: symbols are under 10k; size is still above 1.5 MB.
Likely reason for size miss: sig strings remain in v3 symbols, and removing or trimming them was not in Slice 1 requirements.
Question for architect: Should a later slice remove or shorten sig fields before the v4 summary work?
