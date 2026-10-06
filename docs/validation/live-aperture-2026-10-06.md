# Live aperture spectrum validation — 2026-10-06

Feature branch: `codex/rgb-aperture-spectrum`. Scientific method, equations,
primary references and interpretation limits are in
[LIVE_APERTURE_SPECTRA.md](../LIVE_APERTURE_SPECTRA.md).

## Automated checks

- Backend: 64 tests passed (`python -m pytest backend/tests`).
- Frontend: 39 tests passed (`npm test`); production Vite build passed.
- Numerical coverage includes signed MJy/sr-to-µJy conversion with calibrated
  pixel solid angles, local-background cancellation, fractional-overlap
  uncertainty checked with Monte Carlo draws, source/invalid-pixel masks,
  missing annuli, RA-wrap/high-declination registration, exposure separation,
  FITS/API orientation and precomputation limits.
- Frontend coverage includes all-six RGB membership, hue preservation,
  signed fluxes, frequency conversion, exports, seven-tile navigation,
  grid-centered pin/hover behavior without requests, and bookmark settings.

## Real archive data

The normal application API completed a QR2 build at ICRS
`76.956°, 30.4013°`, field width 124 arcsec, 6.2 arcsec output pixels,
UTC MJD range `[60918, 60940)`, visit grouping, no exposure cap, equal
coadd weights, supplied ZODI subtraction and aperture radius 12.4 arcsec.
All 111 selected exposures were accepted, with aperture maps available for
all 111. The output is one epoch with a 20×20 grid. A separate cached-data
run of the same build took 40.17 seconds; this is not a download-time or
general performance guarantee.

At grid-center pin `76.9490112283°, 30.4021609251°`, 65 usable aperture
measurements span all six detectors: D1=19, D2=16, D3=10, D4=2, D5=9,
D6=9. The highest measured Fν sample is approximately
64,310 ± 344.2 µJy at 4.3208246231 µm (69.38 THz). This is a data-path
regression check, not a claim that the source's physical spectral peak has
been identified. Flagged apertures account for omitted samples.

The same position has no usable source-free annulus measurements. Selecting
local-annulus subtraction correctly shows no measurements and disables
exports; switching back restores 65 points without rebuilding or silently
substituting the other estimator.

A QR3 D1 exposure (`2026W30_1B_0001_1`, pipeline 7.0.5) was also processed
using the real `cal-swcs-v5-2026-191` spectral and
`cal-sapm-v3-2026-191` solid-angle products. At ICRS
`232.663579354°, −10.7213238583°`, a 62 arcsec field yielded 69 finite
aperture positions out of 100. QR2's area-map `ARRAY` and QR3's
`ARRAY`/`DETECTOR` header conventions were verified and covered by tests.

## Browser and export checks

The built application was exercised in the in-app browser at desktop and
390-pixel mobile viewport widths. Checks covered the seven compact tiles,
RGB expansion, hover/pin preview and restoration, wavelength/frequency axes,
background selection shared with expanded views, and removal of the old
comparison-page spectrum-generation action.

CSV contained the 65 unrounded samples and method context. Spectrum PNGs
were opened and inspected for labels and aspect ratio; the seven-tile PNG
was inspected for RGB inclusion, registration and metadata. The existing
intensity table remains separate from the aperture flux-density plot.

## Scope of scientific validation

These checks validate the implemented aperture estimator and its integration
with released calibration products. They do not establish absolute
photometric accuracy against standard stars or reproduce the archive's
PSF-fitting service. Native PSFs, wavelength-dependent aperture losses,
non-simultaneous observations, neighbouring sources and systematic errors
remain relevant. The default estimator retains local sky after the selected
supplied-background treatment. Samples are neither interpolated into missing
wavelengths nor presented as a fitted spectral-line peak.

## Follow-up: star core, markers and connecting lines

The bright D1 coadd pixel at display row 10, column 9 corresponds to
ICRS `76.9569983784°, 30.4004388851°`. Only 10 of the 111 aperture
measurements are usable there; 101 have incomplete/invalid apertures.
Inspection of the native FITS FLAGS within the exact local aperture found
OVERFLOW in 93 omitted exposures, TRANSIENT in 76, SUR_ERROR in 63,
PERSIST in 3, NONFUNC in 3 and COLD in 1. One aperture centre is outside
its exposure's native footprint. Flag counts overlap; they are not additive.
These data explain the sparse central spectrum without changing the mask
or filling missing fluxes.

The revised display defaults to a small point, with the aperture/annulus
overlay optional. Straight connecting guides break between detectors and
across wide wavelength gaps. The chart now explains the counts of omitted
apertures and missing local-sky measurements. Frontend tests increased to
41 passing tests, including guide-gap behavior, unchanged scientific arrays,
availability diagnostics and bookmark/toggle behavior. The production build
passed; no backend estimator changes were made for this follow-up.


## Follow-up: AstroToolBox reference and partial measurements

After the user identified AstroToolBox as the reference, its public code was
inspected at commit `6dab9013c558262e99768b88d34be8fa6aa78635`. Its aperture
sums valid pixels even when a core is masked; its smooth guide interpolates
median anchors from up to eight equal-count bins per detector. The revised
viewer exposes that usable-pixel selection alongside the existing strict
complete-aperture selection, and adds a natural cubic guide using those anchors.
The full method and differences from AstroToolBox are documented separately.

The normal application rebuilt the same 111-exposure QR2 recipe with
`native-aperture-2`. At the screenshot's grid position
`76.9569983784°, 30.4021609251°` (display row 9, column 9), usable-pixel
selection provides 109 points instead of 10 strict points: D1=19, D2=18,
D3=19, D4=18, D5=18, D6=17, spanning 0.74654–4.95358 µm. This is an increase
in displayed partial measurements, not recovered full-aperture stellar flux.
Some apertures have only 0.15% usable area, emphasizing why the completeness
annotation is necessary and why the guide must not be treated as a source SED.

At the adjacent browser pin `76.9550016216°, 30.4004388851°`, the browser
showed 110 points, including 100 partial apertures. Switching to complete
apertures restored 10 D1 points. The smooth red guide, open/filled markers,
wavelength/frequency toggle and background selector were visually checked.
Local-annulus subtraction correctly remained unavailable here, with no
fallback to a different background model. A 390×844 viewport retained
readable controls/chart and no document horizontal overflow (375 px content
and scroll widths). Rings remained off by default.

The downloaded CSV contained 110 measurements, usable-area fractions and
partial flags, with estimator context. The spectrum PNG was opened and
inspected. All 14 FITS cubes for all 111 exposures were compared numerically
against the API arrays after the documented spatial-row flip; they matched.
Backend tests: **66 passed**. Frontend tests: **43 passed**. Production build
passed. New regressions cover masked-core loss without area rescaling,
complete/usable agreement on unmasked data, signed partial flux, empty
apertures, robust median anchors, analytic natural-cubic values, duplicate
wavelengths, gap breaks, display filtering and export context.

The QR3 D1 regression was rerun with the revised extractor: all 100 grid
positions had usable-pixel flux and the same 69 complete positions remained.
The correct QR3 v3 solid-angle map and full-resolution spectral calibration
were retained; no gain conversion was applied.
