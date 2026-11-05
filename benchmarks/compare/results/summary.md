Measured 2026-11-05 · Apple M2, 8 cores, 16 GB, darwin 25.6.0, node v24.14.0 · commit aa50809

### dev ready line (cold) — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.16.0 | 149 [147–156] | 148 [139–150] | 152 [150–158] | 145 [117–152] | 130 [128–136] |
| Astro 7.4.5 | 978 [966–1174] | 991 [989–1190] | 958 [949–1006] | 968 [961–974] | 973 [951–1165] |
| SvelteKit 3.1.1 | 450 [442–461] | 460 [447–466] | 442 [434–481] | 435 [430–444] | 415 [411–430] |
| Next.js 16.4.5 | 287 [283–291] | 284 [276–288] | 286 [282–291] | 273 [270–277] | 262 [261–265] |
| Nuxt 4.6.4 | 1616 [1472–1653] | 1429 [1407–1439] | 1572 [1554–1596] | 2379 [2331–2623] | 1446 [1399–1489] |

### dev first response of / (cold) — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.16.0 | 199 [198–199] | 200 [177–202] | 214 [208–222] | 267 [243–270] | 181 [179–186] |
| Astro 7.4.5 | 1523 [1461–1609] | 1627 [1596–1663] | 1528 [1473–1624] | 1670 [1627–1689] | 1550 [1505–1655] |
| SvelteKit 3.1.1 | 769 [761–775] | 780 [770–791] | 759 [746–835] | 857 [848–881] | 740 [718–752] |
| Next.js 16.4.5 | 1432 [1394–1469] | 1402 [1386–1420] | 1520 [1446–1605] | 1368 [1344–1430] | 1310 [1296–1356] |
| Nuxt 4.6.4 | 2392 [2251–2428] | 2185 [2174–2204] | 2355 [2333–2379] | 3139 [3119–3364] | 2259 [2216–2297] |

### dev first response of a second route — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.16.0 | 23 [22–24] | 23 [22–25] | 23 [22–26] | 21 [20–21] | 21 [20–21] |
| Astro 7.4.5 | 26 [25–27] | 29 [28–29] | 26 [25–29] | 33 [32–34] | 27 [26–30] |
| SvelteKit 3.1.1 | 31 [29–32] | 30 [30–31] | 29 [27–30] | 28 [27–29] | 26 [26–27] |
| Next.js 16.4.5 | 417 [409–426] | 408 [399–427] | 429 [417–455] | 424 [406–435] | 382 [374–398] |
| Nuxt 4.6.4 | 28 [27–28] | 25 [24–26] | 27 [26–34] | 27 [25–29] | 22 [22–26] |

### static build (every page to HTML) — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.16.0 | 162 [160–173] | 162 [161–163] | 185 [181–199] | 384 [381–388] | 174 [173–176] |
| Astro 7.4.5 | 753 [730–785] | 839 [832–847] | 862 [854–896] | 1258 [1241–1298] | 774 [765–786] |
| SvelteKit 3.1.1 | 1083 [1058–1122] | 1053 [1039–1055] | 1080 [1061–1102] | 1923 [1826–1958] | 1013 [1002–1034] |
| Next.js 16.4.5 | 2298 [2233–2402] | 2130 [2071–2157] | 2260 [2202–2345] | 4365 [4179–4490] | 2430 [2294–2500] |
| Nuxt 4.6.4 | 2438 [2435–2455] | 2264 [2237–2425] | 2544 [2424–2683] | 4348 [4235–4752] | 2233 [2223–2254] |

### server build (render per request) — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.16.0 | 60 [58–60] | 58 [57–58] | 61 [57–64] | 75 [74–75] | 61 [61–62] |
| Astro 7.4.5 | 980 [918–1087] | 914 [905–923] | 839 [832–853] | 983 [967–1000] | 845 [833–853] |
| SvelteKit 3.1.1 | 1061 [1053–1139] | 1049 [1031–1054] | 1063 [1026–1092] | 1031 [1005–1052] | 1021 [1002–1051] |
| Next.js 16.4.5 | 2475 [2354–2673] | 2184 [2061–2308] | 2127 [2084–2257] | 2691 [2412–3045] | 2302 [2095–2401] |
| Nuxt 4.6.4 | 3295 [3256–3356] | 3082 [3014–3127] | 3337 [3240–3437] | 3640 [3514–3690] | 3032 [2993–3086] |

### `/` in the browser — JS / total transfer, KB gzip

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.16.0 | 11.46 / 12.22 (2.77 idle) | 11.46 / 12.66 (2.77 idle) | 11.46 / 12.67 (2.77 idle) | 11.46 / 12.64 (2.77 idle) | 14.09 / 15.51 (2.77 idle) |
| Astro 7.4.5 | 9.49 / 10.14 | 9.49 / 10.58 | 9.49 / 10.58 | 9.49 / 10.56 | 11.77 / 13.19 |
| SvelteKit 3.1.1 | 35.42 / 36 | 38.75 / 39.56 | 38.45 / 39.24 | 38.54 / 39.34 | 39.05 / 39.91 |
| Next.js 16.4.5 | 140.65 / 143.33 | 141.23 / 157.5 | 141.21 / 149.05 | 141.21 / 152.72 | 141.46 / 157.83 |
| Nuxt 4.6.4 | 77.16 / 79.73 | 77.17 / 84.99 | 77.16 / 89.27 | 77.16 / 131.55 | 77.46 / 85.34 |

