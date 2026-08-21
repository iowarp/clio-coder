<!-- command: node --import tsx src/cli/index.ts context replay --sessions ~/.claude/projects/-home-akougkas-iowarp-clio-coder --policies none,random,age-horizon,structural-v1,oracle --budgets 32000,64000,128000 --protect-last-turns 6 --md <out>.md --json <out>.json -->
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
| tool_results_lt_8 | 4 |
| no_file_reread | 100 |
| kept | 165 |

## Budget 32000

| policy | n | retention (mean) | retention (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | eviction events (mean) | saturated events | churn (mean) | turns to first summary (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 0 | 0.000 | 0.000 | 18.4 (n=164) |
| random | 165 | 0.483 | 0.431 | 0.926 | 0.947 | 66849.3 | 57.8 | 0.983 | 0.053 | 31.9 (n=162) |
| age-horizon | 165 | 0.487 | 0.434 | 0.935 | 0.973 | 101707.8 | 83.8 | 1.000 | 0.027 | 40.7 (n=157) |
| structural-v1 | 165 | 0.488 | 0.435 | 0.927 | 0.973 | 101485.4 | 86.8 | 0.929 | 0.027 | 38.8 (n=158) |
| oracle | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 66884.5 | 58.8 | 0.991 | 0.000 | 28.6 (n=162) |

## Budget 64000

| policy | n | retention (mean) | retention (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | eviction events (mean) | saturated events | churn (mean) | turns to first summary (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 0 | 0.000 | 0.000 | 37.6 (n=157) |
| random | 165 | 0.588 | 0.535 | 0.957 | 0.958 | 65689.5 | 41.8 | 0.959 | 0.042 | 74.9 (n=146) |
| age-horizon | 165 | 0.584 | 0.528 | 0.972 | 0.977 | 99935.2 | 53.3 | 1.000 | 0.023 | 103.0 (n=130) |
| structural-v1 | 165 | 0.605 | 0.559 | 0.967 | 0.980 | 99347.8 | 58.1 | 0.866 | 0.020 | 98.5 (n=132) |
| oracle | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 65534.4 | 42.7 | 0.975 | 0.000 | 68.7 (n=147) |

## Budget 128000

| policy | n | retention (mean) | retention (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | eviction events (mean) | saturated events | churn (mean) | turns to first summary (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 0 | 0.000 | 0.000 | 86.1 (n=140) |
| random | 165 | 0.779 | 0.742 | 0.990 | 0.977 | 59476.4 | 20.6 | 0.945 | 0.023 | 151.2 (n=97) |
| age-horizon | 165 | 0.781 | 0.750 | 0.998 | 0.989 | 89686.8 | 18.9 | 1.000 | 0.011 | 206.0 (n=57) |
| structural-v1 | 165 | 0.831 | 0.769 | 0.997 | 0.990 | 84848.4 | 22.4 | 0.771 | 0.010 | 194.9 (n=61) |
| oracle | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 59886.6 | 21.3 | 0.955 | 0.000 | 146.7 (n=97) |
