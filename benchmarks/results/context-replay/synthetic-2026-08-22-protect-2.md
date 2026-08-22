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
| none | 24 | 0.063 | 0.059 | 0.480 | 0.456 | 0.655 | 1.000 | 0 | 0 | 0 | 0 | 0.000 | 7.3 (n=24) | 108.0 |
| random | 24 | 0.054 | 0.050 | 0.377 | 0.364 | 0.518 | 0.173 | 444873.2 | 333727.0 | 973674.1 | 89.0 | 0.772 | 14.6 (n=24) | 17.8 |
| age-horizon | 24 | 0.053 | 0.050 | 0.373 | 0.361 | 0.506 | 0.439 | 458819.2 | 333555.6 | 824020.0 | 83.4 | 1.000 | 15 (n=24) | 16.8 |
| structural-v1 | 24 | 0.057 | 0.053 | 0.390 | 0.377 | 0.536 | 0.440 | 455398.1 | 330372.1 | 1387959.1 | 109.9 | 0.419 | 14.9 (n=24) | 16.8 |
| oracle | 24 | 0.069 | 0.065 | 0.507 | 0.479 | 0.716 | 1.000 | 99886.7 | 0 | 653252.8 | 66.5 | 1.000 | 8.0 (n=24) | 74.7 |

## Budget 64000

| policy | n | retention (mean) | retention (pooled) | retention covered (mean) | retention covered (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | recall tokens (mean) | cold prefix tokens (mean) | eviction events (mean) | saturated events | turns to first summary (mean) | summaries (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 24 | 0.103 | 0.097 | 0.573 | 0.541 | 0.890 | 1.000 | 0 | 0 | 0 | 0 | 0.000 | 15.3 (n=24) | 20.3 |
| random | 24 | 0.091 | 0.087 | 0.487 | 0.470 | 0.704 | 0.167 | 437906.9 | 330456.3 | 926860.0 | 48.0 | 0.671 | 38.7 (n=24) | 6.3 |
| age-horizon | 24 | 0.086 | 0.083 | 0.467 | 0.452 | 0.692 | 0.439 | 457356.7 | 332040.9 | 565790.7 | 42.3 | 1.000 | 41.7 (n=24) | 5.8 |
| structural-v1 | 24 | 0.094 | 0.090 | 0.484 | 0.471 | 0.693 | 0.443 | 452584.3 | 327664.5 | 1442909.9 | 66.8 | 0.330 | 40.6 (n=24) | 5.9 |
| oracle | 24 | 0.112 | 0.105 | 0.586 | 0.556 | 0.901 | 1.000 | 96958 | 0 | 619564.8 | 27.1 | 0.997 | 17.0 (n=24) | 16.7 |

## Budget 128000

| policy | n | retention (mean) | retention (pooled) | retention covered (mean) | retention covered (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | recall tokens (mean) | cold prefix tokens (mean) | eviction events (mean) | saturated events | turns to first summary (mean) | summaries (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 24 | 0.170 | 0.162 | 0.649 | 0.619 | 0.955 | 1.000 | 0 | 0 | 0 | 0 | 0.000 | 31.7 (n=24) | 7.8 |
| random | 24 | 0.165 | 0.160 | 0.593 | 0.567 | 0.822 | 0.148 | 417898.5 | 320383.2 | 969745.0 | 27.0 | 0.650 | 83.0 (n=24) | 2.7 |
| age-horizon | 24 | 0.151 | 0.148 | 0.563 | 0.541 | 0.807 | 0.432 | 447213.7 | 327438.1 | 421327.9 | 23.9 | 1.000 | 88.2 (n=24) | 2.4 |
| structural-v1 | 24 | 0.167 | 0.163 | 0.594 | 0.572 | 0.802 | 0.437 | 441154.0 | 319331.9 | 1540113.8 | 39.9 | 0.282 | 86.1 (n=24) | 2.4 |
| oracle | 24 | 0.190 | 0.183 | 0.664 | 0.635 | 0.970 | 1.000 | 92309.4 | 0 | 595194.2 | 13.6 | 1.000 | 36.5 (n=24) | 6.5 |
