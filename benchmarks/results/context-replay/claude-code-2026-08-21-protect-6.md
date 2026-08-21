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
| none | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 0 | 0.000 | 18.4 (n=164) |
| random | 165 | 0.483 | 0.431 | 0.926 | 0.947 | 66521.0 | 57.9 | 0.983 | 31.6 (n=162) |
| age-horizon | 165 | 0.479 | 0.427 | 0.923 | 0.948 | 66678.9 | 58.0 | 1.000 | 31.6 (n=162) |
| structural-v1 | 165 | 0.482 | 0.425 | 0.922 | 0.948 | 66484.2 | 58.0 | 0.971 | 31.3 (n=162) |
| oracle | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 66556.0 | 58.9 | 0.991 | 28.5 (n=162) |

## Budget 64000

| policy | n | retention (mean) | retention (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | eviction events (mean) | saturated events | turns to first summary (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 0 | 0.000 | 37.6 (n=157) |
| random | 165 | 0.588 | 0.534 | 0.957 | 0.958 | 65388.9 | 41.9 | 0.959 | 74.6 (n=146) |
| age-horizon | 165 | 0.569 | 0.506 | 0.954 | 0.956 | 65569.0 | 41.4 | 1.000 | 74.7 (n=146) |
| structural-v1 | 165 | 0.570 | 0.508 | 0.958 | 0.955 | 65073.4 | 42.4 | 0.943 | 73.9 (n=148) |
| oracle | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 65221.1 | 42.7 | 0.975 | 68.3 (n=147) |

## Budget 128000

| policy | n | retention (mean) | retention (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | eviction events (mean) | saturated events | turns to first summary (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 0 | 0.000 | 86.1 (n=140) |
| random | 165 | 0.779 | 0.743 | 0.990 | 0.977 | 59286.7 | 20.7 | 0.946 | 150.4 (n=97) |
| age-horizon | 165 | 0.764 | 0.716 | 0.989 | 0.976 | 60445.7 | 20.2 | 1.000 | 150.8 (n=96) |
| structural-v1 | 165 | 0.779 | 0.718 | 0.988 | 0.975 | 59430.6 | 21.6 | 0.897 | 142.8 (n=100) |
| oracle | 165 | 1.000 | 1.000 | 1.000 | 1.000 | 59667.4 | 21.4 | 0.955 | 146.2 (n=97) |
