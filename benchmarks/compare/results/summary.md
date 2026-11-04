Measured 2026-11-04 · Apple M2, 8 cores, 16 GB, darwin 25.6.0, node v24.14.0 · commit 0e830db+dirty

### dev ready line (cold) — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.14.0 | 151 [149–155] | 134 [126–137] | 146 [121–151] | 134 [117–139] | 149 [146–153] |
| Astro 7.4.5 | 978 [956–981] | 971 [960–987] | 953 [951–963] | 955 [950–960] | 981 [976–994] |
| SvelteKit 3.1.1 | 401 [390–418] | 406 [402–408] | 402 [397–415] | 435 [431–442] | 441 [438–445] |
| Next.js 16.4.5 | 273 [265–280] | 266 [263–269] | 281 [270–291] | 280 [273–302] | 287 [284–290] |
| Nuxt 4.6.4 | 1405 [1388–1441] | 1392 [1379–1419] | 1497 [1467–1572] | 2115 [2106–2144] | 1501 [1488–1521] |

### dev first response of / (cold) — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.14.0 | 199 [198–200] | 169 [168–170] | 207 [189–210] | 242 [240–268] | 211 [208–215] |
| Astro 7.4.5 | 1521 [1502–1546] | 1510 [1455–1581] | 1468 [1452–1474] | 1648 [1616–1653] | 1578 [1565–1636] |
| SvelteKit 3.1.1 | 680 [671–714] | 677 [672–690] | 691 [684–731] | 866 [859–874] | 793 [764–803] |
| Next.js 16.4.5 | 1350 [1323–1405] | 1289 [1277–1303] | 1421 [1366–1557] | 1515 [1421–1823] | 1405 [1396–1426] |
| Nuxt 4.6.4 | 2177 [2164–2219] | 2162 [2137–2176] | 2264 [2234–2343] | 2859 [2832–2895] | 2320 [2312–2358] |

### dev first response of a second route — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.14.0 | 24 [24–26] | 21 [21–21] | 22 [21–24] | 20 [20–21] | 24 [21–25] |
| Astro 7.4.5 | 27 [26–27] | 25 [25–25] | 26 [26–28] | 33 [31–33] | 31 [28–32] |
| SvelteKit 3.1.1 | 26 [26–27] | 26 [26–27] | 26 [26–27] | 29 [28–30] | 28 [28–30] |
| Next.js 16.4.5 | 387 [379–419] | 368 [360–374] | 441 [399–455] | 459 [420–480] | 391 [386–394] |
| Nuxt 4.6.4 | 24 [23–25] | 24 [24–29] | 32 [26–34] | 24 [23–26] | 25 [23–25] |

### static build (every page to HTML) — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.14.0 | 199 [196–199] | 188 [187–190] | 251 [243–254] | 700 [692–716] | 229 [227–241] |
| Astro 7.4.5 | 778 [757–812] | 751 [738–756] | 812 [801–829] | 1355 [1284–1480] | 816 [811–851] |
| SvelteKit 3.1.1 | 965 [946–1008] | 965 [961–987] | 1032 [1029–1037] | 1926 [1890–1947] | 1068 [1059–1075] |
| Next.js 16.4.5 | 2029 [1990–2045] | 2047 [1986–2265] | 2176 [2143–2207] | 4845 [4482–5229] | 2260 [2214–2325] |
| Nuxt 4.6.4 | 2282 [2264–2302] | 2239 [2207–2289] | 2517 [2435–2598] | 3807 [3791–3843] | 2534 [2344–2688] |

### server build (render per request) — median ms [p25–p75]

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.14.0 | 49 [48–49] | 46 [45–46] | 47 [47–48] | 64 [60–68] | 53 [53–54] |
| Astro 7.4.5 | 859 [851–861] | 806 [805–812] | 905 [865–971] | 950 [945–956] | 914 [907–921] |
| SvelteKit 3.1.1 | 1144 [1074–1196] | 975 [968–977] | 971 [965–982] | 1072 [1067–1080] | 1060 [1052–1077] |
| Next.js 16.4.5 | 2182 [2119–2291] | 2110 [2038–2187] | 2032 [1976–2100] | 2036 [1982–2100] | 2214 [2168–2293] |
| Nuxt 4.6.4 | 2915 [2905–3027] | 2884 [2875–2913] | 3253 [3027–3412] | 3379 [3331–3540] | 3325 [3279–3404] |

