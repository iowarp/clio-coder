# Clio working-set replay

## Inclusion cascade

| stage | traces |
| --- | ---: |
| found | 24 |
| unreadable | 0 |
| turns_lt_8 | 0 |
| tool_results_lt_8 | 0 |
| no_file_reread | 0 |
| kept | 24 |

## Budget 32000

| policy | n | retention (mean) | retention (pooled) | retention covered (mean) | retention covered (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | recall tokens (mean) | cold prefix tokens (mean) | eviction events (mean) | saturated events | turns to first summary (mean) | summaries (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 24 | 0.063 | 0.056 | 0.491 | 0.456 | 0.619 | 1.000 | 0 | 0 | 0 | 0 | 0.000 | 9.6 (n=24) | 108 |
| random | 24 | 0.065 | 0.058 | 0.489 | 0.455 | 0.630 | 0.194 | 342880.8 | 253060.7 | 2224027.0 | 107.6 | 0.989 | 12.5 (n=24) | 46.9 |
| age-horizon | 24 | 0.066 | 0.058 | 0.490 | 0.455 | 0.632 | 0.491 | 356988.1 | 255026.8 | 2248117.1 | 108.3 | 1.000 | 13.1 (n=24) | 44.4 |
| structural-v1 | 24 | 0.067 | 0.059 | 0.495 | 0.460 | 0.641 | 0.492 | 351901.0 | 250848.3 | 2596310.0 | 121.5 | 0.556 | 12.8 (n=24) | 45.3 |
| oracle | 24 | 0.065 | 0.057 | 0.497 | 0.462 | 0.634 | 1.000 | 73281.2 | 0 | 1239417.2 | 57.1 | 1.000 | 9.8 (n=24) | 96.0 |

## Budget 64000

| policy | n | retention (mean) | retention (pooled) | retention covered (mean) | retention covered (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | recall tokens (mean) | cold prefix tokens (mean) | eviction events (mean) | saturated events | turns to first summary (mean) | summaries (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 24 | 0.098 | 0.086 | 0.570 | 0.525 | 0.807 | 1.000 | 0 | 0 | 0 | 0 | 0.000 | 16.3 (n=24) | 21.5 |
| random | 24 | 0.099 | 0.088 | 0.560 | 0.521 | 0.775 | 0.195 | 422295.3 | 315670.1 | 1383856.1 | 45.5 | 0.700 | 29.9 (n=24) | 9.2 |
| age-horizon | 24 | 0.096 | 0.086 | 0.549 | 0.513 | 0.767 | 0.467 | 437511.9 | 318692.9 | 1134365.3 | 42 | 1.000 | 31 (n=24) | 8.7 |
| structural-v1 | 24 | 0.099 | 0.088 | 0.565 | 0.527 | 0.764 | 0.468 | 433089.2 | 314108.1 | 1984085.1 | 64 | 0.312 | 30.8 (n=24) | 8.8 |
| oracle | 24 | 0.102 | 0.090 | 0.578 | 0.532 | 0.813 | 1.000 | 90255.5 | 0 | 925429.1 | 25.9 | 0.998 | 17.3 (n=24) | 18.9 |

## Budget 128000

| policy | n | retention (mean) | retention (pooled) | retention covered (mean) | retention covered (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | recall tokens (mean) | cold prefix tokens (mean) | eviction events (mean) | saturated events | turns to first summary (mean) | summaries (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 24 | 0.156 | 0.140 | 0.642 | 0.599 | 0.900 | 1.000 | 0 | 0 | 0 | 0 | 0.000 | 31.3 (n=24) | 8.9 |
| random | 24 | 0.169 | 0.154 | 0.654 | 0.616 | 0.886 | 0.195 | 477471.9 | 359935.8 | 1334062.9 | 26.2 | 0.623 | 71.9 (n=24) | 3.1 |
| age-horizon | 24 | 0.158 | 0.144 | 0.637 | 0.599 | 0.880 | 0.451 | 483846.1 | 360773.3 | 784879.1 | 20.7 | 1.000 | 73.3 (n=24) | 3.1 |
| structural-v1 | 24 | 0.166 | 0.151 | 0.660 | 0.623 | 0.877 | 0.456 | 475296.6 | 352548.1 | 1820525.3 | 36.5 | 0.243 | 73.0 (n=24) | 3.1 |
| oracle | 24 | 0.170 | 0.152 | 0.655 | 0.613 | 0.902 | 1.000 | 92792.3 | 0 | 873401.8 | 13.7 | 0.997 | 34.6 (n=24) | 7.7 |
