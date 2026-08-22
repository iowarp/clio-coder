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
| random | 24 | 0.054 | 0.048 | 0.394 | 0.375 | 0.493 | 0.190 | 477781.3 | 360343.5 | 1134713.6 | 88.1 | 0.708 | 18.3 (n=24) | 17.5 |
| age-horizon | 24 | 0.053 | 0.047 | 0.377 | 0.360 | 0.481 | 0.464 | 491792.9 | 361044.8 | 908461.4 | 80 | 1.000 | 19.6 (n=24) | 16.4 |
| structural-v1 | 24 | 0.056 | 0.049 | 0.401 | 0.380 | 0.504 | 0.465 | 485527 | 356052.7 | 1453802 | 108.0 | 0.393 | 19.3 (n=24) | 16.7 |
| oracle | 24 | 0.068 | 0.061 | 0.510 | 0.475 | 0.668 | 1.000 | 106310.5 | 0 | 694008.4 | 66.3 | 0.990 | 10.3 (n=24) | 75.5 |

## Budget 64000

| policy | n | retention (mean) | retention (pooled) | retention covered (mean) | retention covered (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | recall tokens (mean) | cold prefix tokens (mean) | eviction events (mean) | saturated events | turns to first summary (mean) | summaries (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 24 | 0.098 | 0.086 | 0.570 | 0.525 | 0.807 | 1.000 | 0 | 0 | 0 | 0 | 0.000 | 16.3 (n=24) | 21.5 |
| random | 24 | 0.089 | 0.080 | 0.510 | 0.481 | 0.663 | 0.191 | 481724.7 | 364008.9 | 1104063.1 | 45.4 | 0.583 | 36.0 (n=24) | 7.3 |
| age-horizon | 24 | 0.084 | 0.075 | 0.479 | 0.455 | 0.641 | 0.463 | 496445.1 | 363862.8 | 660996.9 | 38.3 | 1.000 | 37.7 (n=24) | 6.8 |
| structural-v1 | 24 | 0.088 | 0.079 | 0.496 | 0.473 | 0.637 | 0.465 | 488382.5 | 357884.2 | 1553591.9 | 63.5 | 0.279 | 37.3 (n=24) | 7.0 |
| oracle | 24 | 0.104 | 0.092 | 0.581 | 0.536 | 0.818 | 1.000 | 105727.3 | 0 | 726891.2 | 27 | 0.981 | 17.6 (n=24) | 18.1 |

## Budget 128000

| policy | n | retention (mean) | retention (pooled) | retention covered (mean) | retention covered (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | recall tokens (mean) | cold prefix tokens (mean) | eviction events (mean) | saturated events | turns to first summary (mean) | summaries (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 24 | 0.156 | 0.140 | 0.642 | 0.599 | 0.900 | 1.000 | 0 | 0 | 0 | 0 | 0.000 | 31.3 (n=24) | 8.9 |
| random | 24 | 0.160 | 0.145 | 0.613 | 0.581 | 0.789 | 0.176 | 491726.8 | 379732.8 | 1107373.2 | 24.9 | 0.574 | 80.5 (n=24) | 3 |
| age-horizon | 24 | 0.149 | 0.135 | 0.595 | 0.562 | 0.783 | 0.446 | 518655.8 | 388170.9 | 526381.6 | 20.4 | 1.000 | 84.6 (n=24) | 2.7 |
| structural-v1 | 24 | 0.157 | 0.144 | 0.612 | 0.586 | 0.769 | 0.451 | 502804.6 | 376062.8 | 1640277.7 | 38.6 | 0.205 | 83.4 (n=24) | 2.9 |
| oracle | 24 | 0.173 | 0.155 | 0.659 | 0.617 | 0.912 | 1.000 | 101728.3 | 0 | 728732.7 | 14.3 | 0.991 | 35.0 (n=24) | 7.4 |
