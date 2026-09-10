# SPHERExView

SPHERExView lets you explore WISE and SPHEREx images of the same patch of
sky. Browse observations by date, blink between epochs, compare the six
SPHEREx detectors, and request a spectrum at a selected position.

The app runs locally in your browser. It retrieves SPHEREx QR2 images and
spectra from NASA/IPAC IRSA, and time-resolved unWISE images through WiseView.

## Run the app

You need **Python 3.10 or newer** and an internet connection. On Windows,
enable **Add Python to PATH** when installing Python.

1. Download this repository using **Code → Download ZIP**, then extract it.
2. Start the launcher:
   - **Windows:** double-click `run.bat`.
   - **macOS / Linux:** open a terminal in the extracted folder and run
     `bash run.sh`.
3. Your browser opens at [localhost:8000](http://localhost:8000).

The launcher creates a Python environment and installs the required packages.
The frontend is included, so Node.js is not needed to run the app. Keep the
terminal open while using it; press **Ctrl+C** to stop the server.

The first query can take several minutes, depending on the field size and
number of exposures. Downloaded files are cached in `backend/cache/` for
reuse. If port 8000 is already in use, set the `PORT` environment variable
before starting the launcher.

## Using SPHERExView

Enter **RA and Dec in decimal degrees**, choose a field of view in arcseconds,
and click **Fetch images**. The default view combines WISE W1+W2 color epochs
with SPHEREx D4+D6 color coadds. Max frames starts at 1000. Individual WISE
and SPHEREx panels can be enabled from the panel controls.

- **Combined timeline:** play or scrub through both missions in date order.
  Choose raw SPHEREx exposures, D6 grayscale coadds, matched D4+D6 color
  coadds, or a custom detector combination.
- **Epoch blink:** inspect SPHEREx coadds grouped by observing visit.
- **SpherexMultiView:** compare D1–D6 at one epoch using grayscale,
  detector-to-reference color, or wavelength color. Expand a tile and use
  Previous/Next to move between detectors.
- **Spectrum:** click an image to pin a position, then request an IRSA
  forced-photometry spectrum. Spectrum jobs can take several minutes.

Zoom, pan, brightness and contrast help inspect the images. The comparison
view can export PNG figures, FITS maps and processing metadata; spectra can
be downloaded as VOTable, CSV or JSON. Viewer settings are stored in the URL
so you can bookmark a field or share the same view.

Color views are inspection aids. Wavelength color shows the wavelengths
sampled by a coadd; it does not measure a source's spectrum. Different
detectors also have different sampling, coverage and point-spread functions.
Use the pixel readouts, coverage maps and spectra when interpreting a feature.

## Development

The backend uses FastAPI and the frontend uses React with Vite. Install the
Python dependencies in a virtual environment, then start the backend from
the repository root:

```bash
python -m pip install -r backend/requirements.txt
python -m uvicorn backend.app.main:app --reload --port 8000
```

In a second terminal, with a current Node.js LTS release installed:

```bash
cd frontend
npm ci
npm run dev
```

Open the URL printed by Vite. To run the frontend checks and refresh the
build used by the launchers, run these from the repository root:

```bash
cd frontend
npm test
npm run build
```

Backend tests use pytest. Run these commands from the repository root:

```bash
python -m pip install pytest httpx
python -m pytest -q backend/tests
```


## Data sources

- SPHEREx QR2 spectral images via [IRSA SIA2](https://irsa.ipac.caltech.edu/docs/program_interface/sia.html)
  (`spherex_qr2`, `spherex_qr2_deep`)
- Cutouts via IRSA's dataset-level cutout service (`?center=&size=` on the image `access_url`)
- WISE images: time-resolved unWISE epoch coadds via
  [WiseView](http://byw.tools/wiseview) (`byw.tools/tiles`, `byw.tools/cutout`,
  2.75″/px) — thanks to Dan Caselden's WiseView.
- Star markers: [Gaia DR3](https://gea.esac.esa.int/archive/) via astroquery TAP
