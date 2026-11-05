Measured 2026-11-05 · Apple M2, 8 cores, 16 GB, darwin 25.6.0, node v24.14.0 · commit fee685e

### dev ready line (cold) — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.16.1 | 137 [132–140] | 132 [128–137] | 147 [143–151] | 151 [138–154] | 129 [122–132] |
| Astro 7.4.5 | 964 [956–986] | 974 [964–993] | 955 [953–963] | 966 [959–998] | 986 [964–1126] |
| SvelteKit 3.1.1 | 426 [418–453] | 428 [414–439] | 408 [404–414] | 409 [403–434] | 406 [402–408] |
| Next.js 16.4.5 | 268 [263–277] | 278 [272–285] | 274 [270–282] | 277 [270–287] | 267 [264–271] |
| Nuxt 4.6.4 | 1461 [1384–1550] | 1498 [1483–1545] | 1522 [1479–1602] | 2231 [2190–2362] | 1575 [1531–1647] |

### dev first response of / (cold) — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.16.1 | 182 [179–186] | 181 [179–182] | 223 [220–228] | 287 [269–288] | 191 [190–193] |
| Astro 7.4.5 | 1509 [1473–1535] | 1521 [1473–1623] | 1470 [1462–1483] | 1713 [1682–1793] | 1603 [1551–1654] |
| SvelteKit 3.1.1 | 749 [716–777] | 745 [720–757] | 730 [708–737] | 843 [806–903] | 716 [708–734] |
| Next.js 16.4.5 | 1315 [1286–1358] | 1333 [1328–1405] | 1365 [1323–1444] | 1405 [1393–1438] | 1346 [1302–1360] |
| Nuxt 4.6.4 | 2219 [2160–2328] | 2297 [2263–2327] | 2309 [2256–2392] | 3016 [2962–3123] | 2385 [2345–2450] |

### dev first response of a second route — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.16.1 | 22 [22–23] | 22 [22–23] | 23 [22–24] | 26 [24–26] | 21 [20–21] |
| Astro 7.4.5 | 28 [27–29] | 29 [27–31] | 28 [27–28] | 45 [40–48] | 28 [28–30] |
| SvelteKit 3.1.1 | 29 [27–30] | 29 [28–32] | 27 [26–27] | 28 [27–29] | 27 [26–28] |
| Next.js 16.4.5 | 373 [370–377] | 386 [371–402] | 385 [368–394] | 405 [387–422] | 365 [358–368] |
| Nuxt 4.6.4 | 25 [24–27] | 27 [26–28] | 26 [24–27] | 28 [25–29] | 26 [22–28] |

### static build (every page to HTML) — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.16.1 | 170 [168–172] | 173 [172–175] | 217 [201–219] | 426 [421–441] | 185 [184–188] |
| Astro 7.4.5 | 812 [799–827] | 811 [788–834] | 877 [871–881] | 1310 [1287–1335] | 835 [820–840] |
| SvelteKit 3.1.1 | 1157 [1135–1160] | 1075 [1047–1100] | 1096 [1090–1100] | 2005 [1940–2242] | 1046 [1036–1050] |
| Next.js 16.4.5 | 2321 [2196–2442] | 2299 [2154–2385] | 2398 [2321–2714] | 5429 [4969–5824] | 2148 [2090–2226] |
| Nuxt 4.6.4 | 2424 [2373–2545] | 2374 [2309–2457] | 2516 [2481–2646] | 4592 [4469–4916] | 2354 [2328–2372] |

### server build (render per request) — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.16.1 | 65 [63–68] | 64 [63–66] | 67 [65–68] | 87 [86–88] | 70 [68–73] |
| Astro 7.4.5 | 848 [838–855] | 838 [834–855] | 893 [877–909] | 921 [896–964] | 879 [871–886] |
| SvelteKit 3.1.1 | 1111 [1048–1150] | 1040 [1037–1046] | 1030 [1028–1035] | 1106 [1092–1119] | 1092 [1066–1099] |
| Next.js 16.4.5 | 2309 [2226–2594] | 2364 [2340–2565] | 2471 [2283–2603] | 2468 [2253–2545] | 2095 [2078–2126] |
| Nuxt 4.6.4 | 3470 [3308–3661] | 3205 [3185–3240] | 3420 [3379–3519] | 3997 [3910–4116] | 3253 [3238–3277] |

