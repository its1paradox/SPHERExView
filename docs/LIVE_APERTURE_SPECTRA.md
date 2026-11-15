# RGB and live aperture spectra

The detector comparison page builds six compact detector images, a seventh
RGB tile, and exposure-level aperture spectra. Hover any image to preview a
grid position; click or press Enter to pin it. Hover temporarily overrides a
pin, which returns when the pointer leaves the image. Positions snap to output
pixel centers, including after zooming or panning. The spectrum background
selector switches instantly between the recipe's supplied-background choice
and additional local-annulus subtraction. The default retains local sky;
this remains measurable when source flags leave no clean annulus. There is
no automatic fallback between these physically different estimators.
Changing display settings
does not change the measurements or make archive requests.

Tiles use a small hollow ring for the pinned position. **Show measurement aperture**
optionally displays the actual extraction radius and background annulus;
hiding these rings does not change the photometry. **Robust smooth guide**
defaults on. As in [AstroToolBox](https://github.com/fkiwy/AstroToolBox/blob/6dab9013c558262e99768b88d34be8fa6aa78635/src/main/java/astro/tool/box/tab/SpherexViewerTab.java),
up to eight equal-count wavelength bins per detector supply median wavelength
and median flux anchors (at least three samples per detector/run). A natural
cubic spline joins the anchors across adjacent detectors within each release.
DR1 and QR3 have independent guides (solid and dashed respectively), so a joint
epoch cannot blend their brightness states into one median curve. Unlike the reference,
we break the guide where adjacent measured wavelengths differ by more than
`max(0.2 µm, 3 × larger CBAND)`. This is a display convention. Duplicate anchor
wavelengths are merged by median flux. The spline is a broad-shape visual aid:
it may overshoot, is not a physical spectral fit, creates no measured samples,
and does not determine the reported maximum. Its values are not exported as
CSV measurements. Both display choices survive bookmarks and expanded views.

The **Aperture pixels** selector defaults to **Usable pixels (include partial)**.
This retains measurable parts of flagged apertures, with open dots for partial
measurements, usable-area percentages in tooltips and an explicit warning.
**Complete apertures only** restores the stricter selection instantly.

All available **selected, usable exposure wavelengths within the displayed
epoch** are retained. There is no conversion of six broadband coadd values
into a synthetic spectrum or forced 102-point sampling. Display-guide
interpolation is kept separate from measured samples. The wavelength cuts, exposure cap, release and time selection still
apply. Different epochs are not combined. DR1 and QR3 can share an R7 coadd epoch,
but each aperture sample retains its input release. Historical QR2 results
remain readable; QR2 image searches stay retired.

## Research basis

The [IRSA data-product specification](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/)
defines IMAGE in MJy/sr, VARIANCE in squared intensity units, full-resolution
CWAVE/CBAND for science wavelengths, and solid-angle maps in arcsec². The
[archive access documentation](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/)
defines their versioned download paths. The implemented area-map pins are
QR2 `cal-sapm-v2-2025-164` and DR1/QR3 `cal-sapm-v3-2026-191`, verified in the
archive; explicit unambiguous FITS calibration history takes precedence.
Shape, detector, sky orientation, units, positive values and hashes are checked.
There is no guessed constant-pixel-area fallback.

[Photutils aperture documentation](https://photutils.readthedocs.io/en/stable/user_guide/aperture.html)
describes exact fractional pixel overlap and the local approximation involved
in sky apertures. Here the local WCS Jacobian, including SIP, maps a sky circle
to a native-pixel ellipse independently at every output position. Its overlap
is computed with `EllipticalAperture.to_mask(method="exact")`. This is exact
overlap for that local affine ellipse, not an exact spherical-polygon aperture.

The [IRSA spectrophotometry tool](https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html)
fits source models using a position-dependent PSF. This feature instead
reports explicitly labelled **aperture Fν**. It does not claim to reproduce
PSF-fitted or aperture-corrected total fluxes.

## Estimator and quality requirements

The default radius is 12.4 arcsec, configurable from 6.2 to 31 arcsec before
building. The local background annulus extends from 1.5 to 2.5 times this
radius. Download padding includes the annulus. Extraction runs on each
exposure's native IMAGE, never on resampled detector coadds.

Let `a_i` and `b_i` be the fractional aperture/annulus overlap with native
pixel `i`, `Ω_i` its calibrated solid angle in sr, and `I_i` its signed
intensity in MJy/sr after the selected supplied-ZODI subtraction (or none).
The fatal-pixel mask is shared with the coadd. SOURCE flags only exclude
pixels from background estimation; sources inside the aperture are retained.

The complete-aperture `flux` is `10^12 Σ(a_i Ω_i I_i)`, with variance
`10^24 Σ((a_i Ω_i)² Var(I_i))`. This is aperture flux including local sky
after any selected supplied-ZODI subtraction, and is labelled accordingly.

For the optional `sky_flux`, valid, source-free annulus pixels define `q_i = b_i Ω_i / Σ(b_j Ω_j)`.
With `A = Σ(a_i Ω_i)`, the linear flux estimator is:

```
c_i = 10^12 (a_i Ω_i − A q_i)
Fν [µJy] = Σ c_i I_i
Var(Fν) [µJy²] = Σ c_i² Var(I_i)
```

Combining coefficients before squaring accounts for fractional overlap if an
aperture and annulus share a native pixel. The variance assumes independent
native pixels. It includes annulus noise, but excludes calibration, model,
astrometric and native-pixel covariance systematics. Negative fluxes survive.

The strict `flux`, `variance`, `sky_flux`, and `sky_variance` arrays require
at least 99.9999% usable aperture area. The additional `usable_*` arrays apply
the same formulas over the remaining valid pixels whenever usable area is
positive; the local-background subtraction uses only that usable aperture's
solid angle. They never divide by coverage, infer a missing core, or insert
zero-valued measurements when no pixels survive. CWAVE, wavelength range and
CBAND describe the pixels actually used. With a complete aperture the two
estimators are identical. The optional local-sky estimator requires at least
50% usable annulus area and ten effective annulus pixels in either mode.
A uniform sky therefore cancels even for a partial aperture with unequal
pixel solid angles; without local subtraction it intentionally remains.

The plot distinguishes partial aperture measurements, omitted apertures and
missing clean sky. Coverage is the **fraction of aperture area**, not the
fraction of stellar light recovered. A high coverage fraction can still omit
the bright core and lose most source flux. Wavelength-dependent masks can
change the apparent spectral shape and maximum. The open dots measure flux
from the surviving regions only; they do not reconstruct the source spectrum.

### Comparison with AstroToolBox

We inspected the public implementation at commit
`6dab9013c558262e99768b88d34be8fa6aa78635`, specifically
[`SpherexPipeline.aperture`](https://github.com/fkiwy/AstroToolBox/blob/6dab9013c558262e99768b88d34be8fa6aa78635/src/main/java/astro/tool/box/spherex/SpherexPipeline.java)
and `SpherexViewerTab.createGuideData`. Its aperture sums surviving pixels
rather than requiring a complete aperture. That explains why it can show
many more points on a masked bright star. Our usable-pixel mode adopts that
selection principle and our guide adopts its median-anchor approach.
Attribution and the MIT license are in `THIRD_PARTY_NOTICES.md`.

This is not numerical parity with its full pipeline. AstroToolBox defaults
to radius two native pixels, a 2r–3r annulus, clipped median local background
with a source-mask fallback, coarse-bin outlier rejection and optional channel
binning. Here the aperture has a fixed sky radius, an explicit 1.5r–2.5r
source-masked mean annulus, full-resolution CWAVE/CBAND, release-specific solid
angles and propagated variance for the stated linear estimator. We retain
all measured exposure points without outlier rejection. Epoch/release and
background selection also matter. Equal-looking smooth curves would not
establish equal or absolutely calibrated source photometry.

Each exposure contributes one point. Its representative wavelength is the
aperture-solid-angle-weighted CWAVE, independent of measured brightness.
The native CWAVE minimum/maximum and mean CBAND are also retained. Vertical
bars show formal 1σ; horizontal bars show the wavelength range across the
aperture, not the instrumental bandpass. CBAND is available in the point
tooltip, CSV and FITS. The frequency axis uses `ν [THz] = 299.792458 / λ [µm]`;
the ordinate remains Fν in either view.

The highlighted maximum is the **highest measured Fν sample**, not a fitted
line, statistically established feature, or peak in Fλ. When partial apertures
are present it is labelled the largest plotted value instead of a source peak.
The optional spline is only a visual aid for these non-simultaneous samples.
Wavelength-dependent PSF losses, neighbour contamination and local-background
subtraction can change the shape. Extended emission in the annulus is removed;
uncatalogued neighbours are not automatically deblended.

## RGB display

The seventh tile uses `R=(D5+D6)/2`, `G=(D3+D4)/2`, `B=(D1+D2)/2`, in the
same epoch and sky grid. All six detector intensities and their coverage must
be valid. Missing data are hatched, not replaced by zero or another detector.
Each detector contributes equally within its color pair regardless of depth.
This is an illustrative composite of wavelength-mixed detector coadds.

Negative channel means clip to zero **only for rendering**. One multiplier
derived from the maximum channel applies to all three channels, preserving
positive channel ratios through the selected stretch. A pooled white scale
is fixed across epochs. No independent per-detector normalization is applied.
Native PSFs are retained; color is not an object classification.

## Precomputation, limits and exports

The recipe checkbox **Precompute aperture spectra** defaults on. Disable it
for an **images-only build**: RGB and all six detector tiles remain available,
while extraction, solid-angle downloads, aperture padding and the spectral
size limit are skipped. The image output limit still applies. This choice
survives bookmarks and only takes effect when a build is submitted.

With spectra enabled, the build loads spectral arrays into the browser once. Hover/pin then selects
array entries without a server request. At most 1,000,000 exposure/grid-cell
pairs are allowed; larger recipes fail with an actionable message before
downloads rather than silently dropping wavelengths. Reduce the field/time
range, coarsen the grid, explicitly select a labelled preview cap, or turn off
aperture spectra. This bound is across the entire job, including all epochs.

The separate spectrum FITS file contains one native-order cube per quantity,
with exposure index on axis 3 and an EXPOSURES table (detector, UTC MJD, OBSID,
release). Its PROVENANCE extension includes the input records and calibration
hashes, release DOIs, extraction recipe and epoch bounds. Each sample and input
share an input index. Spectrum release headers describe the actual spectral
contributors, independently of coadd contributors; `GAINCONV=F` and `PSFCORR=F`
record that no gain or aperture correction was added.
The API flips only the spatial rows for display, just like the detector maps.
CSV exports the current position's unrounded measurements, selected background estimator and method context;
PNG includes source coordinates, epoch, release, units and aperture assumptions.
The seven-tile PNG and JSON retain RGB mapping and display settings.

Images-only and older image results do not show a spectrum FITS download link.
Older builds must be rebuilt to obtain the usable-pixel arrays. Until then,
the viewer can show only the complete-aperture fields available in that result. Missing solid-angle
calibration preserves valid intensity coadds but produces an explicit spectrum
failure in the input provenance and UI; it never invents a µJy conversion.

## Automated validation

`backend/tests/test_aperture_spectrum.py` checks signed flux and the MJy/sr-to-µJy
conversion, uniform-sky cancellation with unequal pixel areas, source-masked
annuli, strict/partial selection, missing-core losses, fractional-weight
uncertainty against Monte Carlo draws, sky registration, native exposure
separation, FITS/API orientation and bounded precomputation.

`backend/tests/test_aperture_dr1.py` verifies joint DR1/QR3 epochs with separate
sample identities, spectrum-only contributors, standalone FITS provenance and
checksums, missing-calibration behavior, historical result downloads, and
images-only equivalence and bypass of aperture work.

`frontend/tests/live_spectrum.test.mjs`, `aperture_dr1.test.mjs` and comparison
DOM tests cover RGB coverage and hue, signed samples, frequency conversion,
finite-value validation, CSV context, independent release guides, seven-tile
navigation, hover/pin without network requests, images-only bookmarks and
historical results. These tests do not replace visual browser inspection.

Run the live archive validation explicitly:

```bash
python scripts/validate_aperture_dr1.py --inputs docs/validation/rgb-aperture-inputs-2026-11-14.json --output docs/validation/rgb-aperture-dr1-2026-11-14.json
# Repeat from cached files without network (use --reuse-cache for other cache directories):
python scripts/validate_aperture_dr1.py --offline --inputs docs/validation/rgb-aperture-inputs-2026-11-14.json --output aperture-repeat.json
```

The script uses twelve recorded public DR1/QR3 cutouts, one per detector and
release, with full-resolution wavelength and solid-angle calibration files.
It checks actual extraction, formal variances, complete/usable agreement,
images-only native-sample equivalence, spectral FITS arrays/checksums and
standalone provenance. The first run can download roughly 600 MB; caches are
reused. The current [machine-readable validation record](validation/rgb-aperture-dr1-2026-11-14.json)
covers all six detectors in both releases: twelve exposures and 1,200 usable
positions. The final check was repeated offline after downloading missing inputs;
cutout and spectral-calibration hashes are checked against the pinned input record.
The [input record](validation/rgb-aperture-inputs-2026-11-14.json) explicitly
replaces the unavailable QR3 D4 exposure with an archive-listed 2026W23 exposure
and records equivalent-size requests used to recover two byte-identical cutouts.
Without `--inputs`, the script retains its original DR1 validation input list.
Desktop/mobile production-page
checks with synthetic data are in [the browser record](validation/rgb-browser-2026-11-14.json).
These are integration and numerical checks, not an absolute calibration or a
survey-wide accuracy guarantee.
