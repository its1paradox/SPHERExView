# Scientific audit of the RGB and live aperture feature

Audited 2026-10-06 on `codex/rgb-aperture-spectrum`. Backend algorithm after
the audit fixes: `six-detector-1.4-aperture`; extraction method remains
`native-aperture-2`.

## Verdict

The implemented measurements are consistent with the documented **native-pixel
aperture estimator**, subject to the approximation and error assumptions below.
The display is suitable for exploratory inspection of measured aperture flux.
It is **not validated as a measurement of a star's total spectral energy
distribution or physical spectral peak**, especially at masked bright cores.
Passing numerical tests does not establish absolute photometric accuracy.

The most consequential limitation is the default partial-aperture mode. A point
can contain only a tiny surviving portion of the aperture. Different masks at
different wavelengths can create an apparent slope or maximum unrelated to the
source's true spectrum. The UI correctly marks these measurements with hollow
symbols and warns about this interpretation. A smooth guide does not repair
missing flux. Choosing complete apertures removes this particular problem but
does not correct PSF losses, sky, neighbours, centering or time variability.

## Scope and checks

| Component | Assessment | Important qualification |
| --- | --- | --- |
| Flux units | Correct: MJy/sr × calibrated sr × 10¹² gives µJy. Signed flux is retained. | This is Fν, including local sky unless the annulus estimator is selected. |
| Calibration | Full-resolution CWAVE/CBAND and release-specific solid-angle products are used; detector/orientation/provenance checked. | No approximate wavelength or constant-area fallback; unavailable calibration is explicit. |
| Extraction | Per exposure on native pixels; fractional overlap and pixel areas retained. | Exact ellipse overlap uses a local affine approximation to a sky circle. |
| Masking | Invalid/fatal pixels excluded; SOURCE retained in the aperture and excluded from local sky. | Conservative mask differs from the archive's PSF-photometry policy; surviving pixels do not reconstruct flagged cores. |
| Error propagation | Correct for the stated linear estimator with independent native-pixel errors, including annulus coefficients. | Formal 1σ only; no calibration, sky-model, astrometric or covariance systematic term. |
| Coordinates and sampling | Display-row orientation and TAN transforms independently verified. | Hover snaps to the output grid, not a fitted centroid. At 6.2″ sampling, the maximum nominal offset to the closest grid center is about 4.38″. |
| Wavelength/frequency | Calibrated, area-weighted wavelength, wavelength extent and CBAND retained. ν[THz] = 299.792458/λ[µm]. | Fν stays Fν when the axis changes. Each point integrates finite, spatially varying bandpasses; this is not a monochromatic line spectrum. |
| RGB | R=(D5+D6)/2, G=(D3+D4)/2, B=(D1+D2)/2; all six required; common display stretch. | Illustrative infrared false color. Native PSFs, exposure depths and wavelength sampling differ; color is not quantitative source classification. |
| Smooth curve and maximum | Median anchors and natural cubic interpolation affect display only; raw samples remain intact. | Spline can overshoot. Largest measured Fν is not a statistically established physical peak or a peak in Fλ. |
| Epochs and exports | Separate exposure samples and release provenance retained; CSV/FITS retain scientific quantities. | Measurements within an epoch are not simultaneous. CSV does not contain invented spline samples. |

The equations and estimator choices are in
[LIVE_APERTURE_SPECTRA.md](../LIVE_APERTURE_SPECTRA.md).

## Independent numerical evidence

The reference QR2 build uses ICRS 76.956°, 30.4013°, a 124″ field,
6.2″ grid, 12.4″ aperture radius and 111 selected exposures. The independent
audit integrates subpixels through the full native celestial WCS, applies a
great-circle 12.4″ selection, and reads calibrated native IMAGE, VARIANCE,
CWAVE and solid-angle values directly. It does not use the production aperture
function, its Jacobian/SVD geometry or Photutils overlap masks. The documented
cutout-to-parent coordinate relation independently indexes the calibration maps.

Twelve measurements (two positions for each of six detectors) were compared
against the precomputed cubes. Quadrature used 64 and 128 subdivisions per
pixel, increasing to 128 and 512 for the aperture with less than 1% usable area.
The maximum flux difference was **0.0517%**; the maximum variance difference
was **0.1033%**. Both maxima occurred in the nearly empty D4 aperture, which had
only about 0.307% usable area. These differences include finite quadrature
error and the affine-geometry approximation; they are not an absolute flux
calibration error budget. This is a finite sample, not a bound for every sky
location, aperture size or distortion field.

