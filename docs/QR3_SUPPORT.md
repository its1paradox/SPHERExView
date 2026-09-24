# SPHEREx QR3 support

Scientific and archive documentation checked on **2026-09-24**. QR3 became
available on 2026-09-16. This implementation supports discovery, cutouts,
visualization coadds, six-detector comparison maps and IRSA spectrophotometry.

## Choosing data

The **Data release** selector offers **All available (QR2 + QR3)**, **QR2** and
**QR3**, independently of the wide/deep survey selector. The default is all.
The choice follows bookmarks, blink/comparison launches, spectrum links and
processing recipes. Old bookmarks without a release now search both releases.

| Release | Wide SIA collection | Deep SIA collection | Pinned pipeline spectral WCS |
| --- | --- | --- | --- |
| QR2 | `spherex_qr2` | `spherex_qr2_deep` | `cal-wcs-v4-2025-254` |
| QR3 | `spherex_qr3` | `spherex_qr3_deep` | `cal-swcs-v5-2026-191` |

Discovery queries every selected collection on each request. It validates the
returned collection and image URL, and treats failed/truncated queries as
errors. It identifies an exposure by observation ID and detector, keeps the
newest processing (preferring QR3 where reprocessed copies overlap), and
records superseded URLs. Display limits sample the timeline after discovery;
the six-detector tool uses the full inventory unless a preview cap is chosen.
New observations can appear as IRSA ingests its weekly releases; QR3 is not a
replacement for all earlier QR2 coverage.

## Calibration policy

**QR2 and QR3 images retain their native calibrations and are never averaged
into the same coadd.** They can share a timeline, but a release boundary also
splits an epoch. Fixed date bins in the six-detector tool can therefore produce
separate QR2 and QR3 epochs with the same date boundaries. Static detector
coadds likewise contain separate products for each release.

This is a deliberate response to the gain and spectral calibration changes
described in Explanatory Supplement v2.0, §2.1. Observation date alone does not
identify a calibration: early survey-3 observations were initially processed
with the QR2 pipeline. The app checks both archive identity and the primary
FITS `VERSION` (QR2: 6.4 through R6; QR3: R7). R8 and unrecognized versions are
rejected pending review. The tested versions are 6.5.6 and 7.0.5; a version
check alone does not replace the per-file scientific checks below.

The supplement describes full-resolution `l3_flux_corrections_Dn` maps for
putting QR2 on the new gain calibration. **This app does not apply those maps.**
A future cross-release estimator must validate their applicability, coordinate
orientation and background convention, then scale intensities and uncertainties
consistently (variance by the factor squared). A scalar detector-wide multiplier
would not implement a per-pixel calibration.

## FITS and wavelength handling

- QR3 uses an `EPSF` binary table; QR2 uses the legacy `PSF` image extension.
  QR3 table presence/type is validated and recorded. The app does not interpret
  it as an image cube, fit its own PSF photometry, or claim PSF matching.
- Mask definitions come from each file: legacy `MP_*` cards or R7
  `MSKNnnnn`/`MSKMnnnn` name/value pairs. Missing or inconsistent definitions
  fail validation. Detector defects and defined artifact flags, including
  crosstalk, ghosts, streaks, blooming, snowballs and halos, are excluded.
  `SOURCE` and `FULLSAMPLE` alone remain valid. Conservative artifact masking
  also applies to QR2, so coverage can differ from earlier app versions.
- IMAGE and ZODI are converted to MJy/sr and VARIANCE to (MJy/sr)² using their
  declared units. Non-finite values, nonpositive variances and flagged fine
  astrometry are excluded. Negative calibrated intensities remain data.
- Exposure times use `MJD-AVG` and explicit `TIMESYS`, converted to UTC and
  checked against the archive midpoint to within one second.
- Six-detector wavelength selection and maps use full-resolution `CWAVE` and
  `CBAND`. Active-pixel WCS A locates the cutout in the original detector; the
  code verifies detector identity, sky orientation and agreement of the
  exposure/calibration `WCS-WAVE` tables. This includes the long-wavelength
  detector orientation. Approximate WCS-WAVE values are never substituted for
  these science maps.
