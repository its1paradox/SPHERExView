# SPHERExView epoch grouping and two-color science

## Executive summary

### Recommended implementation

1. **Replace calendar-first binning with visit-first temporal clustering.** For each sky position and detector, sort usable exposures by MJD and start a new epoch when the gap between consecutive exposures is **greater than 30 days**. SPHEREx normally takes **1–2 weeks** to obtain a target’s complete 102-channel spectrum, while the all-sky reference cadence is about **six months**, so 30 days lies safely between the intra-visit and inter-visit timescales ([Bock et al., *The SPHEREx Satellite Mission*](https://arxiv.org/html/2511.02985v2)). This is the SPHEREx-scaled analogue of time-resolved unWISE: Meisner et al. sort frames by MJD and split at gaps greater than 90 days, thereby grouping the frames from each physical WISE sky pass rather than imposing fixed calendar boundaries ([Meisner, Lang & Schlegel 2018](https://iopscience.iop.org/article/10.3847/1538-3881/aacbcd)).
2. **Use duration windows only as a continuous-coverage fallback.** If a gap-defined component spans more than the requested nominal period \(P = \texttt{bin_months}\times30.4375\) days because no qualifying gap exists, divide the full component into a rounded number of **balanced** windows rather than anchoring rigid windows at its first exposure; this avoids creating a tiny terminal fragment. This is particularly important near the ecliptic poles: SPHEREx’s deep fields are visible every orbit and accumulate much greater redundancy than the all-sky field ([Crill et al. 2024](https://ar5iv.labs.arxiv.org/html/2404.11017); [SPHEREx survey page](https://spherex.caltech.edu/page/survey)). It also follows the precedent of unWISE, which adds an explicit duration cap near the poles because ordinary gap clustering otherwise produces epochs lasting months or years ([Meisner, Lang & Schlegel 2018](https://iopscience.iop.org/article/10.3847/1538-3881/aacbcd)).
3. **For “D6-focused” color, render D6 as orange and D4 as blue.** D4 (2.42–3.82 µm) contains WISE W1’s 3.4 µm region, while D6 (4.42–5.00 µm) is the closest SPHEREx detector-level analogue to W2 at 4.6 µm ([SPHEREx instrument specifications](https://spherex.caltech.edu/page/instrument); [WISE All-Sky Explanatory Supplement](https://wise2.ipac.caltech.edu/docs/release/allsky/expsup/sec4_4h.html)). D4 therefore preserves the physical contrast that makes cold T/Y dwarfs orange: W1 samples strong 3.3 µm methane absorption, whereas W2 samples a relatively transparent 4.6–4.7 µm window ([Tinney et al. 2012](https://arxiv.org/html/1209.6123v1); [Kirkpatrick et al. 2014](https://arxiv.org/pdf/1402.1378v1)).
4. **Do not use D6 alone for a two-color mode, and do not make D1–D5 the default blue reference.** D6-only orange is a monochrome significance image, not a color discriminator. D1–D5 mixes the 3.83–4.41 µm D5 flux into the reference and therefore suppresses the very D6 excess being sought; D1–D4 is a useful optional “broad short-wave veto,” but it is not as faithful to W1−W2 as D4 alone.
5. **Update the WISE 0855 test center.** A proper-motion propagation from the published epoch-2022.9 position gives a mean ICRS position of approximately **(133.7610°, −7.24233°) on 2025-07-01**, **(133.75988°, −7.24223°) on 2026-01-01**, and **(133.75835°, −7.24211°) on 2026-09-04**. Annual parallax can move the apparent position by up to roughly 0.45″ around that mean. The propagation uses the position, proper motion, and parallax in [JWST program 2327](https://www.stsci.edu/jwst/phase2-public/2327.pdf). The current test center (133.786°, −7.245°) is about **99″** from the 2026-09-04 mean position and represents roughly a 2015-era location, not the 2025–2026 location.

## 1. Epoch grouping

### What unWISE and WISE/NEOWISE actually do

WISE’s survey geometry produces a natural visit structure. At a typical sky location, WISE obtains at least about 12 exposures over roughly one day, then returns approximately six months later; the time-resolved coadds stack the exposures within each such visit into one coadd per band ([Meisner, Lang & Schlegel 2018](https://iopscience.iop.org/article/10.3847/1538-3881/aacbcd)). Later unWISE descriptions likewise call each epoch one biannual sky pass, not an arbitrary calendar semester ([unTimely Catalog paper](https://irsa.ipac.caltech.edu/data/WISE/unWISE/docs/2209.14327v2.pdf)).

The published construction algorithm is explicitly gap based:

- process each unWISE tile and band independently;
- select contributing exposures and sort them by MJD;
- insert an epoch boundary where the gap between consecutive exposures exceeds **90 days**;
- treat the frames between boundaries as one time slice;
- assign local, chronological epoch numbers—equal epoch numbers on different tiles need not refer to the same MJD ([Meisner, Lang & Schlegel 2018](https://iopscience.iop.org/article/10.3847/1538-3881/aacbcd)).

Near the ecliptic poles, WISE coverage becomes nearly continuous, so the ordinary greater-than-90-day rule can yield a time slice lasting months or years. For pole-centered footprints, unWISE therefore subdivides any slice spanning more than 15 days into epochs no longer than approximately 10 days ([Meisner, Lang & Schlegel 2018](https://iopscience.iop.org/article/10.3847/1538-3881/aacbcd)). The important precedent is not the numerical value 90 days—which reflects WISE’s one-day visits—but the **two-regime design**: use natural temporal gaps over most of the sky and a duration-based fallback where coverage is continuous.

### SPHEREx timescales

SPHEREx uses fixed linear-variable filters and obtains a spectrum by repeatedly placing a source at different positions in the field of view; the mission has 102 spectral channels and four independent all-sky surveys over its nominal 25-month science campaign ([SPHEREx survey page](https://spherex.caltech.edu/page/survey)). A typical all-sky target requires **1–2 weeks** to accumulate its full 102-channel spectrum, and the resulting all-sky measurements provide a reference approximately every six months ([Bock et al. 2025](https://arxiv.org/html/2511.02985v2)). The earlier mission description similarly states that each complete survey takes about six months and that four complete surveys are planned ([Crill et al. 2024](https://ar5iv.labs.arxiv.org/html/2404.11017)).

Coverage is strongly latitude dependent. Every point along the ecliptic receives at least four complete spectra, while the North and South ecliptic-pole deep fields receive much greater redundancy ([SPHEREx survey page](https://spherex.caltech.edu/page/survey)). The polar regions are visible on every orbit, so a “visit” ceases to be separable by a long gap there ([Crill et al. 2024](https://ar5iv.labs.arxiv.org/html/2404.11017)). Thus a single fixed-calendar method is not physically faithful at ordinary latitude, while a gap-only method is not sufficient in the continuous-coverage zones.

### Concrete algorithm

```python
P = bin_months * 30.4375       # requested maximum/nominal epoch span
G = min(30.0, 0.25 * P)        # default 30 d when P >= 120 d

times = sorted(unique_good_exposure_mjds)
components = split_where(diff(times) > G)

epochs = []
for c in components:
    if span(c) <= P:
        epochs.append(c)       # a natural sky-pass visit
    else:
        k = max(1, round(span(c) / P))
        if span(c) / k > 1.25 * P:
            k += 1
        epochs.extend(split_into_k_balanced_time_windows(c, k))

# Quality guard, never cross a natural gap:
for epoch in epochs:
    record n_exp, mjd_min, mjd_max, mjd_mean, span_days, max_internal_gap
    flag rather than silently discard epochs with n_exp < min_exposures
```

**Parameter recommendation for the current six-month UI setting**

| Parameter | Default | Rationale |
|---|---:|---|
| `gap_days` | **30 d** | More than twice the typical 1–2-week spectral-acquisition interval, but far below the roughly six-month revisit separation ([Bock et al. 2025](https://arxiv.org/html/2511.02985v2)). |
| `target_epoch_days` | **182.625 d** | Preserves the user’s existing six-month temporal resolution and supplies a deterministic pole fallback; balanced subdivision may vary modestly around this target to avoid tiny edge bins. |
| `min_exposures` | **5 as a warning, not a split/merge rule** | Prevents a shallow coadd from looking authoritative without allowing a quality heuristic to merge across a true seasonal gap. |
| Boundary convention | **split only when `gap > gap_days`** | Deterministic and matches the wording of the unWISE rule ([Meisner, Lang & Schlegel 2018](https://iopscience.iop.org/article/10.3847/1538-3881/aacbcd)). |
| Epoch timestamp | **exposure-weighted mean MJD**, plus min/max | Better represents the astrometric time of the coadd than the calendar-window center. |

For `bin_months < 4`, scale the gap threshold as shown so that it cannot exceed one quarter of the requested epoch span. For the normal six-month mode, keep `G = 30 d`. Do **not** merge across a greater-than-30-day natural break merely to meet `min_exposures`; that would mix distinct visits and blur moving sources. If operational interruptions create two subclusters separated by 15–30 days, they remain together, which is appropriate because the documented spectrum-building interval is already as long as two weeks.

This algorithm fixes the observed 3/35/5 failure mode. If those 43 frames belong to one physical SPHEREx visit and no internal gap exceeds 30 days, they become one 43-exposure epoch even when the visit crosses a calendar boundary. At a pole, where no long gaps appear, the same code automatically reverts to balanced approximately-\(P\)-day segments rather than creating one mission-long coadd or a nearly empty edge bin.

### Optional refinements

- **Use one shared epoch partition across detectors for blinking.** Build temporal boundaries from the union of good exposures at the sky position, then assign each detector’s frames to those boundaries. This keeps D4 and D6 composites temporally aligned even when one detector has a rejected exposure.
- **Expose diagnostics.** Show exposure count, MJD range, epoch span, and maximum internal gap in the UI. A user should be able to distinguish a natural visit from a fallback window.
- **Mission-boundary anchoring.** If official SPHEREx survey/pass identifiers become available in metadata, prefer those identifiers over inferred time gaps. Until then, local MJD-gap clustering is less brittle than globally anchored calendar dates.
- **Avoid “tiny-fragment repair” across natural gaps.** A fragment produced by fixed-window fallback may be merged with an adjacent fallback segment, but a component separated by `gap_days` should remain scientifically independent.

## 2. Two-color composites for a D6-focused blink

### Why W1/W2 works for cold brown dwarfs

WISE W1 and W2 are centered at 3.4 and 4.6 µm, respectively ([WISE All-Sky Explanatory Supplement](https://wise2.ipac.caltech.edu/docs/release/allsky/expsup/sec4_4h.html)). W1 sits on the strong fundamental methane absorption near 3.3 µm, while W2 samples a relatively opacity-free region near 4.6–4.7 µm; this drives increasingly red W1−W2 colors in cool T and Y dwarfs ([Tinney et al. 2012](https://arxiv.org/html/1209.6123v1); [Kirkpatrick et al. 2014](https://arxiv.org/pdf/1402.1378v1)). Published WISE samples show W1−W2 increasing from roughly 0.6 mag at T0 to roughly 1.5 mag at T5 and above 3 mag for late-T dwarfs ([Kirkpatrick et al. 2011](https://dspace.mit.edu/bitstream/handle/1721.1/76592/Simcoe_The%20first.pdf?sequence=1&isAllowed=y)).

At still shorter wavelengths, T/Y spectra are strongly structured and suppressed by H2O, CH4, NH3, and collision-induced H2 absorption; by contrast, the approximately 5 µm atmospheric window carries comparatively strong emergent flux ([Morley et al. 2014](https://iopscience.iop.org/article/10.1088/0004-637X/787/1/78); [Skemer et al. 2016 NASA record](https://ntrs.nasa.gov/api/citations/20160011255/downloads/20160011255.pdf?attachment=true)). This is why a cold object can be inconspicuous in a short-wave reference yet conspicuous in D6.

WISE 0855 is the extreme test case. A recent reanalysis reports **W1 = 19.27 ± 0.37**, **W2 = 13.91**, and **W1−W2 = 5.36 ± 0.4 mag**, with an effective-temperature range around 250–300 K ([Wright 2025](https://arxiv.org/html/2505.12105v2)). Earlier work already found W1−W2 greater than 3.9 and a temperature near 250 K ([Wright et al. 2014](https://arxiv.org/html/1405.7350v2)). Its spectrum has been measured at 4.5–5.2 µm and shows water-vapor structure in this thermal-emission window ([Skemer et al. 2016 NASA record](https://ntrs.nasa.gov/api/citations/20160011255/downloads/20160011255.pdf?attachment=true)).

### Which SPHEREx reference band?

SPHEREx’s detector ranges are D1 0.75–1.09 µm, D2 1.10–1.62 µm, D3 1.63–2.41 µm, D4 2.42–3.82 µm, D5 3.83–4.41 µm, and D6 4.42–5.00 µm ([SPHEREx instrument specifications](https://spherex.caltech.edu/page/instrument)). The mapping to WISE is therefore spectral, not merely aesthetic:

| Composite option | Scientific assessment | Recommendation |
|---|---|---|
| **(a) D6 only, orange** | Every detected source is orange; hue contains no spectral information. Useful as a monochrome D6 signal-to-noise view, not as a brown-dwarf color view. | Keep only as a monochrome mode. |
| **(b1) D6 orange + D4 blue** | Closest detector-level W2/W1 analogue. D4 contains 3.4 µm and the 3.3 µm CH4 trough; D6 contains the 4.6–5.0 µm window. | **Default D6-focused color mode.** |
| **(b2) D6 orange + D1–D4 blue** | Strong broad short-wave non-detection veto and potentially higher reference S/N for ordinary stars, but combines a very broad 0.75–3.82 µm SED and is no longer a W1−W2-like color. | Optional “broad blue reference” mode. |
| **(c) D6 orange + D1–D5 blue** | D5 reaches 4.41 µm, adjacent to D6 and within the rising 4–5 µm flux region. It leaks the sought cold-object signal into blue and compresses the D6 excess. | Do not use as the default. |

The most faithful answer is therefore **D4 blue, D6 orange**. If D4 is too shallow for a useful contextual image, an inverse-variance D1–D4 reference can be offered as a separate visualization, clearly labeled “short-wave reference” rather than “W1 analogue.” D1–D3 should not be expected to improve the actual color measurement of a 250–400 K object; their main value is showing ordinary field sources and vetoing shorter-wavelength counterparts.

### Rendering details needed to preserve physical color

1. Build D4 and D6 from the **same time epoch** and common astrometric grid.
2. Background-subtract each detector coadd and PSF-match the sharper image to the broader PSF before combining colors.
3. Convert to a common calibrated flux-density unit. Set the relative blue/orange gains so a chosen neutral calibration locus—ordinary unsaturated field stars near zero W1−W2-like color—renders approximately neutral.
4. Apply the same monotonic stretch, preferably asinh, after calibration. Independent per-channel percentile normalization can make every field look balanced but destroys quantitative color meaning.
5. Map orange as a mixture of red and green and D4 to blue; preserve an optional color-bar or reported D4−D6 flux ratio so hue is interpretable rather than purely decorative.
6. Require a positive D6 detection but allow a D4 upper limit. The scientifically important Y-dwarf case is often a blue-channel non-detection, so clipping non-detections to zero should produce saturated orange rather than suppress the candidate.

### Is WISE 0855 likely visible to SPHEREx?

No publication located in this review reports a confirmed SPHEREx detection of WISE 0855. Its W2 brightness of about 13.9 Vega mag and its measured 4.5–5.2 µm spectrum make D6 the favorable SPHEREx detector, whereas its much fainter 3.4 µm flux makes D4 challenging ([Wright 2025](https://arxiv.org/html/2505.12105v2); [Skemer et al. 2016 NASA record](https://ntrs.nasa.gov/api/citations/20160011255/downloads/20160011255.pdf?attachment=true)). SPHEREx preflight predictions place the 3.8–5.0 µm five-sigma point-source sensitivity at approximately AB 16.6–18 per spectral channel, depending on wavelength and sky position ([Feder et al. 2025](https://arxiv.org/html/2505.24856v1)). A detector-wide D6 coadd combines many narrow channels/exposures and should therefore be more favorable than a single-channel image, but actual detectability must be measured from the released D6 frames rather than inferred from W2 alone.

## 3. WISE 0855−0714 position for testing

The catalog-like name encodes an old position, and this object moves exceptionally fast. A JWST program lists an epoch-2022.9 ICRS position of **RA 133.7669250°, Dec −7.24282°**, proper motion \(\mu_{\alpha *}=-8118.396\) mas yr\(^{-1}\), \(\mu_\delta=+680.546\) mas yr\(^{-1}\), and parallax 0.448528″ ([JWST program 2327](https://www.stsci.edu/jwst/phase2-public/2327.pdf)). An independent JWST observation measured it on 2023-12-02 at **RA 08:55:03.51, Dec −07:14:33.47**, consistent with that high westward motion ([Limbach et al. 2025](https://arxiv.org/html/2510.24575v1)).

Propagating the epoch-2022.9 position with the quoted proper motion gives the following **mean ICRS positions**; these values omit the seasonal parallax displacement:

| Date | RA (deg) | Dec (deg) | Sexagesimal |
|---|---:|---:|---|
| 2025-01-01 | 133.762150 | −7.242423 | 08:55:02.916, −07:14:32.72 |
| 2025-07-01 | 133.761023 | −7.242329 | 08:55:02.646, −07:14:32.39 |
| 2026-01-01 | 133.759878 | −7.242234 | 08:55:02.371, −07:14:32.04 |
| 2026-09-04 | 133.758347 | −7.242107 | 08:55:02.003, −07:14:31.58 |
| 2026-12-31 | 133.757613 | −7.242046 | 08:55:01.827, −07:14:31.36 |

For implementation testing:

- center a 2025 stack near **(133.761°, −7.2423°)**;
- center a 2026 stack near **(133.759°, −7.2422°)**, or **(133.75835°, −7.24211°)** for the current 2026-09-04 date;
- allow at least a **2″ radius** around the propagated mean position for annual parallax, astrometric uncertainty, and coadd registration;
- for a single static search center spanning both 2025 and 2026, use approximately **(133.760°, −7.2422°)** with at least a **10″ radius**;
- do not rely on **(133.786°, −7.245°)** unless the cutout half-width exceeds about **100″**.

Transforming the cited epoch-2022.9 ICRS position gives WISE 0855 an ecliptic latitude of approximately −23.6° ([JWST program 2327](https://www.stsci.edu/jwst/phase2-public/2327.pdf)), so it is an ordinary-latitude validation target rather than a polar continuous-coverage case. Its exposure sequence should therefore show distinct survey visits and is a good regression test for the 30-day gap rule.

## Implementation decision

Ship the following defaults:

```text
epoch_mode = "visit_gap"
gap_days = 30
target_epoch_days = bin_months * 30.4375
continuous_coverage_fallback = "balanced_time_windows"
minimum_exposures_warning = 5

d6_color_mode.orange = D6
d6_color_mode.blue = D4
d6_color_mode.optional_blue = inverse_variance(D1..D4)
```

This preserves natural SPHEREx visits at ordinary latitude, prevents a sky pass from being split by an arbitrary month boundary, remains bounded in the polar deep fields, and restores the methane-versus-4.6 µm color contrast that makes WiseView effective for cold moving-object discovery.
