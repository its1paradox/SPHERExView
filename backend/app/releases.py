"""SPHEREx release contracts (IRSA QR Explanatory Supplement v2.0).

QR2 and QR3 have different gain calibrations. Display them on one timeline,
but never average their pixels together without a validated gain conversion.
See docs/QR3_SUPPORT.md for sources and the deliberately separate science paths.
"""
from __future__ import annotations

import re
from urllib.parse import urlsplit

RELEASES = {
    "qr2": {"wide": "spherex_qr2", "deep": "spherex_qr2_deep",
            "spectral_calibration": "cal-wcs-v4-2025-254", "doi": "10.26131/IRSA652"},
    "qr3": {"wide": "spherex_qr3", "deep": "spherex_qr3_deep",
            "spectral_calibration": "cal-swcs-v5-2026-191", "doi": "10.26131/IRSA662"},
}
RELEASE_POLICY = "Native release calibrations; QR2 and QR3 are never averaged into the same coadd."


def collections(survey="wide", release="all"):
    if survey not in ("wide", "deep"):
        raise ValueError("Survey must be wide or deep")
    if release not in ("all", *RELEASES):
        raise ValueError("Release must be all, qr2 or qr3")
    return [RELEASES[r][survey] for r in RELEASES if release in ("all", r)]


def product_release(url, collection=None):
    """Validate the product location independently of its transport/query string."""
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != "irsa.ipac.caltech.edu" or parsed.port not in (None, 443) or parsed.username:
        raise ValueError("Expected an IRSA HTTPS spectral image URL")
    match = re.match(r"^/ibe/data/spherex/(qr[23])/level2/", parsed.path)
    if not match or not parsed.path.endswith(".fits") or ".." in parsed.path.split("/"):
        raise ValueError("Expected a QR2 or QR3 Level 2 FITS product")
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
    elif (7, 0, 0) <= number < (8, 0, 0):
        release = "qr3"
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
    if release == "qr3" and psf != "EPSF":
        raise ValueError("QR3 product is missing its EPSF binary table")
    return {"data_release": release, "pipeline_version": version,
            "psf_extension": psf, "data_doi": RELEASES[release]["doi"],
            "gain_correction_applied": False}


def spectral_calibration_version(header, release):
    """Use explicit provenance when present; otherwise a validated release pin.

The caller must still verify the detector, orientation and WCS-WAVE against
the selected full-resolution CWAVE/CBAND product. Never use the QR2 pin for QR3.
"""
    history = " ".join(str(card.value) for card in header.cards if card.keyword == "HISTORY")
    versions = set(re.findall(r"cal-(?:wcs|swcs)-v\d+-\d{4}-\d{3}", history))
    if len(versions) > 1:
        raise ValueError("Ambiguous spectral calibration provenance")
    return next(iter(versions)) if versions else RELEASES[release]["spectral_calibration"]
