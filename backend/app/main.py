"""SPHERExView backend: Wiseview-style blink viewer for SPHEREx data.

Endpoints
---------
GET /api/health                    -- liveness check
GET /api/cutouts                   -- cutouts around a position (unordered)
GET /api/epoch-stack               -- time-ordered cutout stack, ready for blinking
GET /api/coadd                     -- per-detector CO-ADD stacks (mixed-lambda)
GET /api/wise-stack                -- unWISE epoch stack (WiseView service)
POST /api/spectra/submit           -- submit an IRSA spectrophotometry job
GET /api/spectra/status/{job_id}   -- poll the job (UWS phase)
GET /api/spectra/table/{job_id}    -- flattened per-exposure spectrum (JSON)
GET /api/spectra/download/{job_id} -- result in votable / csv / json
"""

from __future__ import annotations

import hashlib
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from astropy.time import Time

from . import coadd as cx
from . import imaging
from . import spectra_client as spx
from . import spherex_client as sx
from . import wise_client as wc

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("spherex-wiseview")

STATIC_DIR = os.environ.get(
    "SPHEREX_STATIC_DIR",
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "static")),
)
os.makedirs(os.path.join(STATIC_DIR, "cutouts"), exist_ok=True)

app = FastAPI(title="SPHERExView", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/api/health")
def health():
    return {"status": "ok"}


def _build_stack(
    ra: float,
    dec: float,
    radius_arcsec: float,
    survey: str,
    band: Optional[str],
    limit: int,
):
    collection = sx.COLLECTIONS.get(survey)
    if collection is None:
        raise HTTPException(400, f"Unknown survey '{survey}'; use one of {list(sx.COLLECTIONS)}")

    radius_deg = radius_arcsec / 3600.0
    try:
        images = sx.query_sia2(ra, dec, radius_deg=radius_deg, collection=collection, band=band)
    except Exception as exc:  # network / service errors
        log.exception("SIA2 query failed")
        raise HTTPException(502, f"SIA2 query failed: {exc}") from exc

    # Time-sort for blinking; images with no timestamp go last.
    images.sort(key=lambda im: (im.mjd_mid is None, im.mjd_mid or 0.0))

    size_arcsec = 2 * radius_arcsec

    def fetch_one(im: sx.SpherexImage):
        """Download + reproject one cutout. Returns dict or None (= skip).

        Never raises: ANY failure on a single frame (transient 503, broken
        chunked transfer, corrupt FITS, WCS trouble) skips that frame
        instead of turning the whole request into a 500.
        """
        # Request a cutout ~45% larger than the display field: SPHEREx
        # exposures are rotated by arbitrary spacecraft roll angles, so the
        # north-up reprojection below needs extra margin to fill the
        # requested FoV without blank corners.
        cutout_url = sx.get_cutout_url(im.access_url, ra, dec, size_arcsec * 1.45)
        try:
            fits_path = sx.download_cutout(cutout_url)
        except sx.CutoutNoOverlapError:
            # Footprint matched the cone search but does not contain the
            # exact position (SPHEREx footprints are elongated/rotated).
            return None
        except sx.CutoutDownloadError as exc:
            log.warning("Cutout download failed, skipping: %s", exc)
            return None
        except Exception as exc:
            log.warning("Unexpected cutout error, skipping: %s", exc)
            return None

        uid = hashlib.md5(cutout_url.encode()).hexdigest()
        try:
            # Reproject to a north-up/east-left grid centered on the target
            # so every SPHEREx frame is aligned with the WISE panel.
            data, h, w, header_meta, wcs_dict = imaging.fits_to_array(
                fits_path, north_up_center=(ra, dec), out_size_arcsec=size_arcsec
            )
        except Exception as exc:
            log.warning("Pixel extraction failed, skipping: %s", exc)
            return None

        meta = im.to_dict()
        meta.update(header_meta)
        if meta.get("mjd_mid") is not None:
            meta["datetime_utc"] = Time(meta["mjd_mid"], format="mjd").isot
        else:
            meta["datetime_utc"] = None
        return {
            "id": uid,
            "data_b64": imaging.array_to_b64(data),
            "width": w,
            "height": h,
            "fits_url": cutout_url,
            "wcs": wcs_dict,
            "metadata": meta,
        }

    # Download cutouts in parallel batches until we have `limit` frames.
    # Serial downloads are the bottleneck (IRSA cutouts take seconds each).
    cutouts = []
    skipped = 0
    idx = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        while len(cutouts) < limit and idx < len(images):
            batch = images[idx : idx + max(8, limit - len(cutouts))]
            idx += len(batch)
            for res in pool.map(fetch_one, batch):
                if res is None:
                    skipped += 1
                elif len(cutouts) < limit:
                    cutouts.append(res)

    return {
        "ra": ra,
        "dec": dec,
        "radius_arcsec": radius_arcsec,
        "survey": survey,
        "count": len(cutouts),
        "skipped_no_overlap": skipped,
        "cutouts": cutouts,
    }


@app.get("/api/cutouts")
def get_cutouts(
    ra: float,
    dec: float,
    radius_arcsec: float = Query(60.0, gt=0, le=3600),
    survey: str = "wide",
    band: Optional[str] = None,
    limit: int = Query(20, gt=0),
):
    return _build_stack(ra, dec, radius_arcsec, survey, band, limit)


@app.get("/api/wise-stack")
def get_wise_stack(
    ra: float,
    dec: float,
    size_arcsec: float = Query(120.0, gt=0, le=825),
    band: str = Query("w2", pattern="^(w1|w2|w1w2)$"),
    gaia: bool = False,
):
    """Time-resolved unWISE epoch stack via WiseView (byw.tools), the same
    service AstroToolBox uses.  One frame per ~6-month WISE/NEOWISE visit
    (2010 -> present), each with its real mean observation date -- blinking
    them reveals proper motion exactly like http://byw.tools/wiseview.

    With ``gaia=true``, each frame carries Gaia DR3 markers (image-pixel
    coordinates, proper-motion propagated to the frame's mean epoch).
    """
    # "w1w2" = AstroToolBox-style color composite: W1 -> red, W2 -> blue,
    # green = average.  Frames carry BOTH pixel arrays; the frontend builds
    # the color image client-side with shared contrast limits.
    two_band = band == "w1w2"
    band_num = 1 if band == "w1" else 2

    try:
        if two_band:
            eps1 = {e["epoch"]: e for e in wc.get_epochs(ra, dec, 1)}
            eps2 = {e["epoch"]: e for e in wc.get_epochs(ra, dec, 2)}
            # pair epochs present in both bands (like ATB's min(size1, size2))
            epochs = [
                {
                    "epoch": k,
                    "forward": eps1[k]["forward"],
                    "mjdmean": 0.5 * (eps1[k]["mjdmean"] + eps2[k]["mjdmean"]),
                }
                for k in sorted(set(eps1) & set(eps2))
            ]
        else:
            epochs = wc.get_epochs(ra, dec, band_num)
    except wc.WiseCutoutError as exc:
        raise HTTPException(502, f"WiseView tiles query failed: {exc}") from exc
    except Exception as exc:
        log.exception("WiseView tiles query failed")
        raise HTTPException(502, f"WiseView tiles query failed: {exc}") from exc

    gaia_sources = None
    if gaia:
        try:
            gaia_sources = wc.query_gaia(ra, dec, size_arcsec)
        except Exception as exc:
            log.warning("Gaia query failed, markers disabled: %s", exc)

    def fetch_epoch(ep):
        try:
            b1 = 1 if two_band else band_num
            fits_path = wc.download_epoch_cutout(ra, dec, size_arcsec, b1, ep["epoch"])
            data, h, w, _, wcs_dict = imaging.fits_to_array(fits_path)
            data2 = None
            if two_band:
                fits_path2 = wc.download_epoch_cutout(ra, dec, size_arcsec, 2, ep["epoch"])
                data2, h2, w2, _, _ = imaging.fits_to_array(fits_path2)
                if (h2, w2) != (h, w):
                    log.info("WISE epoch %s: W1/W2 size mismatch, skipping", ep["epoch"])
                    return None
        except wc.WiseCutoutError as exc:
            log.info("WISE epoch %s unavailable: %s", ep["epoch"], exc)
            return None
        except Exception as exc:
            log.warning("WISE epoch %s fetch failed: %s", ep["epoch"], exc)
            return None

        t = Time(ep["mjdmean"], format="mjd")
        markers = []
        if gaia_sources:
            try:
                moved = wc.propagate(gaia_sources, t.decimalyear)
                pix = imaging.world_to_pixels(fits_path, [(s["ra"], s["dec"]) for s in moved])
                markers = [
                    {**p, "gmag": s["gmag"], "source_id": s["source_id"]}
                    for s, p in zip(moved, pix)
                    if p is not None
                ]
            except Exception as exc:
                log.warning("Gaia projection failed (epoch %s): %s", ep["epoch"], exc)

        frame = {
            "id": f"{band}_e{ep['epoch']}",
            "epoch": ep["epoch"],
            "forward": ep["forward"],
            "mjd": ep["mjdmean"],
            "datetime_utc": t.isot,
            "band": "W1+W2" if two_band else band.upper(),
            "data_b64": imaging.array_to_b64(data),
            "width": w,
            "height": h,
            "wcs": wcs_dict,
            "gaia_markers": markers,
        }
        if data2 is not None:
            frame["data2_b64"] = imaging.array_to_b64(data2)
        return frame

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(fetch_epoch, epochs))

    frames = [r for r in results if r is not None]
    frames.sort(key=lambda f: f["mjd"])
    return {
        "ra": ra,
        "dec": dec,
        "size_arcsec": size_arcsec,
        "pixscale_arcsec": wc.UNWISE_PIXSCALE,
        "band": "W1+W2" if two_band else band.upper(),
        "gaia": bool(gaia_sources),
        "count": len(frames),
        "frames": frames,
    }