The JavaScript coordinate transforms were checked at 200 positions against
Astropy, including rotated/sheared grids, RA wrap and declinations up to |88°|.
The largest sky-coordinate disagreement was 2.15×10⁻¹⁰ arcsec and the largest
inverse pixel-coordinate disagreement was 2.61×10⁻¹¹ pixels. This establishes
coordinate arithmetic consistency, not the astrometric precision of the images.

Machine-readable results:
[scientific-audit-numerics-2026-10-06.json](scientific-audit-numerics-2026-10-06.json).
The reproducible, cache-only script is
[`scripts/validate_aperture_science.py`](../../scripts/validate_aperture_science.py).
Run from the repository root, with the reference result and its input/calibration
FITS files already cached:

```powershell
.venv/Scripts/python.exe scripts/validate_aperture_science.py backend/cache/comparisons/02689984bc434118a9688d48e3e4a1aa --output .review/science-audit-repeat.json
```

The QR3 D1 regression was rerun on actual pipeline 7.0.5 data, using
`cal-swcs-v5-2026-191` and `cal-sapm-v3-2026-191`: 100 usable-pixel positions
and 69 complete apertures remained available on the 10×10 grid. This is a
QR3 calibration/data-path check, not an all-detector QR3 photometric survey.

A complete cache-only rebuild of the 111-exposure QR2 recipe with the corrected
backend accepted all 111 inputs. All **1,632** coadd and spectral arrays matched
the previous result exactly, including NaN placement. Thus the availability fix
preserves this existing result; its effect is demonstrated by the separate
empty-coadd/nonempty-aperture regression.

## Issues fixed during this audit

1. **Aperture availability depended on the coadd center.** An exposure with no
   usable coadd pixels was rejected before extraction, even when neighbouring
   native pixels contributed valid aperture flux. Extraction now runs before
   that decision. Spectrum-only exposures are preserved without inflating
   detector coadd exposure counts. Separate `coadd_status` records the distinction.
   Regressions reproduce the failure with both binning and nearest-neighbour
   sampling, verify saved spectral retention, and preserve rejection when both
   products are empty.
2. **Nonfinite uncertainties/wavelengths were not consistently rejected.** The
   chart could accept infinite variance while its diagnostics rejected it.
   Shared finite-value validation now keeps plotted/exportable points and
   availability counts consistent. Regressions include infinity, NaN and negative
   variance. No such nonfinite accepted sample was identified in the real-data
   checks; this is a verified input-validation defect.

Final automated checks: **69 backend tests passed, 44 frontend tests passed,
production Vite build passed**. Existing tests also cover signed units,
source-masked sky cancellation with unequal pixel areas, missing-core losses,
strict/partial agreement on unmasked inputs, Monte Carlo error propagation,
FITS/API orientation, RGB missing coverage and export context. Two existing
dependency deprecation warnings remain in the backend test environment.

## Limits that still matter scientifically

- The example bright-star core has 109 usable-pixel points but only 10 complete
  apertures at one inspected position. Some surviving apertures contain about
  0.15% of their geometrical area. Those extra points are **not recovered stellar
  flux measurements**. Coverage is area, not the fraction of stellar light.
- The default ZODI-only option retains local sky. At this star, the clean annulus
  is unavailable under the source-mask policy. The system correctly declines to
  substitute an unmasked or different background estimator.
- Fractional-pixel uncertainty uses squared linear weights, appropriate for
  propagating the variance of the weighted measured pixel values. Photutils'
  aperture-error convention uses fractional-area weighting instead. Numerical
  equality with that different convention is not a validation requirement.
- Apertures retain wavelength-dependent PSF/centering losses and neighbouring
  sources. Reliable total point-source photometry needs a separately validated
  PSF/aperture-correction and background/deblending approach, plus comparison
  with reference stars or archive spectrophotometry. A saturated core may remain
  unrecoverable even with a more sophisticated fit.
- Formal errors must not be read as total source-flux uncertainties. The
  explanatory supplement describes an additional 3% term for its catalog
  photometry; it is not present in the delivered image variance. That catalog
  prescription has not been adopted as a validated error model for our different
  aperture estimator.

## Primary sources checked

- [IRSA data-product specification](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/): calibrated units, spectral maps, pixel-area products and cutout coordinates.
- [IRSA archive data access](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/): versioned calibration product paths.
- [SPHEREx explanatory supplement v2.0](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/SPHEREx_Expsupp_QR_v2.0.pdf), §§3.2.3, 3.3 and 4.2: variance, catalog uncertainty and calibration. The locally cached 82-page PDF text was inspected; the web reader could not ingest the 29 MB PDF.
- [IRSA spectrophotometry documentation](https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html): PSF/source-model fitting, neighbours, background and quality flags.
- [Photutils aperture documentation](https://photutils.readthedocs.io/en/stable/user_guide/aperture.html): fractional overlap, sky-aperture approximation and error convention.
