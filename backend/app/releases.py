"""SPHEREx release contracts (DR1 Explanatory Supplement v2.1).

DR1 and QR3 share the R7 calibration family. Release identity still comes from
archive provenance, not pipeline VERSION. QR2 remains readable for historical
results, but is retired from discovery and cannot be averaged with R7 data.
See docs/DR1_SUPPORT.md for the scientific scope and primary sources.
"""
from __future__ import annotations

import re
from typing import Literal
from urllib.parse import urlsplit

ReleaseSelection = Literal["all", "dr1", "qr3", "qr2"]
RELEASES = {
    "dr1": {"wide": "spherex_dr1", "deep": "spherex_dr1_deep",
            "spectral_calibration": "cal-swcs-v5-2026-191", "doi": "10.26131/IRSA678",
            "calibration_family": "r7"},
    "qr3": {"wide": "spherex_qr3", "deep": "spherex_qr3_deep",
            "spectral_calibration": "cal-swcs-v5-2026-191", "doi": "10.26131/IRSA662",
            "calibration_family": "r7"},
    "qr2": {"wide": "spherex_qr2", "deep": "spherex_qr2_deep",
            "spectral_calibration": "cal-wcs-v4-2025-254", "doi": "10.26131/IRSA652",
            "calibration_family": "qr2"},
}
CURRENT_RELEASES = ("dr1", "qr3")
RELEASE_POLICY = ("DR1 and QR3 share R7 calibrations and may contribute to the same coadd; "
                  "native values and individual release provenance are preserved. "
                  "Legacy QR2 is never averaged with DR1 or QR3.")


class RetiredReleaseError(ValueError):
    """An old bookmark requests a collection no longer searchable at IRSA."""


def calibration_family(release):
    return RELEASES.get(release, {}).get("calibration_family", "unknown")


def release_summary(input_releases):
    """Describe actual contributors without replacing their per-input identity."""
    names = set(input_releases)
    ordered = [r for r in RELEASES if r in names] + sorted(names - RELEASES.keys())
    families = {calibration_family(r) for r in ordered}
    return {"data_release": "+".join(ordered) or "unknown", "data_releases": ordered,
            "calibration_family": next(iter(families)) if len(families) == 1 else "mixed" if families else "unknown",
            "data_dois": {r: RELEASES[r]["doi"] for r in ordered if r in RELEASES}}


def processing_rank(url, release):
    """Prefer current processing over QR2, then the archive's product version.

DR1 and QR3 have equal priority: neither is intrinsically newer processing.
Callers must reject equally ranked, conflicting copies of one exposure.
"""
    # R7 astrometry-retry products use l2b_retry, with the same version syntax.
    version = re.search(r"/l2b(?:_retry)?-v(\d+)-(\d{4})-(\d{3})/", urlsplit(url).path)
    if not version or release not in RELEASES:
        raise ValueError("Archive product lacks a reproducible processing version")
    return (1 if release in CURRENT_RELEASES else 0, *map(int, version.groups()))


def collections(survey="wide", release="all"):
    if survey not in ("wide", "deep"):
        raise ValueError("Survey must be wide or deep")
    if release not in ("all", *RELEASES):
        raise ValueError("Release must be all, dr1, qr3 or qr2")
    if release == "qr2":
        raise RetiredReleaseError("QR2 searches have been retired by IRSA. Choose DR1 + QR3 for current coverage; saved QR2 results remain readable.")
    return [RELEASES[r][survey] for r in CURRENT_RELEASES if release in ("all", r)]


def product_release(url, collection=None):
    """Validate the product location independently of its transport/query string."""
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != "irsa.ipac.caltech.edu" or parsed.port not in (None, 443) or parsed.username:
        raise ValueError("Expected an IRSA HTTPS spectral image URL")
    match = re.match(r"^/ibe/data/spherex/(dr1|qr[23])/level2/", parsed.path)
    if not match or not parsed.path.endswith(".fits") or ".." in parsed.path.split("/"):
        raise ValueError("Expected a DR1, QR3 or legacy QR2 Level 2 FITS product")
    release = match[1]
    if collection and str(collection).startswith("spherex_"):
        if collection not in (RELEASES[release]["wide"], RELEASES[release]["deep"]):
            raise ValueError("Archive collection disagrees with product release")
    return release


def pipeline_version(version):
    match = re.match(r"^(\d+)\.(\d+)(?:\.(\d+))?(?:\+[^\s]+)?$", str(version).strip())
    if not match:
        raise ValueError("Missing or unrecognized FITS pipeline VERSION")
    return tuple(int(v or 0) for v in match.groups())


def fits_provenance(hdul, expected_release=None):
    version = str(hdul[0].header.get("VERSION", "")).strip()
    number = pipeline_version(version)
    if (6, 4, 0) <= number < (7, 0, 0):
        release = "qr2"
    elif (7, 0, 0) <= number < (7, 3, 0):
        # The published DR1 contract covers R7.0–7.2. Both current releases
        # use it; VERSION alone cannot distinguish their survey provenance.
        if expected_release is None:
            raise ValueError("R7 FITS requires archive release provenance (DR1 or QR3)")
        if expected_release not in CURRENT_RELEASES:
            raise ValueError("FITS pipeline VERSION disagrees with archive release")
        release = expected_release
    else:
        raise ValueError(f"Unsupported SPHEREx pipeline version: {version}")
    if expected_release and release != expected_release:
        raise ValueError("FITS pipeline VERSION disagrees with archive release")
    if "EPSF" in hdul:
        psf = "EPSF"
        if hdul[psf].header.get("XTENSION") != "BINTABLE":
            raise ValueError("EPSF must be a FITS binary table")
    else:
        psf = "PSF" if "PSF" in hdul else "unavailable"
    if release in CURRENT_RELEASES and psf != "EPSF":
        raise ValueError(f"{release.upper()} product is missing its EPSF binary table")
    return {"data_release": release, "pipeline_version": version,
            "calibration_family": calibration_family(release),
            "psf_extension": psf, "data_doi": RELEASES[release]["doi"],
            "gain_correction_applied": False}


def spectral_calibration_version(header, release):
    """Use explicit provenance when present; otherwise a validated release pin.

The caller must still verify the detector, orientation and WCS-WAVE against
the selected full-resolution CWAVE/CBAND product. Never use the QR2 pin for R7.
"""
    history = " ".join(str(card.value) for card in header.cards if card.keyword == "HISTORY")
    versions = set(re.findall(r"cal-(?:wcs|swcs)-v\d+-\d{4}-\d{3}", history))
    if len(versions) > 1:
        raise ValueError("Ambiguous spectral calibration provenance")
    return next(iter(versions)) if versions else RELEASES[release]["spectral_calibration"]
