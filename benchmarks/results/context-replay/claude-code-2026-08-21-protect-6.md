<!-- command: node --import tsx src/cli/index.ts context replay --sessions ~/.claude/projects/-home-akougkas-iowarp-clio-coder --policies none,random,age-horizon,structural-v1,oracle --budgets 32000,64000,128000 --protect-last-turns 6 --md <out>.md --json <out>.json -->
<!-- corpus: Claude Code transcripts of the clio-coder project on the operator machine, 2026-08-21; default inclusion filter; source ca3f49b6 -->

# Clio working-set replay

## Inclusion cascade

| stage | traces |
| --- | ---: |
| found | 303 |
| unreadable | 2 |
| sidechain_or_subagent | 17 |
| summary_only | 0 |
| turns_lt_8 | 14 |
| tool_results_lt_8 | 3 |
| no_file_reread | 102 |
| kept | 165 |

## Budget 32000

| policy | n | retention (mean) | retention (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | eviction events (mean) | saturated events | turns to first summary (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 0 | 0.000 | 18.9 (n=164) |
| random | 165 | 0.485 | 0.434 | 0.925 | 0.947 | 66522.6 | 56.7 | 0.979 | 33.6 (n=161) |
| age-horizon | 165 | 0.479 | 0.426 | 0.920 | 0.953 | 75284.0 | 64.9 | 1.000 | 34.5 (n=160) |
| structural-v1 | 165 | 0.480 | 0.426 | 0.916 | 0.953 | 75073.8 | 65.5 | 0.963 | 33.7 (n=160) |
| oracle | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 66506.8 | 58.1 | 0.989 | 30.1 (n=161) |

## Budget 64000

| policy | n | retention (mean) | retention (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | eviction events (mean) | saturated events | turns to first summary (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 0 | 0.000 | 38.8 (n=156) |
| random | 165 | 0.603 | 0.548 | 0.961 | 0.960 | 65192.9 | 40.4 | 0.957 | 78.9 (n=144) |
| age-horizon | 165 | 0.582 | 0.522 | 0.960 | 0.962 | 73872.1 | 45.6 | 1.000 | 83.4 (n=142) |
| structural-v1 | 165 | 0.590 | 0.526 | 0.952 | 0.962 | 73522.2 | 47.5 | 0.922 | 79.3 (n=143) |
| oracle | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 65207.3 | 41.4 | 0.972 | 72.6 (n=145) |

## Budget 128000

| policy | n | retention (mean) | retention (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | eviction events (mean) | saturated events | turns to first summary (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 0 | 0.000 | 89.3 (n=137) |
| random | 165 | 0.798 | 0.753 | 0.996 | 0.980 | 58484.7 | 18.5 | 0.938 | 161 (n=88) |
| age-horizon | 165 | 0.788 | 0.745 | 0.996 | 0.982 | 67286.5 | 19.4 | 1.000 | 174.0 (n=81) |
| structural-v1 | 165 | 0.812 | 0.741 | 0.996 | 0.979 | 65404.2 | 21.5 | 0.856 | 167.9 (n=85) |
| oracle | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 58524.2 | 19.3 | 0.949 | 155.7 (n=88) |