### `/` in the browser — JS / total transfer, KB gzip

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.14.0 | 13.34 / 14.09 (4.05 idle) | 13.34 / 14.53 (4.05 idle) | 13.34 / 14.54 (4.05 idle) | 13.34 / 14.51 (4.05 idle) | 16.36 / 17.78 (4.05 idle) |
| Astro 7.4.5 | 9.49 / 10.14 | 9.49 / 10.58 | 9.49 / 10.58 | 9.49 / 10.56 | 11.77 / 13.19 |
| SvelteKit 3.1.1 | 35.42 / 36 | 38.75 / 39.56 | 38.45 / 39.24 | 38.54 / 39.34 | 39.05 / 39.91 |
| Next.js 16.4.5 | 140.65 / 143.33 | 141.23 / 155.48 | 141.21 / 150.92 | 141.21 / 153.04 | 141.46 / 155.61 |
| Nuxt 4.6.4 | 77.16 / 79.73 | 77.17 / 84.99 | 77.16 / 89.28 | 77.16 / 131.55 | 77.46 / 85.34 |

### a post page in the browser — JS / total transfer, KB gzip

| framework | 1 pages × 1 islands | 10 pages × 1 islands | 100 pages × 1 islands | 1000 pages × 1 islands | 10 pages × 10 islands |
|---|---|---|---|---|---|
| Nowaki 0.14.0 | 0 / 1 | 0 / 1 | 0 / 1 | 0 / 1 | 0 / 1 |
| Astro 7.4.5 | 0 / 0.95 | 0 / 0.95 | 0 / 0.95 | 0 / 0.95 | 0 / 0.95 |
| SvelteKit 3.1.1 | 35.34 / 35.98 | 35.34 / 35.97 | 35.34 / 35.98 | 35.34 / 35.98 | 35.34 / 35.98 |
| Next.js 16.4.5 | 137.92 / 139.92 | 137.91 / 140.16 | 137.91 / 142.39 | 137.92 / 163.77 | 137.92 / 140.16 |
| Nuxt 4.6.4 | 77.16 / 79.99 | 77.17 / 81.09 | 77.16 / 85.62 | 77.16 / 127.91 | 77.46 / 81.38 |

### Scaling — fixed cost and marginal cost (from the medians)

| framework | metric | fixed (ms) | per page (ms) | per island (ms) |
|---|---|---|---|---|
| Nowaki | dev ready line (cold) | 144 | -0.01 | 1.7 |
| Nowaki | dev first response of / (cold) | 189 | 0.05 | 4.7 |
| Nowaki | dev first response of a second route | 22 | 0 | 0.3 |
| Nowaki | static build (every page to HTML) | 193 | 0.51 | 4.6 |
| Nowaki | server build (render per request) | 47 | 0.02 | 0.8 |
| Nowaki | JS on `/` per island (KB gzip) | | | 0.34 |
| Astro | dev ready line (cold) | 968 | -0.01 | 1.1 |
| Astro | dev first response of / (cold) | 1496 | 0.15 | 7.5 |
| Astro | dev first response of a second route | 26 | 0.01 | 0.6 |
| Astro | static build (every page to HTML) | 758 | 0.6 | 7.3 |
| Astro | server build (render per request) | 851 | 0.1 | 12 |
| Astro | JS on `/` per island (KB gzip) | | | 0.25 |
| SvelteKit | dev ready line (cold) | 402 | 0.03 | 3.8 |
| SvelteKit | dev first response of / (cold) | 676 | 0.19 | 12.9 |
| SvelteKit | dev first response of a second route | 26 | 0 | 0.2 |
| SvelteKit | static build (every page to HTML) | 952 | 0.97 | 11.4 |
| SvelteKit | server build (render per request) | 1031 | 0.03 | 9.4 |
| SvelteKit | JS on `/` per island (KB gzip) | | | 0.03 |
| Next.js | dev ready line (cold) | 273 | 0.01 | 2.3 |
| Next.js | dev first response of / (cold) | 1345 | 0.17 | 12.8 |
| Next.js | dev first response of a second route | 394 | 0.07 | 2.6 |
| Next.js | static build (every page to HTML) | 1981 | 2.85 | 23.7 |
| Next.js | server build (render per request) | 2113 | -0.08 | 11.6 |
| Next.js | JS on `/` per island (KB gzip) | | | 0.03 |
| Nuxt | dev ready line (cold) | 1404 | 0.71 | 12.1 |
| Nuxt | dev first response of / (cold) | 2175 | 0.69 | 17.6 |
| Nuxt | dev first response of a second route | 26 | 0 | 0.1 |
| Nuxt | static build (every page to HTML) | 2287 | 1.53 | 32.8 |
| Nuxt | server build (render per request) | 2995 | 0.4 | 49.1 |
| Nuxt | JS on `/` per island (KB gzip) | | | 0.03 |