### `/` in the browser — JS / total transfer, KB gzip

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.16.1 | 11.83 / 13.5 (2.77 idle) | 11.83 / 13.94 (2.77 idle) | 11.83 / 13.94 (2.77 idle) | 11.83 / 13.92 (2.77 idle) | 14.46 / 16.8 (2.77 idle) |
| Astro 7.4.5 | 9.9 / 11.34 | 9.9 / 11.77 | 9.9 / 11.78 | 9.9 / 11.76 | 12.08 / 14.28 |
| SvelteKit 3.1.1 | 36.69 / 38.11 | 40.02 / 41.67 | 39.71 / 41.35 | 39.81 / 41.45 | 40.31 / 42.02 |
| Next.js 16.4.5 | 140.96 / 142.48 | 141.54 / 154.87 | 141.56 / 154.55 | 141.51 / 154.81 | 141.79 / 152.92 |
| Nuxt 4.6.4 | 80.4 / 84.34 | 80.4 / 88.29 | 80.4 / 93.93 | 80.4 / 136.92 | 80.69 / 88.65 |

### a post page in the browser — JS / total transfer, KB gzip

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.16.1 | 11.54 / 13.66 (2.77 idle) | 11.54 / 13.66 (2.77 idle) | 11.54 / 13.66 (2.77 idle) | 11.54 / 13.66 (2.77 idle) | 11.54 / 13.66 (2.77 idle) |
| Astro 7.4.5 | 9.66 / 11.53 | 9.66 / 11.53 | 9.66 / 11.53 | 9.66 / 11.53 | 9.66 / 11.53 |
| SvelteKit 3.1.1 | 36.61 / 38.12 | 36.61 / 38.12 | 36.61 / 38.11 | 36.61 / 38.11 | 36.61 / 38.11 |
| Next.js 16.4.5 | 138.78 / 141.82 | 138.78 / 142.05 | 138.78 / 140.33 | 138.78 / 165.77 | 138.78 / 142.05 |
| Nuxt 4.6.4 | 80.4 / 84.62 | 80.4 / 86.03 | 80.4 / 91.76 | 80.4 / 134.04 | 80.69 / 86.32 |

### `/posts` (search island) in the browser — JS / total transfer, KB gzip

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.16.1 | 12.05 / 13.67 (2.77 idle) | 12.05 / 13.86 (2.77 idle) | 12.05 / 15.25 (2.77 idle) | 12.05 / 27.89 (2.77 idle) | 12.05 / 13.86 (2.77 idle) |
| Astro 7.4.5 | 10.12 / 11.51 | 10.12 / 11.7 | 10.12 / 13.15 | 10.12 / 26.19 | 10.12 / 11.7 |
| SvelteKit 3.1.1 | 36.49 / 37.93 | 36.92 / 38.48 | 40.2 / 42.77 | 69.06 / 85.07 | 36.92 / 38.48 |
| Next.js 16.4.5 | 138.1 / 141.96 | 138.34 / 154.26 | 140.69 / 183.86 | 162.58 / 232.28 | 138.34 / 160.64 |
| Nuxt 4.6.4 | 80.4 / 84.33 | 80.4 / 93.51 | 80.4 / 105.41 | 80.4 / 201.45 | 80.69 / 93.8 |

### `/stats` (50-row table island) in the browser — JS / total transfer, KB gzip

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.16.1 | 12.64 / 14.65 (2.77 idle) | 12.64 / 15.01 (2.77 idle) | 12.64 / 16.35 (2.77 idle) | 12.64 / 16.37 (2.77 idle) | 12.64 / 15.01 (2.77 idle) |
| Astro 7.4.5 | 10.21 / 11.81 | 10.21 / 12.18 | 10.21 / 13.61 | 10.21 / 13.64 | 10.21 / 12.18 |
| SvelteKit 3.1.1 | 36.41 / 38.16 | 36.62 / 38.52 | 37.35 / 39.84 | 37.37 / 39.86 | 36.62 / 38.51 |
| Next.js 16.4.5 | 141.24 / 145.2 | 141.46 / 162.12 | 142.3 / 170.04 | 142.31 / 170.57 | 141.46 / 159.8 |
| Nuxt 4.6.4 | 80.4 / 84.53 | 80.4 / 92.72 | 80.4 / 100.16 | 80.4 / 142.51 | 80.69 / 93.01 |

### `/contact` (form) in the browser — JS / total transfer, KB gzip

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.16.1 | 11.54 / 13.16 (2.77 idle) | 11.54 / 13.16 (2.77 idle) | 11.54 / 13.16 (2.77 idle) | 11.54 / 13.16 (2.77 idle) | 11.54 / 13.16 (2.77 idle) |
| Astro 7.4.5 | 9.66 / 11.04 | 9.66 / 11.04 | 9.66 / 11.04 | 9.66 / 11.04 | 9.66 / 11.04 |
| SvelteKit 3.1.1 | 35.97 / 37.46 | 35.97 / 37.46 | 35.97 / 37.46 | 35.97 / 37.46 | 35.97 / 37.46 |
| Next.js 16.4.5 | 134.35 / 135.7 | 134.35 / 135.7 | 134.35 / 135.7 | 134.35 / 135.7 | 134.35 / 135.7 |
| Nuxt 4.6.4 | 79.92 / 82.91 | 79.92 / 84.31 | 79.92 / 90.04 | 79.92 / 132.33 | 80.21 / 84.61 |

