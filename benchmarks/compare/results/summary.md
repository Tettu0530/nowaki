Measured 2026-11-04 · Apple M2, 8 cores, 16 GB, darwin 25.6.0, node v24.14.0 · commit c64892a

### dev ready line (cold) — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.15.0 | 131 [126–135] | 149 [136–156] | 134 [129–138] | 144 [135–147] | 145 [132–147] |
| Astro 7.4.5 | 950 [943–956] | 998 [968–1129] | 1179 [990–1195] | 950 [940–956] | 961 [954–963] |
| SvelteKit 3.1.1 | 411 [400–424] | 397 [396–400] | 404 [399–419] | 407 [404–411] | 412 [405–435] |
| Next.js 16.4.5 | 273 [268–276] | 272 [265–277] | 267 [263–269] | 267 [265–271] | 273 [270–279] |
| Nuxt 4.6.4 | 1408 [1390–1456] | 1688 [1507–2023] | 1555 [1498–1582] | 2147 [2108–2291] | 1420 [1404–1458] |

### dev first response of / (cold) — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.15.0 | 169 [166–170] | 200 [177–202] | 177 [175–180] | 269 [242–271] | 206 [186–207] |
| Astro 7.4.5 | 1453 [1427–1476] | 1536 [1479–1562] | 1617 [1525–1667] | 1611 [1601–1624] | 1468 [1451–1481] |
| SvelteKit 3.1.1 | 715 [675–719] | 689 [681–703] | 695 [693–709] | 802 [793–817] | 785 [727–792] |
| Next.js 16.4.5 | 1298 [1294–1315] | 1348 [1309–1403] | 1351 [1327–1369] | 1369 [1326–1403] | 1361 [1317–1390] |
| Nuxt 4.6.4 | 2195 [2145–2228] | 2450 [2273–3282] | 2320 [2269–2340] | 2908 [2864–3054] | 2237 [2218–2271] |

### dev first response of a second route — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.15.0 | 22 [22–24] | 23 [22–23] | 22 [20–23] | 21 [20–21] | 21 [20–21] |
| Astro 7.4.5 | 25 [25–26] | 26 [25–27] | 26 [26–27] | 33 [32–33] | 26 [25–27] |
| SvelteKit 3.1.1 | 26 [26–27] | 26 [26–27] | 26 [26–27] | 26 [26–28] | 28 [26–29] |
| Next.js 16.4.5 | 364 [360–379] | 385 [378–389] | 398 [391–410] | 408 [399–415] | 390 [383–400] |
| Nuxt 4.6.4 | 25 [24–27] | 30 [26–33] | 25 [24–27] | 24 [23–25] | 22 [21–22] |

### static build (every page to HTML) — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.15.0 | 150 [145–153] | 153 [150–154] | 189 [187–195] | 504 [496–515] | 190 [177–201] |
| Astro 7.4.5 | 732 [724–748] | 757 [751–766] | 803 [797–814] | 1150 [1130–1172] | 770 [765–773] |
| SvelteKit 3.1.1 | 962 [942–984] | 979 [967–999] | 1070 [1053–1152] | 1871 [1836–1907] | 989 [983–997] |
| Next.js 16.4.5 | 1970 [1943–2038] | 2198 [2108–2350] | 2696 [2441–2989] | 4397 [4343–4625] | 2004 [1965–2135] |
| Nuxt 4.6.4 | 2238 [2203–2272] | 2360 [2308–2444] | 2611 [2601–2696] | 3957 [3923–4462] | 2273 [2246–2502] |

### server build (render per request) — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.15.0 | 50 [49–50] | 47 [46–47] | 46 [45–46] | 58 [55–60] | 54 [53–55] |
| Astro 7.4.5 | 822 [812–823] | 846 [837–855] | 858 [842–891] | 878 [871–899] | 848 [837–861] |
| SvelteKit 3.1.1 | 1083 [1065–1116] | 986 [959–1000] | 980 [971–995] | 1017 [1016–1022] | 991 [986–994] |
| Next.js 16.4.5 | 2031 [1999–2066] | 2215 [1961–2346] | 2332 [2140–2635] | 2105 [2015–2179] | 2064 [2018–2085] |
| Nuxt 4.6.4 | 3207 [2978–3418] | 3038 [2982–3130] | 3041 [3011–3073] | 3680 [3462–3811] | 2952 [2939–3063] |

### `/` in the browser — JS / total transfer, KB gzip

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.15.0 | 11.46 / 12.22 (2.77 idle) | 11.46 / 12.66 (2.77 idle) | 11.46 / 12.67 (2.77 idle) | 11.46 / 12.64 (2.77 idle) | 14.09 / 15.51 (2.77 idle) |
| Astro 7.4.5 | 9.49 / 10.14 | 9.49 / 10.58 | 9.49 / 10.58 | 9.49 / 10.56 | 11.77 / 13.19 |
| SvelteKit 3.1.1 | 35.42 / 36 | 38.75 / 39.55 | 38.45 / 39.24 | 38.54 / 39.34 | 39.05 / 39.91 |
| Next.js 16.4.5 | 140.65 / 143.33 | 141.23 / 159.28 | 141.21 / 153.01 | 141.21 / 151.2 | 141.47 / 151.23 |
| Nuxt 4.6.4 | 77.16 / 79.73 | 77.16 / 84.99 | 77.16 / 89.28 | 77.16 / 131.55 | 77.46 / 85.34 |

