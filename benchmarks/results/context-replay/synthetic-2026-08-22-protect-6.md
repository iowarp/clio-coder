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
| none | 24 | 0.055 | 0.051 | 0.419 | 0.398 | 0.566 | 1.000 | 0 | 0 | 0 | 0 | 0.000 | 7.3 (n=24) | 43.3 |
| random | 24 | 0.062 | 0.058 | 0.458 | 0.433 | 0.631 | 0.194 | 296511.7 | 213458.1 | 1634972.0 | 83.7 | 0.979 | 8.9 (n=24) | 27.8 |
| age-horizon | 24 | 0.063 | 0.059 | 0.460 | 0.436 | 0.637 | 0.502 | 313905.0 | 219570.5 | 1664045.6 | 84.8 | 1.000 | 9.0 (n=24) | 27.0 |
| structural-v1 | 24 | 0.065 | 0.060 | 0.470 | 0.444 | 0.649 | 0.502 | 312084.3 | 216979 | 2052223.6 | 100.0 | 0.503 | 9.0 (n=24) | 27.0 |
| oracle | 24 | 0.058 | 0.053 | 0.433 | 0.409 | 0.592 | 1.000 | 50292.3 | 0 | 656912.9 | 31.3 | 1.000 | 7.4 (n=24) | 40.1 |

## Budget 64000

| policy | n | retention (mean) | retention (pooled) | retention covered (mean) | retention covered (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | recall tokens (mean) | cold prefix tokens (mean) | eviction events (mean) | saturated events | turns to first summary (mean) | summaries (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 24 | 0.103 | 0.097 | 0.573 | 0.541 | 0.890 | 1.000 | 0 | 0 | 0 | 0 | 0.000 | 15.3 (n=24) | 20.3 |
| random | 24 | 0.103 | 0.097 | 0.557 | 0.527 | 0.846 | 0.169 | 410043.1 | 307054.5 | 1349530.4 | 49.4 | 0.765 | 30.6 (n=24) | 7.7 |
| age-horizon | 24 | 0.099 | 0.094 | 0.547 | 0.520 | 0.839 | 0.432 | 423995.1 | 309220.5 | 1131447.3 | 46.5 | 1.000 | 32.7 (n=24) | 7.4 |
| structural-v1 | 24 | 0.103 | 0.099 | 0.563 | 0.536 | 0.837 | 0.434 | 416821.6 | 304082.1 | 2012524.2 | 68.3 | 0.346 | 31.8 (n=24) | 7.5 |
| oracle | 24 | 0.108 | 0.101 | 0.581 | 0.549 | 0.891 | 1.000 | 87232.3 | 0 | 884132.7 | 27.1 | 1.000 | 16.5 (n=24) | 17.4 |

## Budget 128000

| policy | n | retention (mean) | retention (pooled) | retention covered (mean) | retention covered (pooled) | retention@10 (mean) | eviction precision (mean) | tokens evicted (mean) | recall tokens (mean) | cold prefix tokens (mean) | eviction events (mean) | saturated events | turns to first summary (mean) | summaries (mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 24 | 0.170 | 0.162 | 0.649 | 0.619 | 0.955 | 1.000 | 0 | 0 | 0 | 0 | 0.000 | 31.7 (n=24) | 7.8 |
| random | 24 | 0.175 | 0.169 | 0.647 | 0.617 | 0.926 | 0.184 | 410476.2 | 303246.6 | 1151447 | 25.8 | 0.651 | 75.3 (n=24) | 2.7 |
| age-horizon | 24 | 0.163 | 0.159 | 0.625 | 0.597 | 0.922 | 0.435 | 424796.3 | 311280.7 | 686287.0 | 22.7 | 1.000 | 78.7 (n=24) | 2.7 |
| structural-v1 | 24 | 0.175 | 0.172 | 0.655 | 0.628 | 0.919 | 0.445 | 418929.8 | 302101.8 | 1755726.3 | 37.0 | 0.274 | 77.2 (n=24) | 2.7 |
| oracle | 24 | 0.187 | 0.180 | 0.665 | 0.635 | 0.965 | 1.000 | 87606.8 | 0 | 728227.6 | 13.2 | 1.000 | 35.8 (n=24) | 6.7 |