### Scaling — fixed cost and marginal cost (from the medians)

| framework | metric | fixed (ms) | per page (ms) | per island (ms) |
|---|---|---|---|---|
| Nowaki | dev ready line (cold) | 138 | 0.01 | -0.3 |
| Nowaki | dev first response of / (cold) | 191 | 0.1 | 1.2 |
| Nowaki | dev first response of a second route | 22 | 0 | -0.1 |
| Nowaki | static build (every page to HTML) | 177 | 0.25 | 1.3 |
| Nowaki | server build (render per request) | 64 | 0.02 | 0.7 |
| Nowaki | JS on `/` per island (KB gzip) | | | 0.29 |
| Astro | dev ready line (cold) | 964 | 0 | 1.3 |
| Astro | dev first response of / (cold) | 1493 | 0.22 | 9.1 |
| Astro | dev first response of a second route | 28 | 0.02 | -0.1 |
| Astro | static build (every page to HTML) | 814 | 0.5 | 2.7 |
| Astro | server build (render per request) | 856 | 0.07 | 4.6 |
| Astro | JS on `/` per island (KB gzip) | | | 0.24 |
| SvelteKit | dev ready line (cold) | 422 | -0.01 | -2.4 |
| SvelteKit | dev first response of / (cold) | 738 | 0.1 | -3.2 |
| SvelteKit | dev first response of a second route | 28 | 0 | -0.2 |
| SvelteKit | static build (every page to HTML) | 1077 | 0.92 | -3.3 |
| SvelteKit | server build (render per request) | 1060 | 0.04 | 5.8 |
| SvelteKit | JS on `/` per island (KB gzip) | | | 0.03 |
| Next.js | dev ready line (cold) | 273 | 0 | -1.2 |
| Next.js | dev first response of / (cold) | 1334 | 0.07 | 1.4 |
| Next.js | dev first response of a second route | 380 | 0.02 | -2.3 |
| Next.js | static build (every page to HTML) | 2226 | 3.19 | -16.7 |
| Next.js | server build (render per request) | 2374 | 0.1 | -29.9 |
| Next.js | JS on `/` per island (KB gzip) | | | 0.03 |
| Nuxt | dev ready line (cold) | 1466 | 0.76 | 8.6 |
| Nuxt | dev first response of / (cold) | 2247 | 0.77 | 9.8 |
| Nuxt | dev first response of a second route | 26 | 0 | -0.2 |
| Nuxt | static build (every page to HTML) | 2358 | 2.23 | -2.2 |
| Nuxt | server build (render per request) | 3341 | 0.66 | 5.4 |
| Nuxt | JS on `/` per island (KB gzip) | | | 0.03 |

### Production servers — 100 pages × 1 island, rendered per request unless noted, median of runs

| server | start (ms) | idle RSS (MB) | peak RSS (MB) | TTFB p50 / p99 (ms, 1 conn) | post pages req/s (p99 ms, 50 conns) | `/` req/s (p99 ms, 50 conns) | `/api/search` req/s (p99 ms, 50 conns) |
|---|---|---|---|---|---|---|---|
| Nowaki 0.16.1 | 179 | 298.8 | 299.1 | 0.2 / 0.61 | 9830 (9.77) | 16746 (5.58) | 32910 (4.05) |
| Astro 7.4.5 | 168 | 340.9 | 353 | 0.3 / 1.02 | 5395 (19.49) | 7065 (13.98) | 14091 (8.21) |
| SvelteKit 3.1.1 | 101 | 340.1 | 341 | 0.23 / 0.81 | 6763 (11.97) | 4682 (16.74) | 22739 (5.11) |
| Next.js 16.4.5 | 369 | 437.5 | 459.4 | 1.02 / 2.43 | 1197 (54.6) | 1385 (48.17) | 6925 (14.62) |
| Nuxt 4.6.4 | 173 | 366.9 | 369.6 | 0.63 / 5.15 | 1947 (44.85) | 2079 (39.62) | 31106 (4.47) |
| Nowaki 0.16.1 (NOWAKI_CSP=enforce) | 180 | 299.9 | 300.6 | 0.21 / 0.56 | 9442 (10.25) | 16245 (5.71) | 30676 (3.99) |
| Nowaki 0.16.1 (ISR on post pages, 60 s) | 220 | 127.6 | 127.8 | 0.08 / 0.27 | 91284 (2.4) | 11634 (9.26) | 22076 (5.67) |
| Next.js 16.4.5 (ISR on post pages, 60 s) | 372 | 374.9 | 389 | 0.29 / 1.22 | 4824 (18.33) | 1245 (54.93) | 6665 (16.02) |
| Nuxt 4.6.4 (ISR on post pages, 60 s) | 172 | 279.8 | 291.8 | 0.11 / 0.33 | 18179 (5.26) | 2044 (40.75) | 33358 (3.21) |
