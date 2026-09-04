# Time-resolved COLOR coadd movie — research note

SPHERExView v15 · September 2026 · implements the unWISE/WiseView time-resolved coadd paradigm on SPHEREx QR2 data

## 1. Motivation: what WiseView actually blinks

WiseView does not blink raw WISE exposures. It blinks **unWISE time-resolved coadds**: Meisner, Lang & Schlegel grouped WISE exposures by six-month sky pass and built one W1 and one W2 coadd per pass, reaching ~1.3 mag deeper than a single exposure while preserving the survey's natural time sampling ([Meisner et al. 2018](https://arxiv.org/abs/1710.02526)). WiseView made those epoch coadds blinkable in a browser ([Caselden et al. 2018, ASCL 1806.004](https://ascl.net/1806.004)), and that combination — coadd depth plus preserved epochs — is what powered Backyard Worlds: its first brown dwarf moved 0.7″/yr and was 0.9 mag fainter than W2's single-exposure limit ([Kuchner et al. 2017](https://arxiv.org/abs/1705.02919)), and the same paradigm found the ~250 K, 8.1″/yr object WISE 0855−0714 ([Luhman 2014](https://arxiv.org/abs/1404.6501)).

SPHEREx has the same natural cadence: one complete all-sky spectral survey every ~6 months, four in the 25-month prime mission ([SPHEREx survey description](https://spherex.caltech.edu/page/survey)). A typical low-ecliptic-latitude position collects its full 102-channel spectrum from ~51 exposures during one pass ([Bock et al. 2025](https://arxiv.org/html/2511.02985v1)), while the two deep fields near the ecliptic poles get 50–100× that redundancy ([Crill et al. 2020](https://arxiv.org/abs/2404.11017)). **Six-month bins are therefore not an arbitrary display setting — they are SPHEREx's natural epoch unit, exactly as they were for unWISE.**

## 2. What was implemented

### Backend: `GET /api/coadd-movie`

- Queries all QR2 exposures at the target (SIA2), sorts by MJD, and — when more exist than `limit` — subsamples **evenly across time** rather than truncating, so the movie always spans the full archive baseline.
- Bins exposures into `bin_months`-wide windows (default 6.0, range 0.25–25, `bin_days = bin_months × 30.4375`) anchored at the first exposure.
- Within each bin, splits exposures into a **short channel (D1–D4, 0.75–3.82 µm → blue)** and **long channel (D5–D6, 3.82–5.0 µm → orange)**, matching the LVF detector split ([Crill et al. 2020](https://arxiv.org/abs/2404.11017)).
- Each channel is stacked with the same estimator as the per-detector CO-ADD panel: reprojection onto **one shared north-up tangent-plane grid** (6.2″/px) with flux-conserving interpolation, per-exposure scalar sky-inverse-variance weights from the QR2 VARIANCE extension, optional zodi subtraction from the L2 ZODI model, and 5σ/2-iteration sigma clipping.
- Each channel image is then normalized to **per-bin robust z-scores** (median / 1.4826·MAD), so every epoch is displayed in units of its own sky noise — brightness changes seen while blinking are real relative changes.
- A bin with only one channel is still returned, flagged `short-only` / `long-only`; a configurable `min_channel_exposures` floor (≥3 recommended for robust clipping, default 1 for the still-sparse QR2 archive) can drop under-filled channels.
- Full provenance per frame: bin window (MJD + UTC), per-channel exposure counts, detectors, mean target wavelength, center coverage, sky sigma in MJy/sr, estimator description.

### Frontend: `movie.html`

A dedicated page (button **"Time-resolved movie"** next to the spectrum button) with its own control panel: coordinates/FoV/survey, coadd window (1, 2, 3, 6, 12 months), max exposures, zoom, blink speed, stretch, black/white percentiles, invert. One set of display limits is computed from **all frames of both channels together**, keeping the blink photometrically rigid. The viewer has play/pause/step/slider, hover RA/Dec readout, sky-anchored pins with copy + one-click spectrum extraction, and a per-epoch metadata panel. The view is URL-hash-driven and shareable, and every frame shares one WCS so nothing "swims" between epochs.

## 3. Validation (all automated, against the live IRSA archive)

**Barnard's star recovers its Gaia proper motion.** The wide survey has two passes over the field so far (2025-08→10 and 2026-03→05). Barnard's star saturates SPHEREx — its core pixels are NaN-masked in the L2 products, leaving a crisp masked hole inside a >100σ ring — so the test tracks the hole centroid. Between the two passes it moved **(+0.17, −0.99) px versus the Gaia DR3 ephemeris prediction of (+0.07, −0.97) px** (north-up display; μ = 10.36″/yr, [Gaia DR3](https://www.cosmos.esa.int/web/gaia/dr3)): the movie detects real proper motion at the ~0.1 px level over a single 7-month baseline.

**Deep-field cadence resolves monthly.** At the North Ecliptic Pole deep field, 1-month bins yield 15 consecutive COLOR epochs spanning 2025-04 → 2026-07 with ~10 exposures each — a genuine month-by-month movie, exactly the regime the research review predicted for the high-redundancy poles.

**Pipeline invariants** (scripted checks, all passing): per-channel z-scores have median ≈ 0 and robust σ within 0.998–1.000 of unity; all frames share byte-identical WCS; bins are chronological, non-overlapping, and every exposure lies inside its bin window. A 17-check Playwright e2e validates the button-to-movie flow, color rendering (blue/orange separation on canvas), blink/step/slider, pins, metadata panel, rebinning (6→12 months correctly merges the two Barnard passes into one frame), URL sync, and a clean console; all previous suites (v14 color coadd, per-detector coadd, URL state, combined WISE→SPHEREx movie, trace styles) still pass.

## 4. Honest scientific scope

- **Displacement per bin is small for ordinary movers.** At 6.2″/px, a 0.5–2″/yr source shifts only 0.04–0.16 px between adjacent 6-month bins; WISE 0855-class objects (8.1″/yr) shift 0.65 px per bin and ~2.6 px over the prime mission ([Luhman 2014](https://arxiv.org/abs/1404.6501)). Visual blinking will catch extreme movers and variables; sub-pixel astrometry (as in the Barnard test) extends this to slower motion on bright sources.
- **Color is not instantaneous.** The blue and orange samples in one bin are taken at different pointings over days–weeks ([SPHEREx mission update](https://exoplanets.nasa.gov/internal_resources/3342/ExoPAG32-1510_Akeson_SPHEREx_Mission_Update.pdf)); a fast transient can acquire spurious color. Each frame is labeled a survey-pass composite, and per-channel exposure counts/time ranges are exposed in the metadata panel.
- **Where it shines:** variability in noise-normalized units; extreme movers; artifact/transient rejection (a source that persists across independently-stacked bins is real); and coadd-depth sensitivity per epoch — idealized per-pass stacking gains of ~8× (short channel) and ~6× (long channel) over one spectral sample ([NASA SPHEREx presentation](https://science.nasa.gov/wp-content/uploads/2024/07/bock-apac-spherex-july2024-v4.pdf)).
- **The killer diagnostic for cold brown dwarfs:** an orange-dominated source that moves between epoch coadds — the WISE 0855 signature, now at SPHEREx depth with 102-channel spectra one pin-click away.

## 5. Defaults chosen

| Setting | Default | Rationale |
|---|---|---|
| Bin width | 6 months | One SPHEREx all-sky pass = the unWISE epoch unit |
| Alternatives | 1/2/3/12 months | Deep-field cadence (short) or full-mission merge (long) |
| Weighting | scalar sky inverse-variance | Photometrically unbiased for constant-λ stacking |
| Outlier rejection | 5σ, 2 iterations | Removes cosmic rays/persistence without eating PSF cores |
| Normalization | per-bin robust z-score | Equalizes zodi/depth differences between passes |
| Exposure cap | 500, sampled evenly in time | Bounded build time, full time baseline preserved |

A full literature review with derivations and the audit trail of every number quoted here accompanies this note (`time_resolved_coadd_research.md`).
