Measured 2026-11-08 · Apple M2, 8 cores, 16 GB, darwin 25.6.0, node v24.14.0 · commit af1d87e

### dev ready line (cold) — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.17.2 | 139 [138–145] | 138 [134–142] | 148 [145–149] | 142 [138–149] | 142 [141–145] |
| Astro 7.4.5 | 947 [944–950] | 948 [943–949] | 968 [962–990] | 983 [969–998] | 974 [963–1000] |
| SvelteKit 3.1.1 | 454 [442–487] | 404 [398–417] | 416 [409–420] | 428 [414–453] | 421 [416–434] |
| Next.js 16.4.5 | 264 [260–288] | 274 [267–283] | 281 [273–285] | 268 [265–271] | 266 [266–269] |
| Nuxt 4.6.4 | 1530 [1510–1610] | 1472 [1436–1493] | 1474 [1460–1538] | 2149 [2122–2177] | 1465 [1411–1524] |

### dev first response of / (cold) — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.17.2 | 209 [187–214] | 187 [183–212] | 219 [218–222] | 281 [256–286] | 222 [221–229] |
| Astro 7.4.5 | 1419 [1400–1427] | 1422 [1418–1427] | 1556 [1520–1628] | 1732 [1702–1753] | 1555 [1541–1616] |
| SvelteKit 3.1.1 | 759 [738–818] | 695 [684–710] | 732 [715–737] | 875 [838–931] | 757 [749–769] |
| Next.js 16.4.5 | 1380 [1307–1579] | 1351 [1320–1404] | 1387 [1355–1398] | 1344 [1337–1357] | 1300 [1298–1327] |
| Nuxt 4.6.4 | 2299 [2272–2381] | 2239 [2208–2267] | 2248 [2231–2311] | 2895 [2878–2929] | 2270 [2221–2333] |

### dev first response of a second route — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.17.2 | 23 [22–23] | 22 [22–22] | 23 [22–23] | 24 [24–27] | 22 [21–22] |
| Astro 7.4.5 | 26 [26–27] | 27 [26–27] | 30 [28–30] | 47 [41–53] | 28 [27–30] |
| SvelteKit 3.1.1 | 28 [26–29] | 26 [26–29] | 27 [26–27] | 28 [27–29] | 26 [25–28] |
| Next.js 16.4.5 | 379 [365–397] | 383 [356–403] | 374 [360–397] | 399 [383–402] | 370 [359–373] |
| Nuxt 4.6.4 | 25 [24–30] | 24 [23–24] | 24 [24–26] | 25 [24–27] | 22 [22–23] |

### static build (every page to HTML) — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.17.2 | 175 [173–183] | 181 [181–182] | 218 [217–220] | 472 [464–487] | 208 [202–213] |
| Astro 7.4.5 | 761 [759–764] | 788 [782–792] | 845 [843–849] | 1409 [1280–1604] | 842 [811–859] |
| SvelteKit 3.1.1 | 976 [969–980] | 1039 [1027–1060] | 1122 [1109–1134] | 1982 [1937–2028] | 1045 [1021–1140] |
| Next.js 16.4.5 | 2212 [2136–2336] | 2155 [2046–2196] | 2543 [2453–2656] | 4408 [4220–4529] | 2110 [2090–2129] |
| Nuxt 4.6.4 | 2732 [2614–2920] | 2323 [2287–2441] | 2602 [2533–2636] | 4159 [4022–4223] | 2315 [2311–2328] |

### server build (render per request) — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.17.2 | 63 [62–65] | 68 [67–69] | 73 [71–77] | 94 [93–96] | 77 [76–78] |
| Astro 7.4.5 | 886 [861–916] | 875 [869–911] | 903 [882–930] | 903 [896–905] | 904 [871–917] |
| SvelteKit 3.1.1 | 1023 [1014–1034] | 1078 [1051–1084] | 1114 [1090–1131] | 1122 [1096–1130] | 1049 [1039–1063] |
| Next.js 16.4.5 | 2516 [2458–2920] | 2213 [2071–2407] | 2394 [2301–2523] | 2166 [2142–2183] | 2085 [2079–2136] |
| Nuxt 4.6.4 | 3285 [3236–3351] | 3226 [3186–3279] | 3388 [3360–3400] | 3577 [3565–3593] | 3399 [3342–3456] |

