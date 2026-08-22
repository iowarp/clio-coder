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
| random | 24 | 0.054 | 0.048 | 0.394 | 0.375 | 0.494 | 0.189 | 477205.4 | 360450.8 | 1119788.6 | 87.5 | 0.711 | 18.5 (n=24) | 17.1 |
| age-horizon | 24 | 0.054 | 0.048 | 0.378 | 0.361 | 0.481 | 0.464 | 492332 | 361064.5 | 908414.3 | 80.8 | 1.000 | 20.2 (n=24) | 16 |
| structural-v1 | 24 | 0.056 | 0.050 | 0.397 | 0.377 | 0.501 | 0.465 | 487060.2 | 356928.3 | 1443297.8 | 108.8 | 0.402 | 19.7 (n=24) | 16.1 |
| oracle | 24 | 0.068 | 0.061 | 0.512 | 0.476 | 0.670 | 1.000 | 106249.3 | 0 | 693652.0 | 65.6 | 0.990 | 10.3 (n=24) | 74.3 |

## Budget 64000

| policy | n | retention (mean) | retention (pooled) | retention covered (mean) | retention covered (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | recall tokens (mean) | cold prefix tokens (mean) | eviction events (mean) | saturated events | turns to first summary (mean) | summaries (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 24 | 0.098 | 0.086 | 0.570 | 0.525 | 0.807 | 1.000 | 0 | 0 | 0 | 0 | 0.000 | 16.3 (n=24) | 21.5 |
| random | 24 | 0.089 | 0.080 | 0.506 | 0.480 | 0.660 | 0.189 | 480826.8 | 363739.6 | 1104676.5 | 46.1 | 0.584 | 36.4 (n=24) | 7.1 |
| age-horizon | 24 | 0.085 | 0.076 | 0.485 | 0.459 | 0.642 | 0.463 | 496023.4 | 363693.9 | 654796.5 | 37.5 | 1.000 | 38.0 (n=24) | 6.7 |
| structural-v1 | 24 | 0.088 | 0.079 | 0.494 | 0.471 | 0.631 | 0.465 | 488933.3 | 358391.4 | 1545623.7 | 64.3 | 0.290 | 37.7 (n=24) | 6.8 |
| oracle | 24 | 0.105 | 0.093 | 0.582 | 0.537 | 0.818 | 1.000 | 104393.0 | 0 | 720455.0 | 27.0 | 0.985 | 17.8 (n=24) | 17.8 |

## Budget 128000

| policy | n | retention (mean) | retention (pooled) | retention covered (mean) | retention covered (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | recall tokens (mean) | cold prefix tokens (mean) | eviction events (mean) | saturated events | turns to first summary (mean) | summaries (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 24 | 0.156 | 0.140 | 0.642 | 0.599 | 0.900 | 1.000 | 0 | 0 | 0 | 0 | 0.000 | 31.3 (n=24) | 8.9 |
| random | 24 | 0.161 | 0.146 | 0.614 | 0.582 | 0.790 | 0.174 | 491072.5 | 379731.7 | 1095820.9 | 24.3 | 0.552 | 81 (n=24) | 3 |
| age-horizon | 24 | 0.151 | 0.137 | 0.600 | 0.567 | 0.788 | 0.443 | 516414.0 | 388817.8 | 530815.0 | 20.5 | 1.000 | 85.5 (n=24) | 2.7 |
| structural-v1 | 24 | 0.158 | 0.144 | 0.612 | 0.585 | 0.762 | 0.450 | 512953.4 | 380973.5 | 1640921.4 | 38.6 | 0.227 | 84.3 (n=24) | 2.8 |
| oracle | 24 | 0.174 | 0.156 | 0.659 | 0.617 | 0.912 | 1.000 | 101410.6 | 0 | 721723.8 | 14.1 | 0.991 | 35.2 (n=24) | 7.3 |
