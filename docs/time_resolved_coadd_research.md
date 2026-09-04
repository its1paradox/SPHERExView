# Time-resolved color coadds for SPHERExView

## Executive assessment

The strongest precedent is the time-resolved unWISE/WiseView system: retain the sensitivity of stacking, but preserve the natural survey epochs and blink them. For SPHERExView, a six-month bin is likewise the correct default because SPHEREx completes one spectral all-sky survey in about six months and four independent surveys in its nominal 25 months ([SPHEREx survey description](https://spherex.caltech.edu/page/survey); [NASA/JPL mission overview](https://www.jpl.nasa.gov/press-kits/spherex/mission-overview/)). The analogy is not exact, however. WISE obtains a visit's repeated W1/W2 frames in roughly one day; SPHEREx assembles a typical target's 102-channel spectrum from 51 non-contemporaneous exposures spread over roughly one to two weeks ([Meisner et al. 2018](https://iopscience.iop.org/article/10.3847/1538-3881/aacbcd); [SPHEREx mission update](https://exoplanets.nasa.gov/internal_resources/3342/ExoPAG32-1510_Akeson_SPHEREx_Mission_Update.pdf)). Consequently, each SPHEREx movie frame should be labeled as a **survey-pass composite**, not an instantaneous color image.

The defensible product is a display-optimized, two-channel movie: blue = D1–D4 (0.75–3.82 µm), orange = D5–D6 (3.82–5.0 µm), with photometrically valid coadds retained behind the display normalization ([Crill et al. 2020](https://arxiv.org/abs/2404.11017)). Its principal value is variability, extreme-motion discovery, and artifact/transient diagnosis—not a wholesale replacement for unWISE proper-motion work.

## 1. The unWISE/WiseView precedent

WISE's scan strategy revisits a typical sky position every six months, obtaining at least 12 exposures over about one day. Meisner, Lang, and Schlegel grouped those exposures by visit and made one W1 (3.4 µm) and one W2 (4.6 µm) coadd per epoch; their initial release generally provided six epochs over 5.5 years and reached about 1.3 mag fainter than the single-exposure limit ([Meisner et al. 2018](https://arxiv.org/abs/1710.02526)). Six months is therefore not an arbitrary visualization setting: it is WISE's natural full-sky pass cadence.

WiseView operationalized the result as an interactive browser blinker for motion and variability ([Caselden et al. 2018, ASCL 1806.004](https://ascl.net/1806.004)). It fetches unWISE cutouts, lets users select epochs and blink modes, adjust field of view and stretch, and display W1+W2 with W1 blue and W2 red/orange ([WiseView help](http://byw.tools/wiseview)). The unTimely team explicitly recommends WiseView for inspecting time-resolved coadds for blending and artifacts ([Meisner et al. 2023](https://irsa.ipac.caltech.edu/data/WISE/unWISE/docs/2209.14327v2.pdf)).

This representation enabled citizen-science discovery rather than merely prettier images. Backyard Worlds asks volunteers to inspect short animations built from time-resolved WISE coadds; its first reported brown dwarf, WISEA J110125.95+540052.8, moved about 0.7″/yr and was 0.9 mag fainter than W2's single-exposure sensitivity ([Kuchner et al. 2017](https://arxiv.org/abs/1705.02919)). Follow-up of 95 especially cold candidates confirmed motion for 75, including nine above 1″/yr and one near 2.15″/yr ([Meisner et al. 2020](https://arxiv.org/abs/2008.06396)). The broader WISE motion-search paradigm also found the approximately 250 K object WISE 0855−0714 through its 8.1″/yr motion and 0.454″ parallax ([Luhman 2014](https://arxiv.org/abs/1404.6501)). This is the paradigm SPHERExView should port: combine enough frames to reveal a faint red source, then make displacement or flux change perceptually obvious.

## 2. SPHEREx cadence, coverage, and non-simultaneous color

SPHEREx measures 0.75–5.0 µm with six linear-variable-filter (LVF) detectors and 6.2″ pixels; the first four bands cover approximately 0.75–3.82 µm and the final two 3.82–5.0 µm ([Doré et al. 2018](https://arxiv.org/abs/1805.05489); [Crill et al. 2020](https://arxiv.org/abs/2404.11017)). An exposure is about 117 s and produces six detector images. Small approximately 11.8′ repointings move a source across successive LVF wavelengths, so a complete 102-channel spectrum requires **51 spacecraft exposures (two channels per exposure)** and is normally accumulated over one to two weeks, not at one instant ([Bock et al., SPHEREx satellite mission](https://arxiv.org/html/2511.02985v1); [NASA SPHEREx presentation](https://science.nasa.gov/wp-content/uploads/2024/07/bock-apac-spherex-july2024-v4.pdf)).

At low ecliptic latitude, the practical count is therefore one complete spectrum—nominally 51 exposures yielding 102 wavelength samples—per six-month all-sky pass, repeated four times in the prime mission. The passes are offset by half a spectral-resolution element so the four surveys yield two Nyquist-sampled spectra after two years ([Crill et al. 2020](https://arxiv.org/html/2404.11017v1)). Near the ecliptic poles, geometry produces far more visits: the two roughly 100 deg² deep fields have 50–100 times the all-sky redundancy and exceed 400 observations per channel at their centers ([Bock et al.](https://arxiv.org/html/2511.02985v1)).

The key implementation consequence is temporal chromaticity. D1–D4 and D5–D6 samples contributing to a nominally six-month color frame occur at different pointings and wavelengths over days to weeks; SPHEREx documentation explicitly warns that an object's measurements are not contemporaneous ([SPHEREx mission update](https://exoplanets.nasa.gov/internal_resources/3342/ExoPAG32-1510_Akeson_SPHEREx_Mission_Update.pdf)). A fast transient or variable can therefore acquire a spurious blue/orange color. Store and expose each channel's weighted mean MJD and time span, and warn when their time centroids differ materially.

IRSA's QR2 archive is suitable input: QR2 supersedes QR1 and reprocesses all spectral images from mission start with improved calibration ([IRSA Quick Release overview](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_qr.html)). Each Level-2 detector MEF provides calibrated IMAGE, FLAGS, VARIANCE, an unsubtracted modeled ZODI image, spatial PSFs, and wavelength WCS; quality screening can also cause an observation to lack one or more of the six detector products ([IRSA SPHEREx data-product guide](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/)).

## 3. Quantitative scientific value and limits

Angular displacement is \(d=\mu\Delta t\), and pixel displacement is \(d/6.2''\). The resulting scale comparison is:

| Motion case | SPHEREx: 6 months | SPHEREx: 2 years | unWISE: 10 years |
|---|---:|---:|---:|
| 0.5″/yr | 0.25″ = 0.040 px | 1.0″ = 0.16 px | 5″ = 1.82 px |
| 2.0″/yr | 1.0″ = 0.16 px | 4.0″ = 0.65 px | 20″ = 7.27 px |
| WISE 0855, 8.1″/yr | 4.05″ = 0.65 px | 16.2″ = 2.61 px | 81″ = 29.45 px |

The comparison uses SPHEREx's 6.2″ sampling ([Doré et al. 2018](https://arxiv.org/abs/1805.05489)), unWISE's 2.75″ pixels ([Meisner et al. 2018](https://iopscience.iop.org/article/10.3847/1538-3881/aacbcd)), and WISE 0855's measured motion ([Luhman 2014](https://arxiv.org/abs/1404.6501)). Backyard Worlds finds objects from roughly a few tenths to a few arcseconds per year: its first discovery was 0.7″/yr, while a 95-object cold sample reached 2.15″/yr at the fast end ([Kuchner et al. 2017](https://arxiv.org/abs/1705.02919); [Meisner et al. 2020](https://arxiv.org/abs/2008.06396)).

Thus ordinary 0.5–2″/yr movers shift only 0.04–0.16 SPHEREx pixel between adjacent bins and 0.16–0.65 pixel over the mission. Subpixel centroiding can outperform the pixel scale for isolated high-S/N sources, but visual blinking of faint or blended sources will usually not. WISE 0855-class objects are the credible visual-motion regime: about 0.65 pixel per bin and 2.6 pixels over two years. By contrast, unWISE couples finer sampling to a decade-scale baseline, making typical brown-dwarf motions span multiple pixels.

Parallax is still less favorable. An object at 2 pc has 0.5″ parallax amplitude, just 0.081 SPHEREx pixel (0.16 pixel peak-to-peak in the best geometry); WISE 0855's measured parallax is similar at 0.454″ ([Luhman 2014](https://arxiv.org/abs/1404.6501)). SPHEREx-only parallaxes therefore require precision astrometry across many measurements and explicit scan/chromatic-systematics modeling; they should not be promised from four displayed coadds.

The highest-value uses are consequently:

1. **Variability in noise-normalized units**, while retaining native-flux photometry separately.
2. **Extreme movers**, plus longer-baseline comparison to WISE, 2MASS, or Gaia.
3. **Artifact/transient rejection**: persistence, cosmic rays, ghosts, and missing-detector products can be distinguished from repeatable sky sources using QR2 flags and bin-to-bin persistence ([IRSA data-product guide](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/)).
4. **Sensitivity to faint red sources**: under independent equal-noise assumptions, stacking \(N\) valid measurements raises S/N by \(\sqrt{N}\). With 17 channels per detector and two channels measured in each of 51 exposures, a nominal pass contains 68 D1–D4 samples and 34 D5–D6 samples, giving idealized gains of 8.2 and 5.8 over one spectral sample ([NASA/JPL spacecraft description](https://www.jpl.nasa.gov/press-kits/spherex/mission-overview/spacecraft/); [NASA SPHEREx presentation](https://science.nasa.gov/wp-content/uploads/2024/07/bock-apac-spherex-july2024-v4.pdf)). Real gains will be smaller because throughput, source SED, PSF, and zodiacal noise vary with wavelength; SPHEREx sensitivity is zodiacal-background limited across the bandpass ([SPHEREx Sky Simulator](https://www.arxiv.org/abs/2505.24856)).

## 4. Coaddition and display methodology

Use a common tangent-plane WCS, pixel scale, dimensions, and reference pixel for every bin and both color channels. Reproject each Level-2 IMAGE once onto that grid with flux-conserving interpolation, propagate VARIANCE and masks, and never independently recenter epochs. This makes blinking astrometrically rigid; the unWISE precedent shows why this matters, since even scan-direction-dependent centroid shifts can create subtraction dipoles ([Meisner et al. 2018](https://iopscience.iop.org/article/10.3847/1538-3881/aacbcd)).

For each valid exposure \(i\), estimate a scalar sky variance \(s_i^2\) from masked blank sky—preferably the robust median of the QR2 VARIANCE values after source/flag masking—and set \(w_i=1/s_i^2\). Form

\[
C(x,y)=\frac{\sum_i w_i I_i(x,y)}{\sum_i w_i},
\qquad
V_C(x,y)=\frac{\sum_i w_i^2 V_i(x,y)}{(\sum_i w_i)^2}.
\]

Scalar per-exposure weights avoid allowing source Poisson variance or bad pixel-scale variance estimates to modulate the PSF locally. Reject flagged pixels and use a second-pass sigma-clipped residual test; unWISE likewise uses inter-exposure pixel outlier rejection and notes that it cannot identify the culprit when coverage is two or fewer ([Meisner et al. 2018](https://iopscience.iop.org/article/10.3847/1538-3881/aacbcd)).

For **display only**, robustly normalize each color channel in each bin:

\[
Z_c(x,y)=\frac{C_c(x,y)-\operatorname{median}(C_c)}
{1.4826\,\operatorname{median}|C_c-\operatorname{median}(C_c)|}.
\]

The 1.4826-scaled MAD estimates Gaussian \(\sigma\) robustly ([Simon Fraser University, Robust Measures of Scale](https://www.sfu.ca/sasdoc/sashtml/insight/chap38/sect15.htm)). Apply identical z-range and stretch parameters to all movie frames after this normalization. Preserve the unnormalized coadd and variance for photometry: per-frame normalization can suppress genuine diffuse or global variability.

This normalization is essential because zodiacal light is the dominant SPHEREx foreground/noise source and varies with time and sky position ([SPHEREx Sky Simulator](https://arxiv.org/html/2505.24856v1)). Earth's annual motion changes the observer's heliocentric distance and position relative to the tilted interplanetary-dust cloud, producing seasonal infrared-background changes even toward fixed directions ([Leinert et al. 1998](https://aas.aanda.org/articles/aas/full/1998/01/ds1449/node8.html)). Subtract the QR2 ZODI model for scientific sky products only with provenance; for the blinker, robust local background removal plus z-scoring is safer against model offsets because QR2 deliberately leaves ZODI unsubtracted ([IRSA data-product guide](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/)).

## 5. Recommended defaults and edge cases

- **Default:** six-month bins aligned to survey-pass boundaries, not rolling 183-day windows. Show pass number, date range, blue/orange weighted MJD, and exposure counts.
- **Alternatives:** offer 1, 2, 3, 6, and 12 months. One to three months is chiefly for deep fields; at low latitude it fragments a 1–2-week spectral sweep and may generate incomplete colors. Twelve months improves S/N but merges two independent passes and halves temporal resolution.
- **Coverage threshold:** require at least three valid exposures per displayed channel; label 3–4 “low coverage,” prefer at least five for robust rejection, and expose the coverage map. One exposure is a preview, not a coadd; two cannot support reliable outlier attribution, consistent with the unWISE limitation ([Meisner et al. 2018](https://iopscience.iop.org/article/10.3847/1538-3881/aacbcd)).
- **Single-channel bins:** if only D1–D4 or D5–D6 survives coverage/quality cuts, render a clearly labeled monochrome frame and leave the missing color transparent/neutral. Never duplicate one channel into both colors. This case is expected because IRSA quality assessment can omit individual detector MEFs ([IRSA data-product guide](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/)).
- **Auditability:** retain contributing observation IDs, detector IDs, wavelength ranges, weights, flags, MJD span, effective exposure count \((\sum w)^2/\sum w^2\), and coadd variance. A motion/variability candidate should always be traceable back to the Level-2 images.

The product should therefore be presented as a high-S/N, time-resolved discovery and quality-control view. Its unique SPHEREx advantage is broad 0.75–5 µm color and repeated spectrophotometry; its limitation is coarse sampling and only four nominal low-latitude epochs. Honest UI language will make that distinction a strength rather than an overclaim.