### a post page in the browser — JS / total transfer, KB gzip

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.15.0 | 0 / 1 | 0 / 1 | 0 / 1 | 0 / 1 | 0 / 1 |
| Astro 7.4.5 | 0 / 0.95 | 0 / 0.95 | 0 / 0.95 | 0 / 0.95 | 0 / 0.95 |
| SvelteKit 3.1.1 | 35.34 / 35.98 | 35.34 / 35.98 | 35.34 / 35.97 | 35.34 / 35.97 | 35.34 / 35.98 |
| Next.js 16.4.5 | 137.92 / 138.57 | 137.92 / 140.17 | 137.92 / 142.4 | 137.91 / 138.57 | 137.92 / 140.17 |
| Nuxt 4.6.4 | 77.16 / 79.99 | 77.16 / 81.09 | 77.16 / 85.62 | 77.16 / 127.91 | 77.46 / 81.39 |

### Scaling — fixed cost and marginal cost (from the medians)

| framework | metric | fixed (ms) | per page (ms) | per island (ms) |
|---|---|---|---|---|
| Nowaki | dev ready line (cold) | 138 | 0.01 | -0.5 |
| Nowaki | dev first response of / (cold) | 179 | 0.09 | 0.7 |
| Nowaki | dev first response of a second route | 22 | 0 | -0.2 |
| Nowaki | static build (every page to HTML) | 151 | 0.35 | 4.1 |
| Nowaki | server build (render per request) | 47 | 0.01 | 0.7 |
| Nowaki | JS on `/` per island (KB gzip) | | | 0.29 |
| Astro | dev ready line (cold) | 1040 | -0.08 | -4.1 |
| Astro | dev first response of / (cold) | 1529 | 0.09 | -7.5 |
| Astro | dev first response of a second route | 25 | 0.01 | 0.1 |
| Astro | static build (every page to HTML) | 748 | 0.4 | 1.4 |
| Astro | server build (render per request) | 840 | 0.04 | 0.2 |
| Astro | JS on `/` per island (KB gzip) | | | 0.25 |
| SvelteKit | dev ready line (cold) | 404 | 0 | 1.6 |
| SvelteKit | dev first response of / (cold) | 696 | 0.1 | 10.6 |
| SvelteKit | dev first response of a second route | 26 | 0 | 0.2 |
| SvelteKit | static build (every page to HTML) | 970 | 0.9 | 1.1 |
| SvelteKit | server build (render per request) | 1017 | 0 | 0.6 |
| SvelteKit | JS on `/` per island (KB gzip) | | | 0.03 |
| Next.js | dev ready line (cold) | 270 | 0 | 0.2 |
| Next.js | dev first response of / (cold) | 1330 | 0.04 | 1.5 |
| Next.js | dev first response of a second route | 380 | 0.03 | 0.6 |
| Next.js | static build (every page to HTML) | 2196 | 2.23 | -21.6 |
| Next.js | server build (render per request) | 2190 | -0.07 | -16.8 |
| Next.js | JS on `/` per island (KB gzip) | | | 0.03 |
| Nuxt | dev ready line (cold) | 1528 | 0.62 | -29.8 |
| Nuxt | dev first response of / (cold) | 2300 | 0.6 | -23.6 |
| Nuxt | dev first response of a second route | 26 | 0 | -0.8 |
| Nuxt | static build (every page to HTML) | 2339 | 1.63 | -9.7 |
| Nuxt | server build (render per request) | 3077 | 0.59 | -9.6 |
| Nuxt | JS on `/` per island (KB gzip) | | | 0.03 |

### Production servers — 100 pages × 1 island, rendered per request unless noted, median of runs

| server | start (ms) | idle RSS (MB) | peak RSS (MB) | TTFB p50 / p99 (ms, 1 conn) | post pages req/s (p99 ms, 50 conns) | `/` req/s (p99 ms, 50 conns) |
|---|---|---|---|---|---|---|
| Nowaki 0.15.0 | 144 | 301.6 | 379 | 0.41 / 1.16 | 4183 (23.14) | 6676 (14.03) |
| Astro 7.4.5 | 126 | 326.3 | 327.7 | 0.24 / 1.14 | 6821 (14.7) | 8319 (12.73) |
| SvelteKit 3.1.1 | 103 | 315.2 | 301.9 | 0.22 / 1.06 | 6741 (13.06) | 4689 (17.3) |
| Next.js 16.4.5 | 338 | 429.1 | 451.2 | 0.95 / 2.57 | 1270 (50.32) | 1479 (44.07) |
| Nuxt 4.6.4 | 168 | 388.1 | 382.7 | 0.6 / 4.42 | 2150 (36.46) | 2265 (34.16) |
| Nowaki 0.15.0 (NOWAKI_CSP=enforce) | 143 | 303.2 | 382.1 | 0.43 / 1.08 | 4370 (22.68) | 6060 (18.51) |
| Nowaki 0.15.0 (ISR on post pages, 60 s) | 143 | 111 | 111.3 | 0.08 / 0.22 | 144750 (1.06) | 6531 (14.92) |
| Next.js 16.4.5 (ISR on post pages, 60 s) | 357 | 386.3 | 392.5 | 0.28 / 1.28 | 4844 (18.98) | 1204 (69.98) |
| Nuxt 4.6.4 (ISR on post pages, 60 s) | 168 | 275.7 | 285.5 | 0.12 / 0.4 | 19996 (5.05) | 2134 (37.27) |