### a post page in the browser — JS / total transfer, KB gzip

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.16.0 | 0 / 1 | 0 / 1 | 0 / 1 | 0 / 1 | 0 / 1 |
| Astro 7.4.5 | 0 / 0.95 | 0 / 0.95 | 0 / 0.95 | 0 / 0.95 | 0 / 0.95 |
| SvelteKit 3.1.1 | 35.34 / 35.98 | 35.34 / 35.97 | 35.34 / 35.97 | 35.34 / 35.98 | 35.34 / 35.98 |
| Next.js 16.4.5 | 137.92 / 139.92 | 137.92 / 140.16 | 137.92 / 142.4 | 137.92 / 163.77 | 137.92 / 140.17 |
| Nuxt 4.6.4 | 77.16 / 79.99 | 77.17 / 81.09 | 77.16 / 85.62 | 77.16 / 127.9 | 77.46 / 81.38 |

### Scaling — fixed cost and marginal cost (from the medians)

| framework | metric | fixed (ms) | per page (ms) | per island (ms) |
|---|---|---|---|---|
| Nowaki | dev ready line (cold) | 149 | 0 | -2 |
| Nowaki | dev first response of / (cold) | 202 | 0.07 | -2.2 |
| Nowaki | dev first response of a second route | 23 | 0 | -0.2 |
| Nowaki | static build (every page to HTML) | 161 | 0.22 | 1.3 |
| Nowaki | server build (render per request) | 59 | 0.02 | 0.3 |
| Nowaki | JS on `/` per island (KB gzip) | | | 0.29 |
| Astro | dev ready line (cold) | 976 | -0.01 | -2 |
| Astro | dev first response of / (cold) | 1556 | 0.11 | -8.6 |
| Astro | dev first response of a second route | 27 | 0.01 | -0.2 |
| Astro | static build (every page to HTML) | 800 | 0.46 | -7.3 |
| Astro | server build (render per request) | 911 | 0.06 | -7.6 |
| Astro | JS on `/` per island (KB gzip) | | | 0.25 |
| SvelteKit | dev ready line (cold) | 451 | -0.02 | -5.1 |
| SvelteKit | dev first response of / (cold) | 767 | 0.09 | -4.4 |
| SvelteKit | dev first response of a second route | 30 | 0 | -0.4 |
| SvelteKit | static build (every page to HTML) | 1041 | 0.88 | -4.4 |
| SvelteKit | server build (render per request) | 1058 | -0.03 | -3.2 |
| SvelteKit | JS on `/` per island (KB gzip) | | | 0.03 |
| Next.js | dev ready line (cold) | 286 | -0.01 | -2.5 |
| Next.js | dev first response of / (cold) | 1452 | -0.08 | -10.3 |
| Next.js | dev first response of a second route | 417 | 0.01 | -2.8 |
| Next.js | static build (every page to HTML) | 2152 | 2.2 | 33.4 |
| Next.js | server build (render per request) | 2252 | 0.42 | 13.1 |
| Next.js | JS on `/` per island (KB gzip) | | | 0.03 |
| Nuxt | dev ready line (cold) | 1508 | 0.87 | 1.8 |
| Nuxt | dev first response of / (cold) | 2280 | 0.86 | 8.2 |
| Nuxt | dev first response of a second route | 26 | 0 | -0.3 |
| Nuxt | static build (every page to HTML) | 2341 | 2.01 | -3.5 |
| Nuxt | server build (render per request) | 3220 | 0.43 | -5.6 |
| Nuxt | JS on `/` per island (KB gzip) | | | 0.03 |

### Production servers — 100 pages × 1 island, rendered per request unless noted, median of runs

| server | start (ms) | idle RSS (MB) | peak RSS (MB) | TTFB p50 / p99 (ms, 1 conn) | post pages req/s (p99 ms, 50 conns) | `/` req/s (p99 ms, 50 conns) |
|---|---|---|---|---|---|---|
| Nowaki 0.16.0 | 135 | 275.3 | 275.7 | 0.2 / 0.7 | 10424 (9.19) | 18493 (5.64) |
| Astro 7.4.5 | 146 | 436.4 | 542.3 | 0.24 / 1.03 | 6672 (14.88) | 7723 (15.16) |
| SvelteKit 3.1.1 | 103 | 336.4 | 331.8 | 0.26 / 1.28 | 6215 (14.27) | 4293 (19.71) |
| Next.js 16.4.5 | 375 | 428.8 | 434.9 | 0.99 / 2.81 | 1105 (67.79) | 1323 (51.42) |
| Nuxt 4.6.4 | 159 | 410.3 | 411.4 | 0.67 / 4.49 | 1950 (45.72) | 2135 (37.52) |
| Nowaki 0.16.0 (NOWAKI_CSP=enforce) | 136 | 275.4 | 275.7 | 0.2 / 1 | 11103 (8.9) | 18968 (5.89) |
| Nowaki 0.16.0 (ISR on post pages, 60 s) | 153 | 114.4 | 114.8 | 0.08 / 0.23 | 122454 (1.24) | 17067 (6.71) |
| Next.js 16.4.5 (ISR on post pages, 60 s) | 359 | 384.5 | 398.3 | 0.29 / 1.14 | 5129 (18.78) | 1340 (48.67) |
| Nuxt 4.6.4 (ISR on post pages, 60 s) | 170 | 280 | 288.1 | 0.11 / 0.35 | 18777 (5.02) | 2209 (33.46) |
