# 500-arcsecond public fields

This change raises the dashboard and public API field-width ceiling to 500
arcsec (250 arcsec query radius). Default field widths and pixel scales are
unchanged. No observation cap, automatic downsampling, or scientific formula
change is introduced.

At the default detector sampling of 6.2 arcsec, a 500-arcsec field has an
81-by-81 output grid. The proposed spectral work budget is 2,500,000
exposure/pixel cells. Requests exceeding that budget still fail explicitly
before downloads; they never silently process a subset. Image-cell, cache,
free-disk, concurrency and container-memory safeguards remain in place.

The field-width ceiling is not a promise that every possible field, time
range and spectrum recipe fits on the pilot server. Workload also depends
on the archive inventory and number of epochs.

## Release qualification

Before merging or deploying, run the full example field at ICRS
(133.7599588, -7.2449993), width 500, DR1 + QR3, default 6.2-arcsec sampling,
all observations and aperture spectra enabled, in an isolated container with
the production 1400 MiB memory limit. Record inventory/completion counts,
peak memory, output sizes, numerical/FITS consistency, local-result saving,
and UI behavior. The proposed spectral budget must be revised if that check
shows insufficient memory headroom.

This qualification is pending; the public application remains at the
previously deployed limit until it passes.