- An explicit spectral-calibration version in FITS HISTORY is used when
  available; otherwise the release-specific pin above is used and validated.
  Current R7 HISTORY records calibration UUIDs rather than versioned paths.
  A missing or mismatched calibration excludes the exposure with a reason.
  A future calibration without a versioned path may require a registry update.
- The basic timeline/static visualization path still reports the approximate
  WCS-WAVE wavelength at the target, explicitly identified as a visualization
  lookup in its provenance. It does not use that lookup for wavelength cuts.

Comparison manifests record release, pipeline/calibration versions, source
URLs, file hashes, mask definitions, calibration HISTORY and input rejection
reasons. Epoch FITS includes `RELEASE` and `GAINCONV=F`, plus the input manifest.
The linear estimator and formal variance propagation are unchanged.

## Spectra

Forced photometry remains with the official IRSA service. IRSA states that its
updated service applies the new gains to QR2; the app **does not apply another
gain correction**. Existing job links retain the processing of that job.

The release selector filters returned measurements by `data_collection`; it
does not promise a release-restricted remote job. Unknown provenance stays
visible under All and is excluded from release-specific selections. CSV/JSON
downloads use the selected release; the original VOTable always contains all
job results and is labeled accordingly. Band, quality and log-display filters
affect the displayed plot/table only. Signed fluxes, uncertainties and units
are preserved in the downloaded data. Quality checks use JavaScript BigInt so
photometry bits 32 and 33 are not truncated.

## Validation and limits

The regression suite exercises both release collections, discovery failures,
deduplication, both mask schemas, signed intensities, variances, full-resolution
wavelengths, overlapping epoch bins, FITS provenance, filtered spectrum exports,
high flag bits, bookmarks and real React flows with synthetic responses.

The [live validation record](validation/qr3-2026-09-24.json) contains checks of
QR3 D1/D4/D6 and QR2 D4 public cutouts, with the production calibration loader.
The D4 cone query returned 37 QR2 and 18 QR3 observations. A new IRSA job at
(232.651627115°, −10.7387224253°), MJD 61241–61242, returned 28 QR3 measurements
in µJy, including negative fluxes and flags above bit 31. A separate deep-field
query at (270°, 66.56°), radius 0.00001°, returned 24,092 QR2-deep and 1,201
QR3-deep rows with the expected collection identities (discovery only). The original VOTable
hash and product/calibration hashes are retained in the record.

Reproduce the image checks (requires network and the backend dependencies):

```bash
python scripts/validate_qr3.py > qr3-validation.json
```

Optionally inspect that completed photometry job while IRSA retains it:

```bash
python scripts/validate_qr3.py --spectrum-job f8e2f796-c508-4c38-b40f-cc089f0ec83f > qr3-validation.json
```

These are integration and numerical regression checks, **not an independent
absolute-photometry validation**. Live image coverage was sampled in three QR3
detectors, not every detector/field/pipeline version. The instrument PSFs remain
unmatched. Detector coadds combine varying LVF wavelengths and are not
monochromatic measurements or WISE W1/W2-equivalent bandpasses. Formal variance
does not include calibration systematics or uncertainty in the zodiacal model;
resampled pixels can be correlated. Use the official photometry products and
quality documentation for quantitative source measurements.

## Primary sources

- [IRSA release announcement, 2026-09-16](https://irsa.ipac.caltech.edu/news.html)
- [SPHEREx Quick Release overview and data citations](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_qr.html)
- [Explanatory Supplement v2.0, 2026-08-25](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/SPHEREx_Expsupp_QR.pdf),
  especially §2.1, the mask/photometry sections, calibration products and EPSF appendix.
- [Official spectral-image tutorial and pipeline calibration products](https://caltech-ipac.github.io/irsa-tutorials/spherex-intro/)
- [Official PSF tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-psf/)
- [IRSA spectrophotometry documentation](https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html)
- [Spectral-response products and their detector-coordinate convention](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/spherex_spectral_calibrations.html)

Data DOIs: QR2 [10.26131/IRSA652](https://doi.org/10.26131/IRSA652);
QR3 [10.26131/IRSA662](https://doi.org/10.26131/IRSA662).
