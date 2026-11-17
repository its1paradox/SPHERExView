# RGB background investigation and display change

## Field and evidence

Saved result `a678c919d023428cbc63aa0f94469371`, RA 133.7599588°,
Dec −7.2449993°, 240 arcsec, 6.2 arcsec pixels, DR1 + QR3 selection,
native-pixel binning and equal native-sample weights. The screenshot shows
epoch 2, 2025-10-31 to 2025-12-13 (DR1).

The blue cast is present in the coadd intensity values; it is not a CSS tint,
RGB channel swap or missing-data fill. RGB combines detector means as
R=(D5+D6)/2, G=(D3+D4)/2 and B=(D1+D2)/2. A single peak-channel asinh scale
preserves the ratios of positive channels. The original grayscale legend was
incorrect for RGB: its limits were −0.020391 to 0.92771 MJy/sr, while the actual
RGB scale was 0 to **1.17072579 MJy/sr**.

On 1,028 jointly clipped pixels of the 1,521-pixel common field in epoch 2:

| Channel | Median intensity (MJy/sr) |
| --- | ---: |
| Red | 0.0229069232 |
| Green | 0.0153889991 |
| Blue | 0.0948321498 |

These are display background estimates, not a source-masked physical sky
measurement. Blue is about 4.14 times red and 6.16 times green. D1 supplies
the largest pedestal (median 0.15294199 MJy/sr versus D2 0.03503530).

The largest D1 contributor is observation **2025W44_2B_0339_1**, sampling
approximately **1.08930 µm** across this field. Among 903 valid native pixels
outside the pipeline SOURCE mask, its IMAGE−ZODI median is **1.80809 MJy/sr**;
its 10th–90th percentiles are 1.51512–1.91323. The IMAGE median is 2.07239 and
the ZODI median 0.26421 MJy/sr. Thus a strong, spatially widespread residual
remains after the intended zodiacal subtraction.

This exposure's median contribution to the saved D1 mean on the display
background sample is **0.10117417 MJy/sr**. Reconstructing D1 without this
exposure reduces the blue-channel median on the same fixed sample from
**0.09483215 to 0.04447352 MJy/sr** (about 53%). This counterfactual is diagnostic
only: no exposure was removed from the application or its science products.
Other exposures and residual components account for the remaining background.

## Physical interpretation and limits

The evidence strongly supports **atmospheric helium airglow as the dominant
identified excess**: it is strongest near the documented 1.083 µm line, broad
over source-masked sky pixels, and the input includes a nonzero fitted helium
template amplitude (`HE_AG_AMPL=1.862825`, pipeline 7.0.5). The supplied
`HE_AIRGLOW_CONT=True` flag is corroborating context, not an independent
detection: the mission documents that it is true for D1/D2 generally.

The [SPHEREx Explanatory Supplement v2.1](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/SPHEREx_Expsupp.pdf),
Sections 2.1.1, 3.1 and 4.3.3, describes the strong atmospheric helium feature
and states that fitted atmospheric emission is not removed from calibrated
images. Subtracting ZODI alone therefore cannot remove it. This audit does not
fit the mission template itself or uniquely decompose every background
component; it does not classify each blue source or every residual as airglow.
This additional evidence refines the earlier spectrum audit, which had not
established a physical origin for the large residual.

## Display implementation

- Shared physical zero remains the default; old links retain their appearance.
- Background neutralized is an explicit, reversible RGB display option.
- Each epoch uses full-field, common-coverage RGB medians after joint symmetric
  3σ clipping with 1.4826 MAD, at most five passes. At least 16 pixels and 25%
  of the common sample must remain; otherwise it visibly falls back to shared
  physical zero. No pan, zoom or pin-dependent normalization is used.
- Offsets are subtracted from new RGB arrays. All epochs in the selected mode
  share a pooled 99.5th-percentile peak-channel white scale. For this result,
  neutralized mode uses **1.15533679 MJy/sr**.
- The visible legend reports the actual scale, mode and subtracted R/G/B
  offsets. It warns that neutralization can hide diffuse emission and temporal
  background variations. Method details report sample counts and limitations.
- The main RGB view and expanded RGB view expose the selector. Grayscale and
  wavelength legends are not shown as RGB legends. PNG + JSON exports record
  the RGB scale and offsets; JSON includes offsets for every loaded epoch.
- URL parameter `rgbbg=neutral` records the choice. It is not a science-recipe
  parameter and does not trigger a build or archive request.
- Coordinates and field width are always available in a sticky workspace bar.
  Draft changes require Apply & build; loaded data and shared result links
  retain their existing recipe until a successful build.

Median/clipping background estimation is useful for inspection but can be
biased by extended or crowded sources; see the
[Photutils background guidance](https://docs.astropy.org/projects/photutils/en/stable/user_guide/background.html).
No source-free interpretation is attached to these display offsets.

## Reproduction and invariance

`scripts/audit_rgb_background.py` reads cached inputs only, verifies their
SHA256 hashes, applies the recorded pixel masks, and independently reprojects
and accumulates native samples. All 18 saved detector coadds agree within
**3.28×10⁻⁷ MJy/sr** (float32 serialization precision). It handles FITS versus
browser row orientation explicitly. Per-exposure statistics and contributions
are in `native-audit.json`.

`scripts/verify_rgb_display.mjs` runs the actual renderer functions on the real
result: decoded scientific arrays hash identically before and after, spectrum
CSV is byte-identical, the source result file is unchanged, and returning to
shared zero reproduces the original RGB arrays. See `display-invariance.json`.
The native audit also checks hashes of result, manifest, all epoch FITS and all
spectrum FITS files. No backend extraction or coadd code was changed.

Synthetic unit tests cover known-offset recovery, bright-source rejection,
missing coverage, insufficient sample fallback, independent buffers,
reversibility and URL/science-recipe separation. DOM tests check the RGB legend,
unchanged spectrum/readout/FITS links, no network request on toggling, exported
RGB metadata, and visible coordinates/field width outside the settings dialog.

## Final UI verification

The final workspace supersedes the earlier height-constrained layouts.
See the [final UI report](../ui-final-2026-11-17/README.md) for dimensions,
screenshots, tests and limitations. RGB method details, offsets and caveats
are available in a collapsed disclosure beneath the image; the mode selector
remains visible. The science and invariance findings above are unchanged.