@app.get("/api/epoch-stack")
def get_epoch_stack(
    ra: float,
    dec: float,
    radius_arcsec: float = Query(60.0, gt=0, le=3600),
    survey: str = "wide",
    band: Optional[str] = None,
    limit: int = Query(50, gt=0),
):
    """Time-ordered stack of cutouts for Wiseview-style blinking.

    ``limit`` is uncapped: fetching hundreds of frames simply takes longer
    (IRSA cutouts download in parallel and are cached on disk).
    """
    return _build_stack(ra, dec, radius_arcsec, survey, band, limit)


def _query_sorted_images(ra, dec, radius_arcsec, survey, band, limit):
    """SIA2 query -> exposures sorted by time, truncated to ``limit``."""
    collection = sx.COLLECTIONS.get(survey)
    if collection is None:
        raise HTTPException(400, f"Unknown survey '{survey}'; use one of {list(sx.COLLECTIONS)}")
    try:
        images = sx.query_sia2(ra, dec, radius_deg=radius_arcsec / 3600.0,
                               collection=collection, band=band)
    except Exception as exc:
        log.exception("SIA2 query failed")
        raise HTTPException(502, f"SIA2 query failed: {exc}") from exc
    images.sort(key=lambda im: (im.mjd_mid is None, im.mjd_mid or 0.0))
    return images[:limit]


