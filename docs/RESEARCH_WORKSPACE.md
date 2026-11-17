# Research workspace

The detector explorer and WISE → SPHEREx timeline use a compact header and a
native settings dialog. The dialog locks the underlying document, supports
Escape, restores focus to its opener and has one scrolling surface. Controls
stay mounted when switching sections, preserving draft settings.

## Detector and spectrum explorer

- Coordinates and field width are in a sticky bar in the workspace, with an
  explicit Build/Apply action. Advanced recipe controls remain in settings.
- RGB has its own actual brightness legend and an optional background-neutralized
  display mode, with recorded offsets and explicit scientific limitations. See
  [the field investigation and invariance checks](validation/rgb-background-2026-11-17/README.md).
- The desktop workspace pairs a three-column, two-row detector grid with the
  aperture spectrum. Images receive 60% of the available split width by default;
  Image area adjusts this from 40–70%, and Reset layout restores 60%.
- Images only and Spectrum only use the full available workspace width.
  Images + spectrum restores the split. Focus, image view and balance persist
  in the URL. These controls do not rebuild or change scientific products.
- Both image views share stable panel dimensions. Every canvas remains square,
  and Fit field resets only display zoom and pan. The panel reserves the larger
  view height to avoid moving adjacent content when switching.
- Six detectors / RGB composite switches the spatial view without rebuilding
  scientific arrays or changing the sky pin, epoch, zoom or background choice.
- Target & recipe opens build controls; Adjust display opens image controls;
  Exports & provenance opens downloads and scientific interpretation.
- Spectrum selections and incomplete-aperture/background warnings remain
  visible. Measurement-method detail and the pixel table are disclosures.
- The SVG plot adapts to available width and height; exported axes use the same
  plot geometry. UI resizing does not change aperture samples.
- Completed comparison links include a local `result` identifier. Reopening
  retrieves the immutable result instead of starting another archive job.
  Requested recipe fields must match the saved result. A mismatch, missing
  result or malformed identifier displays an error and requires an explicit
  new build; no different field is silently substituted. These links depend
  on the same local backend retaining its result files.
- Below 900 px, the panels stack in document flow. The six-detector grid keeps
  three columns; individual tiles can be expanded for closer inspection.
  Large images and expanded details can require ordinary vertical scrolling.
- Target and playback share a compact sticky command bar; status and image-area
  controls share one row. The focus selector is in the header.

## WISE → SPHEREx timeline

- Detector & spectrum explorer is the primary spectrum entry point. It opens
  the six-detector workspace with the exact target pinned. Spectrum actions
  on either timeline image and individual mission panels use the same route;
  actions on loaded images retain the queried survey, release and field size.
- The former Generate spectrum at target button has been removed. Its distinct
  IRSA forced PSF-fit workflow remains under the explorer's Exports & provenance
  → Advanced: IRSA PSF-fit spectrum. This uses the exact pin, not the nearest
  aperture grid center, and is explicitly described as a remote extraction.
  PSF fitting and local aperture photometry are different estimators; neither
  is universally superior. See [IRSA's spectrum documentation](https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html).
- A fixed reference epoch appears beside the current timeline frame. The first
  chronological frame is the initial reference; Use current as reference sets
  another frame and First epoch restores the initial reference.
- Playback changes only the current frame. Both canvases use the existing
  shared-sky transforms, image display settings and coordinate pin conversion.
  Reference state resets when the underlying sequence changes.
- Both dates remain visible. Reference and current images are inspection views;
  differences in PSFs and wavelength sampling still affect apparent changes.
- Playback, the sky position and reference controls sit next to the images.
  Image size is limited by the viewport and the requested image-size limit;
  the coordinate readout explicitly describes render pixels.
- Target, timeline recipe and display settings are separate dialog sections.
  Individual mission panels remain available from the panel selector.

## Validation (2026-11-17)

- Final checkout frontend: 53 tests; DR1 frontend: 63 tests; DR1 backend: 135 tests.
- Both frontend production builds pass. No backend extraction formula changed.
- Final browser measurements and screenshots are recorded in the
  [UI verification report](validation/ui-final-2026-11-17/README.md).
- Checks include settings focus/scroll restoration, immutable saved-result
  restoration, focus modes, display-only RGB changes and unchanged spectra.
- These are Chrome viewport checks, not exhaustive browser/device certification.
