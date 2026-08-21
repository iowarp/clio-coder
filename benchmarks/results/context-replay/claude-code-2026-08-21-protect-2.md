<!-- command: node --import tsx src/cli/index.ts context replay --sessions ~/.claude/projects/-home-akougkas-iowarp-clio-coder --policies none,random,age-horizon,structural-v1,oracle --budgets 32000,64000,128000 --protect-last-turns 2 --md <out>.md --json <out>.json -->
<!-- corpus: Claude Code transcripts of the clio-coder project on the operator machine, 2026-08-21; default inclusion filter; source 0acbe6d6 -->

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

| policy | n | retention (mean) | retention (pooled) | retention covered (mean) | retention covered (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | eviction events (mean) | saturated events | turns to first summary (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 0 | 0.000 | 18.9 (n=164) |
| random | 165 | 0.397 | 0.325 | 0.398 | 0.326 | 0.780 | 0.942 | 67237.4 | 53.7 | 0.961 | 42.1 (n=158) |
| age-horizon | 165 | 0.387 | 0.309 | 0.388 | 0.310 | 0.763 | 0.948 | 76253.6 | 61.4 | 1.000 | 44.1 (n=158) |
| structural-v1 | 165 | 0.389 | 0.309 | 0.389 | 0.310 | 0.750 | 0.949 | 76032.9 | 62.3 | 0.945 | 43.2 (n=158) |
| oracle | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 67216.4 | 54.8 | 0.977 | 36.5 (n=158) |

## Budget 64000

| policy | n | retention (mean) | retention (pooled) | retention covered (mean) | retention covered (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | eviction events (mean) | saturated events | turns to first summary (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 0 | 0.000 | 38.8 (n=156) |
| random | 165 | 0.546 | 0.464 | 0.546 | 0.466 | 0.869 | 0.954 | 65668.7 | 39.5 | 0.951 | 82.8 (n=142) |
| age-horizon | 165 | 0.529 | 0.442 | 0.529 | 0.443 | 0.880 | 0.960 | 74726.3 | 44.2 | 1.000 | 88.7 (n=140) |
| structural-v1 | 165 | 0.524 | 0.445 | 0.524 | 0.446 | 0.861 | 0.959 | 74392.0 | 46.6 | 0.911 | 83.0 (n=141) |
| oracle | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 65699.7 | 40.1 | 0.964 | 76.7 (n=142) |

## Budget 128000

| policy | n | retention (mean) | retention (pooled) | retention covered (mean) | retention covered (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | eviction events (mean) | saturated events | turns to first summary (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 0 | 0.000 | 89.3 (n=137) |
| random | 165 | 0.781 | 0.717 | 0.781 | 0.719 | 0.959 | 0.979 | 58993.3 | 18.0 | 0.934 | 162.5 (n=86) |
| age-horizon | 165 | 0.759 | 0.714 | 0.759 | 0.715 | 0.960 | 0.980 | 68054.0 | 18.9 | 1.000 | 175.9 (n=80) |
| structural-v1 | 165 | 0.787 | 0.710 | 0.787 | 0.712 | 0.958 | 0.977 | 65938.3 | 21.0 | 0.849 | 168.5 (n=82) |
| oracle | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 59018.7 | 18.6 | 0.944 | 156.8 (n=86) |
