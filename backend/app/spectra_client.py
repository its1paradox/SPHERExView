"""Client for IRSA's SPHEREx Spectrophotometry service.

The Spectrophotometry Tool (https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html)
extracts a forced-photometry spectrum from all SPHEREx spectral images that
cover a position.  It is fronted by two cooperating services:

1. Firefly's command server (``.../applications/spherex/CmdSrv/async``) --
   the only submission path that works for anonymous/guest users.  We POST a
   ``tableSearch`` command with a ``SpectrophotometryProcessor`` request,
   exactly like the SPHEREx Data Explorer GUI does.
2. An IVOA UWS 1.1 endpoint (``.../api/spherex/spectrophotometry/async``) --
   open by job id.  We poll the job document there and download the result
   VOTable from its ``uws:result`` href.

Notes
-----
* Jobs take minutes: IRSA quotes roughly ``1.67 s x N_images + 50 s``.
* The result VOTable has ONE ROW PER SOURCE with the per-exposure
  measurements packed into array-valued cells; :func:`flatten_votable`
  explodes it to one row per exposure (what the GUI's "save as CSV" gives).
* IRSA writes a few non-spec ``arraysize="Nx*"`` char fields; they are
  rewritten to ``arraysize="*"`` and re-split at width N.
"""

from __future__ import annotations

import json
import re
import secrets
import threading
import warnings
import xml.etree.ElementTree as ET
from io import BytesIO
from typing import Optional

import numpy as np
import requests

APP_BASE = "https://irsa.ipac.caltech.edu/applications/spherex"
CMDSRV_ASYNC = APP_BASE + "/CmdSrv/async"
UWS_ASYNC = "https://irsa.ipac.caltech.edu/api/spherex/spectrophotometry/async"

UWS_NS = {"uws": "http://www.ivoa.net/xml/UWS/v1.0"}
XLINK = "{http://www.w3.org/1999/xlink}href"

_UA = {"User-Agent": "SPHERExView/1.0 (open-source viewer; github.com/its1paradox)"}

# One shared session: the guest CmdSrv path just needs the app's cookies
# primed once.  Thread-safe enough for our use (requests.Session is fine for
# concurrent reads; submissions are quick).
_session: Optional[requests.Session] = None
_session_lock = threading.Lock()


class SpectraError(Exception):
    """Submission or retrieval failed in a way worth reporting to the user."""


def _get_session() -> requests.Session:
    global _session
    with _session_lock:
        if _session is None:
            s = requests.Session()
            s.headers.update(_UA)
            try:
                s.get(APP_BASE + "/", timeout=30)
            except requests.RequestException:
                pass  # cookies are a nicety; submission may still work
            _session = s
        return _session


def submit(ra: float, dec: float, bkg_region: int = 15,
           start_mjd: Optional[float] = None,
           end_mjd: Optional[float] = None) -> dict:
    """Submit a point-source spectrophotometry job.  Returns job info."""
    tbl_id = "Spec-photo-tbl-" + secrets.token_hex(4)
    req = {
        "id": "SpectrophotometryProcessor",
        # The backend validates this as an INTEGER in pixels.
        "bgEstimationRegion": str(int(round(bkg_region))),
        "exposureTimeMode": "mjd",
        "startIdx": 0,
        "pageSize": 2147483647,
        "tbl_id": tbl_id,
        "META_INFO": {"title": "Spectrophotometry Targets", "tbl_id": tbl_id},
        "CONE_AREA_KEY_RESERVED": "CONE",
        "UserTargetWorldPt": f"{ra};{dec};EQ_J2000",
        "shapeFit": "false",
    }
    if start_mjd is not None and end_mjd is not None:
        lo, hi = sorted((float(start_mjd), float(end_mjd)))
        req["startTime"] = f"{lo:.7f}".rstrip("0").rstrip(".")
        req["endTime"] = f"{hi:.7f}".rstrip("0").rstrip(".")

    s = _get_session()
    try:
        resp = s.post(
            CMDSRV_ASYNC,
            data={"cmd": "tableSearch", "request": json.dumps(req)},
            timeout=60,
        )
        resp.raise_for_status()
        info = resp.json()
    except (requests.RequestException, ValueError) as exc:
        raise SpectraError(f"Could not reach the IRSA spectrophotometry service: {exc}") from exc

    job_id = info.get("jobId")
    if not job_id:
        raise SpectraError(f"IRSA did not accept the job: {str(info)[:300]}")
    return {
        "job_id": job_id,
        "phase": info.get("phase", "PENDING"),
        "uws_url": f"{UWS_ASYNC}/{job_id}",
    }


_JOB_ID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")


def _job_url(job_id: str) -> str:
    if not _JOB_ID_RE.match(job_id):
        raise SpectraError("Invalid job id")
    return f"{UWS_ASYNC}/{job_id}"