### `/` in the browser — JS / total transfer, KB gzip

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.17.2 | 8.67 / 10.3 | 8.67 / 10.73 | 8.67 / 10.74 | 8.67 / 10.72 | 11.3 / 13.6 |
| Astro 7.4.5 | 9.9 / 11.34 | 9.9 / 11.77 | 9.9 / 11.78 | 9.9 / 11.76 | 12.08 / 14.28 |
| SvelteKit 3.1.1 | 36.69 / 38.11 | 40.02 / 41.67 | 39.71 / 41.35 | 39.8 / 41.45 | 40.31 / 42.02 |
| Next.js 16.4.5 | 140.96 / 144.63 | 141.54 / 154.84 | 141.56 / 154.55 | 141.51 / 156.91 | 141.79 / 155.12 |
| Nuxt 4.6.4 | 80.4 / 84.34 | 80.4 / 88.29 | 80.4 / 93.93 | 80.4 / 136.92 | 80.69 / 88.65 |

### a post page in the browser — JS / total transfer, KB gzip

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.17.2 | 8.38 / 10.46 | 8.38 / 10.46 | 8.38 / 10.46 | 8.38 / 10.46 | 8.38 / 10.46 |
| Astro 7.4.5 | 9.66 / 11.53 | 9.66 / 11.53 | 9.66 / 11.53 | 9.66 / 11.53 | 9.66 / 11.53 |
| SvelteKit 3.1.1 | 36.61 / 38.11 | 36.61 / 38.11 | 36.61 / 38.11 | 36.61 / 38.11 | 36.61 / 38.11 |
| Next.js 16.4.5 | 138.78 / 141.82 | 138.78 / 142.05 | 138.78 / 144.32 | 138.78 / 165.76 | 138.78 / 142.06 |
| Nuxt 4.6.4 | 80.4 / 84.62 | 80.4 / 86.03 | 80.4 / 91.76 | 80.4 / 134.04 | 80.69 / 86.33 |

### `/posts` (search island) in the browser — JS / total transfer, KB gzip

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.17.2 | 8.88 / 10.47 | 8.88 / 10.66 | 8.88 / 12.04 | 8.88 / 24.68 | 8.88 / 10.66 |
| Astro 7.4.5 | 10.12 / 11.51 | 10.12 / 11.7 | 10.12 / 13.15 | 10.12 / 26.19 | 10.12 / 11.7 |
| SvelteKit 3.1.1 | 36.48 / 37.93 | 36.92 / 38.48 | 40.2 / 42.77 | 69.06 / 85.07 | 36.92 / 38.48 |
| Next.js 16.4.5 | 138.1 / 141.96 | 138.34 / 151.39 | 140.69 / 177.49 | 162.58 / 231.5 | 138.34 / 158.49 |
| Nuxt 4.6.4 | 80.4 / 84.33 | 80.4 / 93.5 | 80.4 / 105.4 | 80.4 / 201.45 | 80.69 / 93.8 |

### `/stats` (50-row table island) in the browser — JS / total transfer, KB gzip

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.17.2 | 9.48 / 11.45 | 9.48 / 11.81 | 9.48 / 13.15 | 9.48 / 13.18 | 9.48 / 11.81 |
| Astro 7.4.5 | 10.21 / 11.81 | 10.21 / 12.18 | 10.21 / 13.61 | 10.21 / 13.64 | 10.21 / 12.18 |
| SvelteKit 3.1.1 | 36.41 / 38.16 | 36.62 / 38.51 | 37.35 / 39.84 | 37.37 / 39.86 | 36.62 / 38.51 |
| Next.js 16.4.5 | 141.24 / 145.2 | 141.46 / 155.73 | 142.3 / 166.67 | 142.31 / 168.25 | 141.46 / 160.02 |
| Nuxt 4.6.4 | 80.4 / 84.53 | 80.4 / 92.72 | 80.4 / 100.15 | 80.4 / 142.51 | 80.69 / 93.01 |

### `/contact` (form) in the browser — JS / total transfer, KB gzip

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.17.2 | 8.38 / 9.96 | 8.38 / 9.96 | 8.38 / 9.96 | 8.38 / 9.96 | 8.38 / 9.96 |
| Astro 7.4.5 | 9.66 / 11.04 | 9.66 / 11.04 | 9.66 / 11.04 | 9.66 / 11.04 | 9.66 / 11.04 |
| SvelteKit 3.1.1 | 35.97 / 37.46 | 35.97 / 37.46 | 35.97 / 37.46 | 35.97 / 37.46 | 35.97 / 37.46 |
| Next.js 16.4.5 | 134.35 / 135.7 | 134.35 / 135.7 | 134.35 / 135.7 | 134.35 / 135.7 | 134.35 / 135.7 |
| Nuxt 4.6.4 | 79.92 / 82.91 | 79.92 / 84.31 | 79.92 / 90.04 | 79.92 / 132.33 | 80.21 / 84.61 |

### Scaling — fixed cost and marginal cost (from the medians)