def _fetch_aligned(images, ra, dec, size_arcsec, background):
    """Download + align exposures onto the shared coadd grid (parallel).

    Per-image failures (no overlap, missing extensions, ...) are skipped,
    never raised.  Returns (exposures, n_skipped).
    """

    def fetch_one(im: sx.SpherexImage):
        cutout_url = sx.get_cutout_url(im.access_url, ra, dec, size_arcsec * 1.45)
        try:
            fits_path = sx.download_cutout(cutout_url)
            exp = cx.load_aligned_exposure(
                fits_path, ra, dec, size_arcsec, background=background
            )
        except sx.CutoutNoOverlapError:
            return None
        except Exception as exc:
            log.warning("Coadd input skipped: %s", exc)
            return None
        exp.obs_id = im.obs_id
        exp.did = str(im.extra.get("obs_publisher_did", "") or "")
        if exp.mjd is None:
            exp.mjd = im.mjd_mid
        if exp.detector is None:  # header stripped -> fall back to band name
            try:
                exp.detector = int(str(im.band).rsplit("D", 1)[-1])
            except Exception:
                return None
        exp.extras["band"] = im.band
        return exp

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(fetch_one, images))
    exposures = [r for r in results if r is not None]
    return exposures, len(results) - len(exposures)


@app.get("/api/coadd")
def get_coadd(
    ra: float,
    dec: float,
    radius_arcsec: float = Query(60.0, gt=0, le=3600),
    survey: str = "wide",
    band: Optional[str] = None,
    limit: int = Query(200, gt=0),
    background: str = Query("zodi", pattern="^(zodi|none)$"),
    sigma: float = Query(5.0, ge=0),
    maxiters: int = Query(2, ge=0, le=10),
):
    """Per-detector CO-ADD of every matching SPHEREx exposure.

    For each detector (D1-D6) all exposures covering the target are
    background-subtracted (IMAGE - ZODI), resampled once onto ONE shared
    north-up grid, quality-masked via FLAGS/VARIANCE, optionally
    sigma-clipped (N >= 5), and combined with an inverse-variance weighted
    mean (per-exposure scalar weights = inverse median sky variance, so
    photometry stays unbiased).  Because each detector's LVF mixes wavelengths, the result is a
    broadband-like image; the response reports the actual wavelength range
    sampled at the target.  See backend/app/coadd.py for the full rationale.
    """
    images = _query_sorted_images(ra, dec, radius_arcsec, survey, band, limit)
    size_arcsec = 2 * radius_arcsec
    clip_sigma = sigma if sigma > 0 else None
    exposures, skipped = _fetch_aligned(images, ra, dec, size_arcsec, background)

    n_px, wcs_out = cx.output_grid(ra, dec, size_arcsec)
    wcs_dict = imaging.wcs_to_dict(wcs_out, n_px)

    import numpy as np

    coadds = []
    for det in sorted({e.detector for e in exposures}):
        group = [e for e in exposures if e.detector == det]
        try:
            img, var, coverage, n_rej, lam = cx.combine(
                group, sigma=clip_sigma, maxiters=maxiters
            )
        except Exception as exc:
            log.warning("Coadd failed for D%s: %s", det, exc)
            continue
        finite = img[np.isfinite(img)]
        if finite.size == 0:
            continue
        # Display orientation contract (matches imaging.fits_to_array):
        # NaN -> median fill, then vertical flip so row 0 is the TOP row.
        disp = np.where(np.isfinite(img), img, np.median(finite))
        disp = np.flipud(disp).astype(np.float32)
        mjds = [e.mjd for e in group if e.mjd is not None]
        meta = {
            "detector": det,
            "band": f"SPHEREx-D{det}",
            "n_exposures_used": len(group),
            "n_rejected_pixels": n_rej,
            "coverage_max": int(coverage.max()),
            "coverage_center": int(coverage[n_px // 2, n_px // 2]),
            "mjd_min": min(mjds) if mjds else None,
            "mjd_max": max(mjds) if mjds else None,
            "lambda_target_um": lam,
            "background": background,
            "method": "sky_ivar_weighted_mean"
                      + (f"_sigmaclip{clip_sigma:g}" if clip_sigma and len(group) >= 5 else ""),
            "pixscale_arcsec": cx.COADD_PIXSCALE_ARCSEC,
            "bunit": "MJy / sr (zodi-subtracted)" if background == "zodi" else "MJy / sr",
            "median_coadd_sigma": float(np.nanmedian(np.sqrt(var))),
            "obs_ids": [e.obs_id for e in group],
            "provenance": [e.did for e in group if e.did],
        }
        if meta["mjd_min"] is not None:
            meta["datetime_min_utc"] = Time(meta["mjd_min"], format="mjd").isot
            meta["datetime_max_utc"] = Time(meta["mjd_max"], format="mjd").isot
        coadds.append({
            "id": f"coadd-D{det}",
            "data_b64": imaging.array_to_b64(disp),
            "coverage_b64": imaging.array_to_b64(np.flipud(coverage).astype(np.float32)),
            "width": n_px,
            "height": n_px,
            "wcs": wcs_dict,
            "metadata": meta,
        })

    return {
        "ra": ra,
        "dec": dec,
        "radius_arcsec": radius_arcsec,
        "survey": survey,
        "background": background,
        "n_exposures_input": len(images),
        "n_exposures_skipped": skipped,
        "count": len(coadds),
        "coadds": coadds,
    }


@app.get("/api/epoch-coadds")
def get_epoch_coadds(
    ra: float,
    dec: float,
    radius_arcsec: float = Query(120.0, gt=0, le=3600),
    survey: str = "wide",
    limit: int = Query(500, gt=0),
    bin_months: float = Query(6.0, ge=0.25, le=25),
    background: str = Query("zodi", pattern="^(zodi|none)$"),
    sigma: float = Query(5.0, ge=0),
    maxiters: int = Query(2, ge=0, le=10),
    min_channel_exposures: int = Query(1, ge=1),
    band: str | None = Query(None, pattern="^SPHEREx-D[1-6]$"),
    ref: str = Query("auto", pattern="^(auto|excess|broad|none)$"),
):
    """Time-resolved COLOR epoch-coadd blink sequence: unWISE-style epoch coadds for SPHEREx.

    EPOCH GROUPING (visit-gap clustering, the unWISE rule scaled to SPHEREx).
    Time-resolved unWISE coadds are NOT calendar bins: Meisner, Lang &
    Schlegel (2018, AJ 156, 69) sort the contributing frames by MJD and
    insert an epoch boundary wherever the gap between consecutive exposures
    exceeds a threshold (90 d for WISE), so each epoch is one physical sky
    pass.  A fixed calendar window anchored at the first exposure can slice
    a natural SPHEREx visit in two, producing shallow fragment coadds (e.g.
    3 + 35 exposures) on either side of an arbitrary boundary.  Here:

    - exposures are sorted by MJD and split where the gap between
      consecutive exposures exceeds ``G = min(30 d, bin_months*30.4375/4)``
      (SPHEREx builds a full spectrum over ~1-2 weeks and revisits ~every
      6 months, so 30 d separates intra-visit from inter-visit timescales);
    - a gap-defined component whose span fits within the requested window
      is ONE epoch (``grouping = "visit"``);
    - a component longer than the window (continuous coverage: the ecliptic
      deep fields are visible every orbit) is subdivided into BALANCED
      equal-time windows (``grouping = "window"``) instead of anchored
      windows, so no tiny terminal fragment is created.

    CHANNELS.  Each epoch is stacked into a TWO-CHANNEL frame on the exact
    shared north-up grid used by /api/coadd:

    - blue channel  = short-wavelength detectors D1-D4 (< 3.82 um)
    - orange channel = long-wavelength detectors D5-D6 (3.82-5.0 um)

    ``band`` focuses the blink on ONE detector while KEEPING a two-channel
    color composite (the WiseView W1/W2 paradigm: color is the temperature
    discriminant).  With ``band=SPHEREx-D6``, the orange channel is D6 only
    (4.42-5.0 um, the W2 analogue) and the blue channel is a REFERENCE:

    - ``ref=auto``  -> the W1-analogue counterpart (D4, 2.42-3.82 um, which
      contains W1's 3.4 um bandpass and the 3.3 um CH4 fundamental) — the
      closest detector-level match to the W1-W2 color that identifies cold
      brown dwarfs (a >250 K object like WISE 0855-0714 has W1-W2 > 5);
    - ``ref=broad`` -> the full complementary side (D1-D4), a broad
      short-wave veto with more reference depth;
    - ``ref=excess`` -> same channel pairing as ``auto``; the client renders
      a grayscale reference field with a single-hue overlay only where the
      focus band is in significant excess over the reference (finder mode);
    - ``ref=none``  -> grayscale slice of just that detector (a lone band
      carries no color information, so it is never artificially tinted).

    Focusing a SHORT detector (D1-D4) mirrors this: that detector alone in
    blue against D6 (auto) or D5-D6 (broad) in orange.

    Each channel is a sky-noise (scalar inverse median variance) weighted
    mean of its zodi-subtracted, FLAGS-masked exposures, then robustly
    z-scored (median / 1.4826*MAD over finite pixels).  Z-scoring matters
    here more than in the static coadd: the zodiacal background level and
    its photon noise CHANGE between epochs at a fixed sky position, so
    frames are put in per-epoch sky-noise units to blink smoothly.

    SINGLE-CHANNEL EPOCHS.  SPHEREx's six detectors are separate strips of
    the focal plane, so a sky-pass visit can cover a position with only
    some detectors.  In a FOCUSED movie (``band`` set, ``ref != none``):
    an epoch with no focus-band exposures is dropped (it says nothing
    about the focus band at that time), and an epoch missing only the
    reference channel gets a FULL-DEPTH reference (one deep stack of all
    reference exposures in the queried span, flagged
    ``ref_scope="full-depth"`` in the channel metadata) so the color
    language stays continuous across the blink.  In the unfocused all-band
    movie, single-channel epochs are still returned and flagged in
    ``metadata.channels``.
    """
    import numpy as np

    # Detector sets for the two channels (band focus keeps a color
    # reference channel unless ref=none — see docstring).
    focus_det = int(band[-1]) if band else None
    if focus_det is None:
        short_dets, long_dets = {1, 2, 3, 4}, {5, 6}
    elif ref == "none":
        short_dets = {focus_det} if focus_det <= 4 else set()
        long_dets = {focus_det} if focus_det >= 5 else set()
    elif focus_det >= 5:
        long_dets = {focus_det}
        short_dets = {4} if ref in ("auto", "excess") else {1, 2, 3, 4}
    else:
        short_dets = {focus_det}
        long_dets = {6} if ref in ("auto", "excess") else {5, 6}
    wanted_bands = {f"SPHEREx-D{d}" for d in short_dets | long_dets}

    # No truncation at query time: when more exposures exist than ``limit``,
    # subsample EVENLY ACROSS TIME so the blink sequence still spans every epoch
    # (plain head-truncation would keep only the earliest days and collapse
    # the sequence to one bin — deep fields have thousands of exposures).
    query_band = band if (band and ref == "none") else None
    images = _query_sorted_images(ra, dec, radius_arcsec, survey, query_band, 10 ** 9)
    images = [im for im in images if str(im.band) in wanted_bands]
    if not images:
        raise HTTPException(404, "No SPHEREx exposures in the requested bands cover this position")
    if len(images) > limit:
        idx = np.unique(np.linspace(0, len(images) - 1, limit).round().astype(int))
        images = [images[i] for i in idx]
    size_arcsec = 2 * radius_arcsec
    clip_sigma = sigma if sigma > 0 else None
    exposures, skipped = _fetch_aligned(images, ra, dec, size_arcsec, background)
    exposures = [e for e in exposures if e.mjd is not None and e.detector]
    if not exposures:
        raise HTTPException(404, "No usable SPHEREx exposures cover this position")

    n_px, wcs_out = cx.output_grid(ra, dec, size_arcsec)
    wcs_dict = imaging.wcs_to_dict(wcs_out, n_px)

    # --- Visit-gap epoch clustering (see docstring) ---------------------
    bin_days = bin_months * 30.4375  # requested nominal/maximum epoch span
    gap_days = min(30.0, 0.25 * bin_days)
    exposures.sort(key=lambda e: e.mjd)
    components: list[list] = [[exposures[0]]]
    for prev, cur in zip(exposures, exposures[1:]):
        if cur.mjd - prev.mjd > gap_days:
            components.append([])
        components[-1].append(cur)

    epochs: list[tuple[list, str]] = []
    for comp in components:
        span = comp[-1].mjd - comp[0].mjd
        if span <= bin_days:
            epochs.append((comp, "visit"))  # one natural sky-pass visit
        else:
            # Continuous coverage (deep fields): balanced equal-time
            # windows across the component, never an anchored grid that
            # leaves a tiny terminal fragment.
            n_win = max(1, round(span / bin_days))
            if span / n_win > 1.25 * bin_days:
                n_win += 1
            edges = np.linspace(comp[0].mjd, comp[-1].mjd, n_win + 1)
            subs: list[list] = [[] for _ in range(n_win)]
            for e in comp:
                i = min(n_win - 1, int(np.searchsorted(edges, e.mjd, side="right")) - 1)
                subs[i].append(e)
            epochs.extend((s, "window") for s in subs if s)

    def _stack_channel(sub):
        # One channel of one epoch: sky-noise weighted mean of the
        # zodi-subtracted exposures, then robustly z-scored (median /
        # 1.4826*MAD) into per-stack sky-noise units.  Channels below the
        # exposure floor are dropped (3+ recommended for robust outlier
        # rejection; default 1 keeps sparse QR2 bins).
        if len(sub) < min_channel_exposures:
            return None
        try:
            img, var, coverage, n_rej, lam = cx.combine(
                sub, sigma=clip_sigma, maxiters=maxiters
            )
        except Exception as exc:
            log.warning("Epoch-coadd channel stack failed: %s", exc)
            return None
        finite = img[np.isfinite(img)]
        if finite.size == 0:
            return None
        # Robust z-score: per-stack sky-noise units (zodi varies
        # seasonally, so raw MJy/sr levels differ bin to bin).
        med = float(np.median(finite))
        sig_px = 1.4826 * float(np.median(np.abs(finite - med)))
        if sig_px <= 0:
            sig_px = float(np.std(finite)) or 1.0
        z = (img - med) / sig_px
        disp = np.flipud(np.where(np.isfinite(z), z, 0.0)).astype(np.float32)
        return {
            "disp": disp,
            "n": len(sub),
            "detectors": sorted({e.detector for e in sub}),
            "lambda_um": lam,
            "coverage_center": int(coverage[n_px // 2, n_px // 2]),
            "sky_sigma_mjy_sr": round(sig_px, 6),
        }

    # FOCUSED MOVIES: SPHEREx's six detectors are physically separate
    # strips of the focal plane (unlike WISE, whose W1/W2 observed
    # simultaneously through a beamsplitter), so a single sky-pass visit
    # can cover a position with the focus detector but NOT its reference
    # detector.  Two rules keep the sequence scientifically honest:
    #
    # 1. an epoch with NO focus-band exposures carries no information
    #    about the focus band at that time -> dropped from the sequence
    #    (never shown as a mislabeled grayscale of another detector);
    # 2. an epoch missing only the REFERENCE channel gets a FULL-DEPTH
    #    reference: one deep stack of ALL reference-detector exposures
    #    across the whole queried span (the unWISE/Legacy-Surveys
    #    time-resolved-vs-full-depth paradigm: the epoch information
    #    lives in the focus channel, the reference is a static
    #    comparison field).  Flagged as ref_scope="full-depth" in the
    #    channel metadata so the client can label it.
    focus_name = ref_name = None
    if focus_det is not None and ref != "none":
        focus_name = "long" if focus_det >= 5 else "short"
        ref_name = "short" if focus_name == "long" else "long"
    full_ref_cache: dict = {}

    def _full_depth_ref():
        if "ref" not in full_ref_cache:
            ref_dets = short_dets if ref_name == "short" else long_dets
            sub = [e for e in exposures if e.detector in ref_dets]
            full_ref_cache["ref"] = _stack_channel(sub) if sub else None
        return full_ref_cache["ref"]

    frames = []
    epochs_dropped_no_focus = 0
    for k, (grp, grouping) in enumerate(epochs):
        groups = {
            "short": [e for e in grp if e.detector in short_dets],
            "long": [e for e in grp if e.detector in long_dets],
        }
        channels = {}
        for name, sub in groups.items():
            ch = _stack_channel(sub)
            if ch is not None:
                channels[name] = ch
        if not channels:
            continue
        ref_scope = "epoch"
        if focus_name is not None:
            if focus_name not in channels:
                epochs_dropped_no_focus += 1
                continue
            if ref_name not in channels:
                fr = _full_depth_ref()
                if fr is not None:
                    channels[ref_name] = fr
                    ref_scope = "full-depth"
        mjds = sorted(e.mjd for e in grp)
        max_gap = max((b - a for a, b in zip(mjds, mjds[1:])), default=0.0)
        kind = "color" if len(channels) == 2 else f"{next(iter(channels))}-only"
        meta = {
            "epoch_index": k,
            "grouping": grouping,  # "visit" (natural sky pass) | "window" (continuous-coverage fallback)
            "channels": kind,
            "mjd_min": min(mjds),
            "mjd_max": max(mjds),
            "mjd_mean": round(float(np.mean(mjds)), 5),
            "span_days": round(max(mjds) - min(mjds), 3),
            "max_internal_gap_days": round(max_gap, 3),
            "shallow": len(grp) < 5,
            "datetime_min_utc": Time(min(mjds), format="mjd").isot,
            "datetime_max_utc": Time(max(mjds), format="mjd").isot,
            "n_exposures": len(grp),
            "background": background,
            "method": "per-channel sky_ivar_weighted_mean"
                      + (f"_sigmaclip{clip_sigma:g}" if clip_sigma else "")
                      + ", median/MAD z-scored per bin",
            "bunit": "sky-noise sigma (per-bin robust z-score)",
            "pixscale_arcsec": cx.COADD_PIXSCALE_ARCSEC,
        }
        if band:
            meta["band_focus"] = band
            if ref != "none":
                ref_dets = sorted(short_dets if focus_det >= 5 else long_dets)
                meta["reference"] = (
                    f"D{ref_dets[0]}" if len(ref_dets) == 1
                    else f"D{ref_dets[0]}-D{ref_dets[-1]}"
                )
        for name in ("short", "long"):
            ch = channels.get(name)
            if ch:
                meta[f"{name}_channel"] = {
                    "n_exposures": ch["n"],
                    "detectors": ch["detectors"],
                    "lambda_target_um": ch["lambda_um"],
                    "coverage_center": ch["coverage_center"],
                    "sky_sigma_mjy_sr": ch["sky_sigma_mjy_sr"],
                }
                if name == ref_name:
                    # "epoch" = reference observed in this same visit;
                    # "full-depth" = deep all-epoch reference stack
                    # substituted because this visit lacked the reference
                    # detector (separate focal-plane strips).
                    meta[f"{name}_channel"]["ref_scope"] = ref_scope
        frame = {
            "id": f"epoch{k}",
            "width": n_px,
            "height": n_px,
            "wcs": wcs_dict,
            "metadata": meta,
        }
        if "short" in channels:
            frame["data_b64"] = imaging.array_to_b64(channels["short"]["disp"])
            if "long" in channels:
                frame["data2_b64"] = imaging.array_to_b64(channels["long"]["disp"])
        else:  # long-only bin: grayscale from the single available channel
            frame["data_b64"] = imaging.array_to_b64(channels["long"]["disp"])
        frames.append(frame)

    return {
        "ra": ra,
        "dec": dec,
        "radius_arcsec": radius_arcsec,
        "survey": survey,
        "band": band,
        "ref": ref if band else None,
        "background": background,
        "bin_months": bin_months,
        "bin_days": round(bin_days, 3),
        "grouping": {
            "mode": "visit_gap",
            "gap_days": round(gap_days, 3),
            "target_epoch_days": round(bin_days, 3),
            "fallback": "balanced_time_windows",
        },
        "epochs_dropped_no_focus": epochs_dropped_no_focus,
        "n_exposures_input": len(images),
        "n_exposures_skipped": skipped,
        "count": len(frames),
        "frames": frames,
    }


# ---------------------------------------------------------------------------
# Spectrophotometry (IRSA forced-photometry spectra)


@app.post("/api/spectra/submit")
def spectra_submit(
    ra: float = Query(..., ge=0, lt=360),
    dec: float = Query(..., ge=-90, le=90),
    bkg_region: int = Query(15, ge=1, le=100),
    start_mjd: Optional[float] = None,
    end_mjd: Optional[float] = None,
):
    """Submit a point-source spectrophotometry job to IRSA.

    Returns the UWS job id; the client then polls /api/spectra/status.
    Jobs typically run for a few minutes (IRSA quotes ~1.67 s per
    overlapping image + 50 s), longer near the ecliptic poles.
    """
    try:
        return spx.submit(ra, dec, bkg_region=bkg_region,
                          start_mjd=start_mjd, end_mjd=end_mjd)
    except spx.SpectraError as exc:
        raise HTTPException(502, str(exc)) from exc


@app.get("/api/spectra/status/{job_id}")
def spectra_status(job_id: str):
    try:
        return spx.status(job_id)
    except spx.SpectraError as exc:
        raise HTTPException(502, str(exc)) from exc


@app.get("/api/spectra/table/{job_id}")
def spectra_table(job_id: str):
    """Flattened per-exposure spectrum as JSON (one row per exposure)."""
    try:
        content = spx.fetch_result_votable(job_id)
        table = spx.flatten_votable(content)
    except spx.SpectraError as exc:
        raise HTTPException(502, str(exc)) from exc
    except Exception as exc:
        log.exception("Spectrum table parse failed")
        raise HTTPException(500, f"Could not parse the spectrum table: {exc}") from exc
    table["job_id"] = job_id
    table["count"] = len(table["rows"])
    return table


@app.get("/api/spectra/download/{job_id}")
def spectra_download(
    job_id: str,
    fmt: str = Query("votable", pattern="^(votable|csv|json)$"),
):
    """Download the spectrum: original VOTable, or flattened CSV / JSON."""
    try:
        content = spx.fetch_result_votable(job_id)
    except spx.SpectraError as exc:
        raise HTTPException(502, str(exc)) from exc

    stem = f"spherex_spectrum_{job_id[:8]}"
    if fmt == "votable":
        return Response(
            content,
            media_type="application/x-votable+xml",
            headers={"Content-Disposition": f'attachment; filename="{stem}.xml"'},
        )

    try:
        table = spx.flatten_votable(content)
    except Exception as exc:
        log.exception("Spectrum table parse failed")
        raise HTTPException(500, f"Could not parse the spectrum table: {exc}") from exc

    if fmt == "json":
        import json as _json

        return Response(
            _json.dumps(table, indent=1),
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{stem}.json"'},
        )

    # CSV (matches what the Data Explorer's "save as CSV" produces: one row
    # per exposure).
    import csv
    import io

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(table["columns"])
    for row in table["rows"]:
        writer.writerow([row.get(c, "") for c in table["columns"]])
    return Response(
        buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{stem}.csv"'},
    )


# ---------------------------------------------------------------------------
# Built frontend (one-click launch).  If `frontend/dist` exists (created by
# `npm run build`; shipped with the repo), serve it at the site root so the
# whole app runs from this single server -- users don't need Node at all.
# Mounted last so the /api and /static routes above keep precedence.
_DIST_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "dist")
)
if os.path.isdir(_DIST_DIR):
    app.mount("/", StaticFiles(directory=_DIST_DIR, html=True), name="frontend")
