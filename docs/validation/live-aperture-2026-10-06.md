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
