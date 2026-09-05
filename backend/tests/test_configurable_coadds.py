"""Regression tests for configurable combined-timeline coadds."""

import unittest

import numpy as np
from astropy.wcs import WCS
from fastapi.testclient import TestClient

from backend.app.coadd import _masked_bilinear_reproject, output_grid
from backend.app.main import _validate_coadd_workload, app


class ConfigurableCoaddTests(unittest.TestCase):
    def test_output_grid_respects_requested_sampling(self):
        native_size, _ = output_grid(10.0, -5.0, 124.0, 6.2)
        fine_size, _ = output_grid(10.0, -5.0, 124.0, 3.1)

        self.assertEqual(native_size, 20)
        self.assertEqual(fine_size, 40)

    def test_custom_channels_must_be_disjoint(self):
        client = TestClient(app)
        response = client.get(
            "/api/epoch-coadds",
            params={
                "ra": 10.0,
                "dec": -5.0,
                "short_detectors": "1,2,4",
                "long_detectors": "4,5,6",
            },
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["detail"],
            "detectors cannot appear in both color channels: D4",
        )

    def test_focused_band_cannot_be_combined_with_custom_channels(self):
        client = TestClient(app)
        response = client.get(
            "/api/epoch-coadds",
            params={
                "ra": 10.0,
                "dec": -5.0,
                "band": "SPHEREx-D6",
                "short_detectors": "1,2,3,4",
                "long_detectors": "5,6",
            },
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["detail"],
            "band cannot be combined with custom detector channels",
        )

    def test_bilinear_resampling_excludes_invalid_pixels_and_propagates_variance(self):
        wcs_in = WCS(naxis=2)
        wcs_in.wcs.crpix = [2.0, 2.0]
        wcs_in.wcs.cdelt = [-1.0, 1.0]
        wcs_in.wcs.crval = [0.0, 0.0]
        wcs_in.wcs.ctype = ["RA---CAR", "DEC--CAR"]
        wcs_out = wcs_in.deepcopy()
        wcs_out.wcs.crpix = [2.5, 2.5]
        sci = np.ones((3, 3), dtype=float)
        sci[1, 1] = 1e9
        var = np.full((3, 3), 4.0)
        valid = np.ones((3, 3), dtype=bool)
        valid[1, 1] = False

        sci_out, var_out, covered = _masked_bilinear_reproject(
            sci, var, valid, wcs_in, wcs_out, (3, 3)
        )

        self.assertTrue(covered[1, 1])
        self.assertAlmostEqual(sci_out[1, 1], 1.0)
        self.assertAlmostEqual(var_out[1, 1], 4.0 / 3.0, places=6)

    def test_oversized_workload_is_rejected(self):
        with self.assertRaisesRegex(Exception, "too large"):
            _validate_coadd_workload(4800, 500)


if __name__ == "__main__":
    unittest.main()