def status(job_id: str) -> dict:
    """Poll the UWS job document.  Returns phase, timing and error info."""
    s = _get_session()
    try:
        resp = s.get(_job_url(job_id), timeout=30)
        resp.raise_for_status()
        root = ET.fromstring(resp.text)
    except requests.RequestException as exc:
        raise SpectraError(f"Could not poll the IRSA job: {exc}") from exc
    except ET.ParseError as exc:
        raise SpectraError(f"IRSA returned an unreadable job document: {exc}") from exc

    phase = (root.findtext("uws:phase", namespaces=UWS_NS) or "UNKNOWN").upper()
    out = {
        "job_id": job_id,
        "phase": phase,
        "creation_time": root.findtext("uws:creationTime", namespaces=UWS_NS),
        "start_time": root.findtext("uws:startTime", namespaces=UWS_NS),
        "end_time": root.findtext("uws:endTime", namespaces=UWS_NS),
        "results": [
            {"id": res.get("id"), "href": res.get(XLINK)}
            for res in root.findall("uws:results/uws:result", UWS_NS)
        ],
        "error_message": None,
    }
    summary = root.find("uws:errorSummary", UWS_NS)
    if summary is not None:
        msg = " ".join((summary.findtext("uws:message", namespaces=UWS_NS) or "").split())
        out["error_message"] = msg[:1000] or "The service reported an error without details."
    return out


# job_id -> raw VOTable bytes; results are immutable once COMPLETED.
_result_cache: dict[str, bytes] = {}
_cache_lock = threading.Lock()


def fetch_result_votable(job_id: str) -> bytes:
    """Download (and cache) the job's result VOTable."""
    with _cache_lock:
        cached = _result_cache.get(job_id)
    if cached is not None:
        return cached

    st = status(job_id)
    if st["phase"] != "COMPLETED":
        detail = st.get("error_message")
        raise SpectraError(
            f"Job is in phase {st['phase']}, not COMPLETED"
            + (f": {detail}" if detail else "")
        )
    if not st["results"]:
        raise SpectraError("Job completed but IRSA exposed no result file.")

    s = _get_session()
    try:
        resp = s.get(st["results"][0]["href"], timeout=180)
        resp.raise_for_status()
    except requests.RequestException as exc:
        raise SpectraError(f"Could not download the result table: {exc}") from exc

    content = resp.content
    with _cache_lock:
        if len(_result_cache) > 32:  # crude bound; results are ~100s of kB
            _result_cache.clear()
        _result_cache[job_id] = content
    return content


def flatten_votable(content: bytes) -> dict:
    """Parse the result VOTable into a flat per-exposure table.

    Returns ``{"columns": [...], "units": {...}, "rows": [ {col: val}, ... ]}``
    with one row per exposure, sorted by wavelength.
    """
    from astropy.io.votable import parse_single_table

    text = content.decode("utf-8", "replace")
    packed: dict[str, int] = {}

    def _fix(match: re.Match) -> str:
        tag = match.group(0)
        name = re.search(r'name="([^"]*)"', tag)
        width = re.search(r'arraysize="(\d+)x\*?"', tag)
        if name and width:
            packed[name.group(1)] = int(width.group(1))
        return re.sub(r'arraysize="\d+x\*?"', 'arraysize="*"', tag)

    text = re.sub(r"<FIELD\b[^>]*>", _fix, text)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        vot = parse_single_table(BytesIO(text.encode("utf-8")), verify="warn")
    table = vot.to_table()

    units = {}
    for field in vot.fields:
        if field.unit is not None:
            units[field.name] = str(field.unit)

    def _clean(value):
        if isinstance(value, bytes):
            value = value.decode("utf-8", "replace")
        if isinstance(value, str):
            return value.strip()
        if isinstance(value, (np.floating, float)):
            f = float(value)
            return f if np.isfinite(f) else None
        if isinstance(value, (np.integer, int)):
            return int(value)
        if isinstance(value, np.bool_):
            return bool(value)
        if value is np.ma.masked:
            return None
        return value

    rows: list[dict] = []
    for i in range(len(table)):
        cols: dict[str, object] = {}
        n = 1
        for c in table.colnames:
            cell = table[c][i]
            if c in packed:  # fixed-width packed char column
                s_val = cell.decode() if isinstance(cell, bytes) else str(cell)
                w = packed[c]
                cols[c] = [s_val[j:j + w].strip() for j in range(0, len(s_val), w)]
                n = max(n, len(cols[c]))
            elif np.ndim(cell) > 0:  # per-exposure array -> explode
                cols[c] = [_clean(x) for x in np.asarray(cell)]
                n = max(n, len(cols[c]))
            else:  # source-level scalar -> broadcast
                cols[c] = _clean(cell)
        for j in range(n):
            rows.append({
                c: (v[j] if isinstance(v, list) and j < len(v)
                    else (None if isinstance(v, list) else v))
                for c, v in cols.items()
            })

    # Sort by wavelength when present (makes the plot/table read naturally).
    wl_col = next((c for c in ("wavelength", "lambda", "wave") if rows and c in rows[0]), None)
    if wl_col:
        rows.sort(key=lambda r: (r.get(wl_col) is None, r.get(wl_col) or 0.0))

    return {
        "columns": list(table.colnames),
        "units": units,
        "rows": rows,
        "count": len(rows),
    }
