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

Tiles use a small position marker by default. **Show measurement aperture**
optionally displays the actual extraction radius and background annulus;
hiding these rings does not change the photometry. **Connecting lines**
defaults on and draws straight visual guides between nearby points within
each detector. A gap wider than 1.5 times the larger of the two native CBAND
values breaks a guide. This threshold is a display convention, not a fitted
spectral model. Lines do not create samples, modify fluxes or change the
reported highest measured sample. Both display choices survive bookmarks
and are shared with expanded views.

All available **selected, usable exposure wavelengths within the displayed
epoch** are retained. There is no conversion of six broadband coadd values
into a synthetic spectrum, interpolation across gaps, or forced 102-point
sampling. The wavelength cuts, exposure cap, release and time selection still
apply. Different epochs are not combined. QR2 and QR3 keep their native gain
calibrations and remain separate.

## Research basis

The [IRSA data-product specification](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/)
defines IMAGE in MJy/sr, VARIANCE in squared intensity units, full-resolution
CWAVE/CBAND for science wavelengths, and solid-angle maps in arcsec². The
[archive access documentation](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/)
defines their versioned download paths. The implemented area-map pins are
QR2 `cal-sapm-v2-2025-164` and QR3 `cal-sapm-v3-2026-191`, verified in the
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

The default `flux` is `10^12 Σ(a_i Ω_i I_i)`, with variance
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

A sample requires at least 99.9999% usable aperture area. The optional
local-sky-subtracted sample additionally requires at least 50% usable
annulus area and at least 10 effective annulus pixels. Missing or masked
apertures are omitted without renormalizing them to an invented full flux.
Source masking and these requirements can produce spectral gaps. With local
annulus subtraction, a uniform background cancels, including with unequal
native pixel solid angles. Without it, that background is intentionally retained.

The plot reports usable and omitted exposure counts at the current position,
distinguishing incomplete/invalid apertures from insufficient clean annulus
coverage. A bright coadd does not guarantee a full spectrum: the coadd can
combine surviving pixels from many exposures while individual apertures
intersect overflow, other quality flags or missing coverage. Discarding those
pixels and rescaling the remaining area would not recover the flux of a
bright, nonuniform stellar core.

Each exposure contributes one point. Its representative wavelength is the
aperture-solid-angle-weighted CWAVE, independent of measured brightness.
The native CWAVE minimum/maximum and mean CBAND are also retained. Vertical
bars show formal 1σ; horizontal bars show the wavelength range across the
aperture, not the instrumental bandpass. CBAND is available in the point
tooltip, CSV and FITS. The frequency axis uses `ν [THz] = 299.792458 / λ [µm]`;
the ordinate remains Fν in either view.

The highlighted maximum is the **highest measured Fν sample**, not a fitted
line, statistically established feature, or peak in Fλ. The plot deliberately
does not smooth a spline through non-simultaneous finite-bandpass samples.
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

The build loads spectral arrays into the browser once. Hover/pin then selects
array entries without a server request. At most 1,000,000 exposure/grid-cell
pairs are allowed; larger recipes fail with an actionable message before
downloads rather than silently dropping wavelengths. Reduce the field/time
range, coarsen the grid or explicitly select a labelled preview cap.

The separate spectrum FITS file contains one native-order cube per quantity,
with exposure index on axis 3 and an EXPOSURES table (detector, UTC MJD, OBSID).
The manifest links each sample to input provenance and calibration hashes.
The API flips only the spatial rows for display, just like the detector maps.
CSV exports the current position's unrounded measurements, selected background estimator and method context;
PNG includes source coordinates, epoch, release, units and aperture assumptions.
The seven-tile PNG and JSON retain RGB mapping and display settings.

Existing builds without spectral arrays must be rebuilt. Missing solid-angle
calibration preserves valid intensity coadds but produces an explicit spectrum
failure in the input provenance and UI; it never invents a µJy conversion.

## Automated validation

`backend/tests/test_aperture_spectrum.py` checks signed flux and the MJy/sr-to-µJy
conversion, uniform-sky cancellation with unequal pixel areas, source-masked
annuli, incomplete apertures, insufficient sky, fractional-weight uncertainty
against Monte Carlo draws, sky registration at RA wrap/high declination, native
exposure separation, FITS/API orientation, and bounded precomputation.

`frontend/tests/live_spectrum.test.mjs` and the comparison DOM tests check
RGB membership/coverage and hue preservation, signed spectral samples,
frequency conversion, CSV quoting and context, decoding, seven-tile
navigation, grid-centered pins, temporary hover previews without requests,
epoch changes, display modes and export provenance.