| framework | metric | fixed (ms) | per page (ms) | per island (ms) |
|---|---|---|---|---|
| Nowaki | dev ready line (cold) | 141 | 0 | 0.5 |
| Nowaki | dev first response of / (cold) | 202 | 0.08 | 3.9 |
| Nowaki | dev first response of a second route | 22 | 0 | -0.1 |
| Nowaki | static build (every page to HTML) | 180 | 0.29 | 2.9 |
| Nowaki | server build (render per request) | 67 | 0.03 | 1 |
| Nowaki | JS on `/` per island (KB gzip) | | | 0.29 |
| Astro | dev ready line (cold) | 952 | 0.03 | 2.9 |
| Astro | dev first response of / (cold) | 1453 | 0.29 | 14.7 |
| Astro | dev first response of a second route | 27 | 0.02 | 0.1 |
| Astro | static build (every page to HTML) | 774 | 0.64 | 6 |
| Astro | server build (render per request) | 887 | 0.02 | 3.2 |
| Astro | JS on `/` per island (KB gzip) | | | 0.24 |
| SvelteKit | dev ready line (cold) | 425 | 0 | 1.9 |
| SvelteKit | dev first response of / (cold) | 723 | 0.15 | 6.8 |
| SvelteKit | dev first response of a second route | 27 | 0 | 0 |
| SvelteKit | static build (every page to HTML) | 1009 | 0.97 | 0.7 |
| SvelteKit | server build (render per request) | 1068 | 0.06 | -3.3 |
| SvelteKit | JS on `/` per island (KB gzip) | | | 0.03 |
| Next.js | dev ready line (cold) | 273 | 0 | -0.9 |
| Next.js | dev first response of / (cold) | 1373 | -0.03 | -5.7 |
| Next.js | dev first response of a second route | 378 | 0.02 | -1.5 |
| Next.js | static build (every page to HTML) | 2219 | 2.2 | -5 |
| Next.js | server build (render per request) | 2381 | -0.21 | -14.3 |
| Next.js | JS on `/` per island (KB gzip) | | | 0.03 |
| Nuxt | dev ready line (cold) | 1469 | 0.67 | -0.8 |
| Nuxt | dev first response of / (cold) | 2240 | 0.65 | 3.4 |
| Nuxt | dev first response of a second route | 24 | 0 | -0.2 |
| Nuxt | static build (every page to HTML) | 2493 | 1.66 | -0.8 |
| Nuxt | server build (render per request) | 3286 | 0.3 | 19.2 |
| Nuxt | JS on `/` per island (KB gzip) | | | 0.03 |

### Production servers — 100 pages × 1 island, rendered per request unless noted, median of runs

| server | start (ms) | idle RSS (MB) | peak RSS (MB) | TTFB p50 / p99 (ms, 1 conn) | post pages req/s (p99 ms, 50 conns) | `/` req/s (p99 ms, 50 conns) | `/api/search` req/s (p99 ms, 50 conns) |
|---|---|---|---|---|---|---|---|
| Nowaki 0.17.2 | 184 | 307.3 | 307.9 | 0.23 / 0.67 | 7602 (12.51) | 12837 (7.49) | 28308 (4.46) |
| Astro 7.4.5 | 168 | 343.2 | 348.5 | 0.31 / 1.39 | 5390 (17.94) | 7176 (13.67) | 13346 (7.83) |
| SvelteKit 3.1.1 | 104 | 332.9 | 333.7 | 0.23 / 0.91 | 6348 (14.41) | 4623 (17.68) | 20963 (6.71) |
| Next.js 16.4.5 | 410 | 435.4 | 451.1 | 1.07 / 2.85 | 1118 (66.13) | 1256 (70.22) | 6597 (16.16) |
| Nuxt 4.6.4 | 156 | 334.6 | 352.2 | 0.65 / 4.93 | 1877 (48.43) | 2055 (44.61) | 30937 (4.49) |
| Nowaki 0.17.2 (NOWAKI_CSP=enforce) | 184 | 307.5 | 307.8 | 0.23 / 0.59 | 8014 (11.59) | 12699 (7.51) | 24655 (4.46) |
| Nowaki 0.17.2 (ISR on post pages, 60 s) | 192 | 129.8 | 130 | 0.07 / 0.2 | 133580 (1.09) | 13010 (7.31) | 29072 (4.88) |
| Next.js 16.4.5 (ISR on post pages, 60 s) | 404 | 396.2 | 401.1 | 0.29 / 1.15 | 5026 (15.9) | 1322 (50.02) | 6758 (15.06) |
| Nuxt 4.6.4 (ISR on post pages, 60 s) | 153 | 272.2 | 289.2 | 0.11 / 0.32 | 18239 (5.18) | 2114 (35.19) | 32883 (3.16) |
