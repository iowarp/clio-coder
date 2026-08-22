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
| random | 24 | 0.065 | 0.058 | 0.489 | 0.455 | 0.633 | 0.194 | 345050.0 | 255131.8 | 2208516.1 | 107.2 | 0.988 | 12.8 (n=24) | 45.2 |
| age-horizon | 24 | 0.066 | 0.058 | 0.490 | 0.456 | 0.634 | 0.490 | 357122.1 | 256035.3 | 2215075.6 | 107 | 1.000 | 13.4 (n=24) | 43.4 |
| structural-v1 | 24 | 0.067 | 0.059 | 0.496 | 0.461 | 0.643 | 0.490 | 354462.6 | 253341.9 | 2565091.0 | 120.4 | 0.562 | 13.3 (n=24) | 43.7 |
| oracle | 24 | 0.065 | 0.058 | 0.498 | 0.463 | 0.636 | 1.000 | 73491.7 | 0 | 1235044.4 | 57.3 | 1.000 | 9.8 (n=24) | 93.9 |

## Budget 64000

| policy | n | retention (mean) | retention (pooled) | retention covered (mean) | retention covered (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | recall tokens (mean) | cold prefix tokens (mean) | eviction events (mean) | saturated events | turns to first summary (mean) | summaries (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 24 | 0.098 | 0.086 | 0.570 | 0.525 | 0.807 | 1.000 | 0 | 0 | 0 | 0 | 0.000 | 16.3 (n=24) | 21.5 |
| random | 24 | 0.099 | 0.088 | 0.560 | 0.522 | 0.773 | 0.197 | 421782.2 | 314697.5 | 1380497 | 45.6 | 0.697 | 30.3 (n=24) | 9 |
| age-horizon | 24 | 0.097 | 0.086 | 0.551 | 0.513 | 0.768 | 0.466 | 436235.5 | 318124.8 | 1128387.2 | 42.2 | 1.000 | 31.3 (n=24) | 8.6 |
| structural-v1 | 24 | 0.100 | 0.089 | 0.565 | 0.526 | 0.764 | 0.468 | 432288.1 | 314075.2 | 1972348.2 | 64.2 | 0.310 | 31 (n=24) | 8.7 |
| oracle | 24 | 0.103 | 0.091 | 0.579 | 0.533 | 0.813 | 1.000 | 90219.3 | 0 | 919714.4 | 26 | 0.998 | 17.4 (n=24) | 18.7 |

## Budget 128000

| policy | n | retention (mean) | retention (pooled) | retention covered (mean) | retention covered (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | recall tokens (mean) | cold prefix tokens (mean) | eviction events (mean) | saturated events | turns to first summary (mean) | summaries (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 24 | 0.156 | 0.140 | 0.642 | 0.599 | 0.900 | 1.000 | 0 | 0 | 0 | 0 | 0.000 | 31.3 (n=24) | 8.9 |
| random | 24 | 0.169 | 0.153 | 0.656 | 0.617 | 0.887 | 0.192 | 473012.5 | 358064.4 | 1306503.3 | 25.4 | 0.621 | 72.3 (n=24) | 3.1 |
| age-horizon | 24 | 0.158 | 0.144 | 0.638 | 0.599 | 0.880 | 0.448 | 479335.3 | 359762.7 | 773214.3 | 20.4 | 1.000 | 73.9 (n=24) | 3.0 |
| structural-v1 | 24 | 0.165 | 0.150 | 0.656 | 0.620 | 0.870 | 0.458 | 476888.2 | 352538.3 | 1894460.8 | 38.1 | 0.233 | 73.3 (n=24) | 3.1 |
| oracle | 24 | 0.171 | 0.153 | 0.657 | 0.615 | 0.905 | 1.000 | 95595.3 | 0 | 871715.8 | 13.9 | 0.994 | 34.8 (n=24) | 7.6 |
