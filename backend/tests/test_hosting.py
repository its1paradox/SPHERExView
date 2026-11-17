"""Public-pilot admission contracts; no external archive calls."""
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.app import hosting, comparison_api as api, detector_comparison as dc
from backend.app.main import app


@pytest.fixture
def pilot(monkeypatch, tmp_path):
    monkeypatch.setenv("SPHEREX_PUBLIC_LIMITS", "1")
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(api.sx, "CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(hosting.shutil, "disk_usage", lambda path: SimpleNamespace(free=10 * 1024 ** 3))
    return TestClient(app)


def test_busy_work_keeps_health_and_existing_job_status_available(pilot):
    lease = hosting.acquire()
    try:
        assert pilot.get("/api/health").status_code == 200
        assert pilot.get("/api/detector-comparison/not-a-job").status_code == 404
        response = pilot.get("/api/cutouts?ra=1&dec=2")
        assert response.status_code == 429
        assert response.headers["retry-after"] == "15"
        assert pilot.post("/api/detector-comparison", json={"ra": 1, "dec": 2}).status_code == 429
    finally:
        lease.release()


def test_limits_reject_instead_of_changing_science_parameters(pilot):
    hosting.validate_query({"limit": "1000000"})
    assert pilot.get("/api/coadd?ra=1&dec=2&radius_arcsec=251").status_code == 422
    assert pilot.post("/api/detector-comparison", json={"ra": 1, "dec": 2, "size_arcsec": 501}).status_code == 422
    hosting.validate_comparison(dc.Recipe(ra=1, dec=2))


def test_500_arcsec_admission_preserves_width_resolution_and_all_inputs(pilot):
    recipe = dc.Recipe(ra=1, dec=2, size_arcsec=500)
    hosting.validate_comparison(recipe)
    hosting.validate_query({"radius_arcsec": "250", "size_arcsec": "500"})
    assert recipe.size_arcsec == 500
    assert recipe.pixscale_arcsec == 6.2
    assert recipe.max_per_tile == 0 and recipe.include_spectra
    with pytest.raises(HTTPException) as error:
        hosting.validate_comparison(recipe.model_copy(update={"pixscale_arcsec": 3.1}))
    assert error.value.status_code == 422


def test_low_disk_refuses_new_work_and_releases_capacity(pilot, monkeypatch):
    monkeypatch.setattr(hosting.shutil, "disk_usage", lambda path: SimpleNamespace(free=1))
    assert pilot.get("/api/cutouts?ra=1&dec=2").status_code == 507
    assert pilot.get("/api/health").status_code == 200
    monkeypatch.setattr(hosting.shutil, "disk_usage", lambda path: SimpleNamespace(free=10 * 1024 ** 3))
    hosting.acquire().release()


@pytest.mark.parametrize("fails", [False, True])
def test_background_comparison_holds_slot_until_finished(pilot, monkeypatch, fails):
    started, finish = threading.Event(), threading.Event()
    def build(recipe, path, progress, cancel):
        started.set()
        assert finish.wait(5)
        if fails:
            raise RuntimeError("synthetic failure")
        path.mkdir(parents=True)
        return {"epochs": [], "synthetic": True}
    monkeypatch.setattr(dc, "build", build)
    response = pilot.post("/api/detector-comparison", json={"ra": 1, "dec": 2})
    assert response.status_code == 202
    job = response.json()["job_id"]
    try:
        assert started.wait(5)
        assert pilot.get("/api/epoch-stack?ra=1&dec=2").status_code == 429
        assert pilot.delete(f"/api/detector-comparison/{job}").status_code == 200
    finally:
        finish.set()
    for _ in range(200):
        try:
            lease = hosting.acquire()
        except HTTPException as exc:
            assert exc.status_code == 429
            time.sleep(.01)
        else:
            lease.release()
            break
    else:
        pytest.fail("Background comparison leaked its admission slot")
    assert pilot.get(f"/api/detector-comparison/{job}").json()["status"] == ("error" if fails else "complete")


def test_science_validation_failure_releases_sync_request_slot(pilot):
    assert pilot.get("/api/cutouts?ra=1&dec=2&release=qr2").status_code == 410
    hosting.acquire().release()


def test_executor_rejection_does_not_leave_a_phantom_job(pilot, monkeypatch):
    before=set(api._jobs)
    def reject(*args):
        raise RuntimeError("executor unavailable")
    monkeypatch.setattr(api._pool, "submit", reject)
    with pytest.raises(RuntimeError, match="executor unavailable"):
        pilot.post("/api/detector-comparison", json={"ra": 1, "dec": 2})
    assert set(api._jobs) == before
    hosting.acquire().release()
