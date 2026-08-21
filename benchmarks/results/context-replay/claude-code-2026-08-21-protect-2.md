<!-- command: node --import tsx src/cli/index.ts context replay --sessions ~/.claude/projects/-home-akougkas-iowarp-clio-coder --policies none,random,age-horizon,structural-v1,oracle --budgets 32000,64000,128000 --protect-last-turns 2 --md <out>.md --json <out>.json -->
<!-- corpus: Claude Code transcripts of the clio-coder project on the operator machine, 2026-08-21; default inclusion filter; source cb4d7a07 -->

# Clio working-set replay

## Inclusion cascade

| stage | traces |
| --- | ---: |
| found | 302 |
| unreadable | 2 |
| sidechain_or_subagent | 17 |
| summary_only | 0 |
| turns_lt_8 | 14 |
| tool_results_lt_8 | 3 |
| no_file_reread | 101 |
| kept | 165 |

## Budget 32000

| policy | n | retention (mean) | retention (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | eviction events (mean) | saturated events | churn (mean) | turns to first summary (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 0 | 0.000 | 0.000 | 18.4 (n=164) |
| random | 165 | 0.389 | 0.317 | 0.762 | 0.942 | 67601.8 | 54.7 | 0.964 | 0.058 | 39.7 (n=160) |
| age-horizon | 165 | 0.405 | 0.325 | 0.787 | 0.970 | 102990.9 | 78.7 | 1.000 | 0.030 | 54.8 (n=152) |
| structural-v1 | 165 | 0.417 | 0.329 | 0.793 | 0.971 | 102754.7 | 82.6 | 0.907 | 0.029 | 52.7 (n=153) |
| oracle | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 67602.7 | 55.7 | 0.979 | 0.000 | 34.3 (n=160) |

## Budget 64000

| policy | n | retention (mean) | retention (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | eviction events (mean) | saturated events | churn (mean) | turns to first summary (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 0 | 0.000 | 0.000 | 37.6 (n=157) |
| random | 165 | 0.530 | 0.450 | 0.853 | 0.954 | 66268.0 | 40.7 | 0.954 | 0.046 | 77.8 (n=145) |
| age-horizon | 165 | 0.540 | 0.462 | 0.892 | 0.977 | 101194.3 | 50.9 | 1.000 | 0.023 | 110.0 (n=125) |
| structural-v1 | 165 | 0.567 | 0.499 | 0.894 | 0.978 | 100305.4 | 56.3 | 0.852 | 0.022 | 103.0 (n=129) |
| oracle | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 66376.8 | 41.3 | 0.967 | 0.000 | 71.7 (n=145) |

## Budget 128000

| policy | n | retention (mean) | retention (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | eviction events (mean) | saturated events | churn (mean) | turns to first summary (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 0 | 0.000 | 0.000 | 86.1 (n=140) |
| random | 165 | 0.755 | 0.704 | 0.948 | 0.975 | 59933.6 | 20.0 | 0.940 | 0.025 | 152.7 (n=96) |
| age-horizon | 165 | 0.771 | 0.730 | 0.983 | 0.988 | 90092.9 | 18.1 | 1.000 | 0.012 | 210.4 (n=55) |
| structural-v1 | 165 | 0.817 | 0.748 | 0.976 | 0.989 | 85565.8 | 22.0 | 0.755 | 0.011 | 202.1 (n=59) |
| oracle | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 60100.0 | 20.6 | 0.950 | 0.000 | 147.8 (n=96) |
