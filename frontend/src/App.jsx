import { useEffect, useMemo, useRef, useState } from 'react';
import ControlPanel from './components/ControlPanel.jsx';
import FrameViewer from './components/FrameViewer.jsx';
import CombinedViewer from './components/CombinedViewer.jsx';
import { decodeB64Float32, sortPixels } from './lib/render.js';
import { DEFAULT_DISPLAY, buildHash, parseHash } from './lib/urlstate.js';

export { DEFAULT_DISPLAY };

function toFrame(base) {
  const data = decodeB64Float32(base.data_b64);
  const frame = { ...base, data, sorted: sortPixels(data) };
  if (base.data2_b64) {
    // W1+W2 color composite: second band travels as data2.  AstroToolBox
    // computes the shared contrast limits from the W2 array (getRefValues
    // prefers fits2), so keep its sorted pixels too.
    frame.data2 = decodeB64Float32(base.data2_b64);
    frame.sorted2 = sortPixels(frame.data2);
  }
  return frame;
}

// D6-focused epoch coadd (from /api/epoch-coadds?band=SPHEREx-D6) as a frame
// the combined WISE→SPHEREx timeline can play after the unWISE epochs.  D6
// (4.42–5.00 µm) covers the WISE W2 (4.6 µm) bandpass, and the backend now
// pairs it with a D4 reference channel (2.42–3.82 µm, which contains W1's
// 3.4 µm bandpass) — the detector-level W2/W1 analogue — so these frames
// keep the exact WiseView color contrast of the W1+W2 epochs before them:
// D4 feeds blue (data), D6 feeds orange (data2), and a cold source visible
// only in D6 stays orange across the mission handoff.  Rendering uses the
// hue-preserving Lupton composite (per-channel sky sigmas restore the
// calibrated flux ratio; chroma is gated by joint S/N).  If the reference
// channel is missing at an epoch, the frame is an explicitly labeled
// GRAYSCALE slice \u2014 a lone band carries no color information.
function toCombinedCoaddFrame(c) {
  const md = c.metadata;
  const isColor = Boolean(c.data2_b64 && md.channels === 'color');
  const long = decodeB64Float32(c.data2_b64 || c.data_b64);
  const nLong = md.long_channel ? md.long_channel.n_exposures : md.n_exposures;
  if (!isColor) {
    return {
      ...c,
      data: long,
      data2: null,
      sorted: sortPixels(long),
      label: `D6 CO-ADD \u00b7 ${nLong} exp \u00b7 grayscale`,
      sublabel: `${md.datetime_min_utc.slice(0, 10)} \u2192 ${md.datetime_max_utc.slice(0, 10)}`,
      metadata: { ...md, mjd_mid: (md.mjd_min + md.mjd_max) / 2, target_covered: true },
    };
  }
  const short = decodeB64Float32(c.data_b64);
  const both = new Float32Array(short.length + long.length);
  both.set(short, 0);
  both.set(long, short.length);
  return {
    ...c,
    data: short,
    data2: long,
    sigmaS: md.short_channel?.sky_sigma_mjy_sr || null,
    sigmaL: md.long_channel?.sky_sigma_mjy_sr || null,
    sorted: sortPixels(both),
    label:
      `D6 CO-ADD \u00b7 ${nLong} exp` +
      (md.short_channel ? ` (+${md.short_channel.n_exposures} D4 ref)` : ''),
    sublabel: `${md.datetime_min_utc.slice(0, 10)} \u2192 ${md.datetime_max_utc.slice(0, 10)}`,
    metadata: { ...md, mjd_mid: (md.mjd_min + md.mjd_max) / 2, target_covered: true },
  };
}

// Attach one shared Lupton color scale to a set of two-channel frames: the
// pooled positive calibrated-intensity distribution (posSorted) + median
// sky sigma_I.  The renderer derives white/black points from it LIVE using
// the current display percentiles, so the controls respond instantly while
// all frames still share one scale (hue and brightness stay comparable
// through the whole sequence).
function attachLuptonScale(frames, { sat = 1.25 } = {}) {
  const cf = frames.filter((f) => f.data2 && f.sigmaS && f.sigmaL);
  if (!cf.length) return frames;
  const sigIs = cf.map((f) => 0.5 * Math.hypot(f.sigmaS, f.sigmaL)).sort((a, b) => a - b);
  const sigI = sigIs[sigIs.length >> 1];
  const pos = [];
  for (const f of cf) {
    for (let i = 0; i < f.data.length; i += 1) {
      const I = 0.5 * (Math.max(0, f.data[i]) * f.sigmaS + Math.max(0, f.data2[i]) * f.sigmaL);
      if (I > 0) pos.push(I);
    }
  }
  if (!pos.length) return frames;
  const posSorted = Float64Array.from(pos).sort();
  return frames.map((f) =>
    f.data2 && f.sigmaS && f.sigmaL
      ? {
          ...f,
          colorScale: { sigmaS: f.sigmaS, sigmaL: f.sigmaL, posSorted, sigI, sat, mode: 'color' },
        }
      : f,
  );
}

// WiseView-style two-channel colour frame from the per-detector coadds:
// short-wavelength detectors (D1–D4, 0.75–3.82 µm) feed the blue channel,
// long-wavelength ones (D5–D6, 3.82–5.0 µm) the orange channel — the same
// blue/orange convention as WiseView's W1+W2 composite, where a W2-only
// detection glows orange.  Each channel is the pixelwise mean of its
// detector coadds, then robustly z-scored (median / 1.4826·MAD) so the two
// channels share one display scale in sky-noise units: a source visible
// ONLY beyond ~3.8 µm (an extremely cold/red object such as the Y dwarf
// WISE 0855−0714) shows up as an orange dot among white/blue stars.
function coaddColorFrame(coadds) {
  const shortF = coadds.filter((f) => f.metadata.detector <= 4);
  const longF = coadds.filter((f) => f.metadata.detector >= 5);
  if (!shortF.length || !longF.length) return null;
  const n = coadds[0].data.length;
  const mean = (grp) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      let s = 0;
      for (const f of grp) s += f.data[i];
      out[i] = s / grp.length;
    }
    return out;
  };
  const zscore = (arr) => {
    const med = Float32Array.from(arr).sort()[n >> 1];
    const sig = 1.4826 * Float32Array.from(arr, (v) => Math.abs(v - med)).sort()[n >> 1] || 1;
    return { z: Float32Array.from(arr, (v) => (v - med) / sig), sig };
  };
  const { z: blue, sig: sigS } = zscore(mean(shortF));
  const { z: orange, sig: sigL } = zscore(mean(longF));
  const lamSpan = (grp) => {
    const lams = grp.map((f) => f.metadata.lambda_target_um).filter(Boolean);
    if (!lams.length) return '';
    const lo = Math.min(...lams.map((l) => l.min_um));
    const hi = Math.max(...lams.map((l) => l.max_um));
    return `${lo.toFixed(2)}\u2013${hi.toFixed(2)} \u00b5m`;
  };
  const dets = (grp) => grp.map((f) => `D${f.metadata.detector}`).join('+');
  const nExp = (grp) => grp.reduce((s, f) => s + (f.metadata.n_exposures_used || 0), 0);
  const merged = new Float32Array(2 * n);
  merged.set(blue, 0);
  merged.set(orange, n);
  // Frozen Lupton scale for this composite (hue-preserving, chroma gated).
  const pos = [];
  for (let i = 0; i < n; i += 1) {
    const I = 0.5 * (Math.max(0, blue[i]) * sigS + Math.max(0, orange[i]) * sigL);
    if (I > 0) pos.push(I);
  }
  const sigI = 0.5 * Math.hypot(sigS, sigL);
  const posSorted = Float64Array.from(pos).sort();
  return {
    id: 'coadd-color',
    width: coadds[0].width,
    height: coadds[0].height,
    wcs: coadds[0].wcs,
    data: blue,
    data2: orange,
    colorScale: { sigmaS: sigS, sigmaL: sigL, posSorted, sigI, sat: 1.15, mode: 'color' },
    sorted: merged.sort(),
    label: 'COLOR CO-ADD',
    sublabel: `blue ${dets(shortF)} (${lamSpan(shortF)}) \u00b7 orange ${dets(longF)} (${lamSpan(longF)})`,
    metadata: {
      composite: 'blue = short-\u03bb detector coadds, orange = long-\u03bb (WiseView W1+W2 convention)',
      blue_channel: `${dets(shortF)} \u00b7 ${lamSpan(shortF)} \u00b7 ${nExp(shortF)} exposures`,
      orange_channel: `${dets(longF)} \u00b7 ${lamSpan(longF)} \u00b7 ${nExp(longF)} exposures`,
      method:
        'per-channel mean of detector coadds \u00b7 hue-preserving Lupton asinh composite (one stretch on the calibrated intensity, chroma gated by joint S/N 2\u21925\u03c3)',
      note: 'orange-only sources emit only beyond ~3.8 \u00b5m \u2014 extremely cold or dust-reddened objects (e.g. late-T/Y dwarfs like WISE 0855\u22120714)',
      pixscale_arcsec: coadds[0].metadata.pixscale_arcsec,
    },
  };
}

// Opens the spectrum viewer in a new tab for a sky position.
export function openSpectrumTab(ra, dec) {
  const params = `ra=${ra.toFixed(6)}&dec=${dec.toFixed(6)}`;
  window.open(`spectrum.html#${params}`, '_blank', 'noopener');
}

// Opens the time-resolved COLOR epoch blink (unWISE-style epoch coadds) in
// a new tab for the current target/field.
export function openBlinkTab(ra, dec, fov, survey, limit) {
  const params = new URLSearchParams({
    ra: ra.toFixed(6),
    dec: dec.toFixed(6),
    size: fov,
    survey,
    months: 6,
    maxframes: limit,
  });
  window.open(`blink.html#${params}`, '_blank', 'noopener');
}

export default function App() {
  // Query form + display settings restore from the URL hash (WiseView-style
  // shareable links), and every later change is written back to it.
  const initial = useMemo(() => parseHash(window.location.hash), []);
  const [spherexFrames, setSpherexFrames] = useState([]);
  const [wiseFrames, setWiseFrames] = useState([]);
  const [coaddFrames, setCoaddFrames] = useState([]);
  const [coaddStatus, setCoaddStatus] = useState(null);
  const coaddKey = useRef(null); // query already coadded (avoid refetch)
  // D6-only epoch coadds for the combined timeline (lazy, cached per field).
  const [combinedCoadds, setCombinedCoadds] = useState([]);
  const [combinedCoaddStatus, setCombinedCoaddStatus] = useState(null);
  const combinedCoaddKey = useRef(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState(initial.form);
  const [view, setView] = useState(initial.view);
  // Sky position under the cursor on either panel -> crosshair on the other.
  const [hoverSky, setHoverSky] = useState(null);
  // ONE sky-anchored pin shared by every panel: drop it on any tile and it
  // marks the same RA/Dec on all of them (each frame's own WCS).
  const [pin, setPin] = useState(null);
  // Target + field of the last search, for the combined WISE->SPHEREx timeline.
  const [queried, setQueried] = useState(null);

  // Keep the address bar in sync so the current view is always shareable.
  useEffect(() => {
    window.history.replaceState(null, '', buildHash(form, view));
  }, [form, view]);

  // Latest view settings for async callbacks (search closes over stale view).
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // Turning the CO-ADD panel on after a search lazily fetches the stacks.
  useEffect(() => {
    if (view.showCoadd && queried && !loading) fetchCoadd(queried);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.showCoadd, queried, loading]);

  // Selecting "D6 epoch coadds" for the combined timeline lazily builds them
  // (visit-grouped epochs, one per sky pass, D6 + D4 reference color — the
  // exact frames the blink page makes for band=SPHEREx-D6).  Cached per
  // field so flipping the select is free.
  useEffect(() => {
    if (!queried || loading || !view.showCombined || view.combinedMode !== 'd6') return;
    const key = `${queried.ra},${queried.dec},${queried.fov},${queried.survey}`;
    if (combinedCoaddKey.current === key) return;
    combinedCoaddKey.current = key;
    setCombinedCoadds([]);
    setCombinedCoaddStatus(
      'Stacking D6 epoch coadds for the combined timeline\u2026 one D6 + D4-reference coadd per sky-pass visit.',
    );
    const params = new URLSearchParams({
      ra: queried.ra,
      dec: queried.dec,
      radius_arcsec: queried.fov / 2,
      survey: queried.survey,
      bin_months: 6,
      band: 'SPHEREx-D6',
      limit: 500,
    });
    fetch(`/api/epoch-coadds?${params}`)
      .then((r) =>
        r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.detail || r.statusText))),
      )
      .then((d) => {
        setCombinedCoadds(attachLuptonScale(d.frames.map(toCombinedCoaddFrame), { sat: 1.25 }));
        setCombinedCoaddStatus(
          d.count
            ? null
            : 'No D6 epoch coadds available for this field \u2014 showing nothing after WISE.',
        );
      })
      .catch((err) => {
        combinedCoaddKey.current = null;
        setCombinedCoaddStatus(`D6 epoch coadds failed: ${err.message}`);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queried, loading, view.showCombined, view.combinedMode]);

  // Per-detector CO-ADD stacks (mixed-lambda deep images).  Fetched AFTER
  // the epoch stack so the exposure cutouts are already in the backend's
  // disk cache (the coadd reuses the exact same cutout URLs).
  const fetchCoadd = async (q) => {
    const key = JSON.stringify(q);
    if (coaddKey.current === key) return;
    coaddKey.current = key;
    setCoaddFrames([]);
    setCoaddStatus('Building detector CO-ADDs\u2026 stacking every exposure per detector.');
    const params = new URLSearchParams({
      ra: q.ra,
      dec: q.dec,
      radius_arcsec: q.fov / 2,
      survey: q.survey,
      limit: q.limit,
    });
    if (q.band) params.set('band', q.band);
    try {
      const d = await fetch(`/api/coadd?${params}`).then((r) =>
        r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.detail || r.statusText))),
      );
      const mapped =
        d.coadds.map((c) => {
          const m = c.metadata;
          const lam = m.lambda_target_um;
          const range = lam ? ` \u00b7 \u03bb ${lam.min_um.toFixed(2)}\u2013${lam.max_um.toFixed(2)} \u00b5m` : '';
          const dates = m.datetime_min_utc
            ? ` \u00b7 ${m.datetime_min_utc.slice(0, 10)} \u2192 ${m.datetime_max_utc.slice(0, 10)}`
            : '';
          return toFrame({
            ...c,
            label: `${m.band} CO-ADD (mixed \u03bb)`,
            sublabel: `${m.n_exposures_used} exp${range}${dates}`,
          });
        });
      const color = coaddColorFrame(mapped);
      if (color) mapped.push(color);
      setCoaddFrames(mapped);
      setCoaddStatus(
        `CO-ADD: ${d.count} detectors from ${d.n_exposures_input - d.n_exposures_skipped} exposures` +
          ` (zodi-subtracted, sky-noise weighted${d.n_exposures_skipped ? `; ${d.n_exposures_skipped} skipped` : ''})`,
      );
    } catch (err) {
      coaddKey.current = null;
      setCoaddStatus(`CO-ADD failed: ${err.message}`);
    }
  };

  const search = async ({ ra, dec, fov, survey, band, limit, wiseBand }) => {
    setLoading(true);
    setError(null);
    setStatus('Querying SPHEREx + WiseView\u2026 first fetch of a field can take a minute.');
    setSpherexFrames([]);
    setWiseFrames([]);
    setCoaddFrames([]);
    setCoaddStatus(null);
    setCombinedCoadds([]);
    setCombinedCoaddStatus(null);
    combinedCoaddKey.current = null;
    setPin(null); // shared pin belongs to the previous field
    coaddKey.current = null;
    setQueried({
      ra: parseFloat(ra),
      dec: parseFloat(dec),
      fov: parseFloat(fov),
      survey,
      band: band || '',
      limit,
    });

    const sxParams = new URLSearchParams({
      ra,
      dec,
      radius_arcsec: fov / 2,
      survey,
      limit,
    });
    if (band) sxParams.set('band', band);
    const wiseParams = new URLSearchParams({
      ra,
      dec,
      size_arcsec: fov,
      band: wiseBand,
      gaia: 'true',
    });

    try {
      const [sxRes, wiseRes] = await Promise.allSettled([
        fetch(`/api/epoch-stack?${sxParams}`).then((r) =>
          r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.detail || r.statusText))),
        ),
        fetch(`/api/wise-stack?${wiseParams}`).then((r) =>
          r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.detail || r.statusText))),
        ),
      ]);

      const messages = [];
      if (sxRes.status === 'fulfilled') {
        const d = sxRes.value;
        setSpherexFrames(
          d.cutouts.map((c) =>
            toFrame({
              ...c,
              label: c.metadata.band || 'SPHEREx',
              sublabel: c.metadata.datetime_utc
                ? `${c.metadata.datetime_utc.slice(0, 10)} ${c.metadata.datetime_utc.slice(11, 16)} UT`
                : '',
            }),
          ),
        );
        messages.push(
          `SPHEREx: ${d.count} frames` +
            (d.skipped_no_overlap ? ` (${d.skipped_no_overlap} skipped, no overlap)` : ''),
        );
      } else {
        messages.push(`SPHEREx failed: ${sxRes.reason.message}`);
      }

      if (wiseRes.status === 'fulfilled') {
        const d = wiseRes.value;
        setWiseFrames(
          d.frames.map((f) =>
            toFrame({
              ...f,
              markers: f.gaia_markers,
              label: `${f.band} epoch ${f.epoch}`,
              sublabel: f.datetime_utc ? f.datetime_utc.slice(0, 10) : '',
            }),
          ),
        );
        messages.push(`WISE: ${d.count} epochs (${d.frames[0]?.datetime_utc?.slice(0, 4)}\u2013${d.frames.at(-1)?.datetime_utc?.slice(0, 4)})`);
      } else {
        messages.push(`WISE failed: ${wiseRes.reason.message}`);
      }

      setStatus(messages.join(' \u00b7 '));
      if (sxRes.status === 'rejected' && wiseRes.status === 'rejected') {
        setError('Both queries failed.');
      } else if (viewRef.current.showCoadd) {
        // Cutouts are now cached server-side; the coadd re-reads them.
        fetchCoadd({ ra: parseFloat(ra), dec: parseFloat(dec), fov: parseFloat(fov), survey, band: band || '', limit });
      }
    } catch (err) {
      setError(err.message);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  };

  // A URL that names a target (#ra=..&dec=..) fetches it on load.
  const autoFetched = useRef(false);
  useEffect(() => {
    if (autoFetched.current || !initial.hasTarget) return;
    autoFetched.current = true;
    const [ra, dec] = initial.form.coords.split(/\s+/).map(parseFloat);
    search({
      ra,
      dec,
      fov: parseFloat(initial.form.fov),
      survey: initial.form.survey,
      band: initial.form.bands.join(','),
      limit: parseInt(initial.form.limit, 10),
      wiseBand: initial.form.wiseBand,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app">
      <header>
        <h1>SPHERExView</h1>
        <p className="subtitle">
          Blink SPHEREx spectral cutouts next to time-resolved WISE epochs (via WiseView) with
          Gaia DR3 overlays
        </p>
      </header>
      <div className="layout">
        <ControlPanel
          onSearch={search}
          loading={loading}
          view={view}
          setView={setView}
          form={form}
          setForm={setForm}
        />
        <main className="viewers">
          {status && <p className="status">{status}</p>}
          {error && <p className="status error">{error}</p>}
          <div className="viewer-row">
            {spherexFrames.length > 0 && (
              <FrameViewer
                title="SPHEREx"
                frames={spherexFrames}
                render={{
                  mode: view.sxScaleMode,
                  blackPct: view.sxBlackPct,
                  whitePct: view.sxWhitePct,
                  stretch: view.sxStretch,
                  invert: view.sxInvert,
                  smooth: view.sxSmooth,
                }}
                displaySize={view.displaySize}
                speedMs={view.speedMs}
                showMarkers={false}
                hoverSky={hoverSky}
                onHoverSky={setHoverSky}
                showInfo
                allowPin
                pin={pin}
                onPin={setPin}
                onSpectrum={openSpectrumTab}
                outerOnly={view.sxOuter}
                outerControls
              />
            )}
            {view.showWise && wiseFrames.length > 0 && (
              <FrameViewer
                title="WISE (WiseView epochs)"
                frames={wiseFrames}
                render={{
                  mode: 'atb',
                  brightness: view.wiseBrightness,
                  contrast: view.wiseContrast,
                  stretch: view.wiseStretch,
                  invert: view.wiseInvert,
                  smooth: view.wiseSmooth,
                }}
                displaySize={view.displaySize}
                speedMs={view.speedMs}
                showMarkers={view.showMarkers}
                hoverSky={hoverSky}
                onHoverSky={setHoverSky}
                allowPin
                pin={pin}
                onPin={setPin}
                onSpectrum={openSpectrumTab}
              />
            )}
          </div>
          {view.showCoadd && (coaddFrames.length > 0 || coaddStatus) && (
            <div className="viewer-row">
              {coaddFrames.length > 0 ? (
                <FrameViewer
                  title={'Detector CO-ADD (mixed \u03bb)'}
                  frames={coaddFrames}
                  render={{
                    mode: view.sxScaleMode,
                    blackPct: view.sxBlackPct,
                    whitePct: view.sxWhitePct,
                    stretch: view.sxStretch,
                    invert: view.sxInvert,
                    smooth: view.sxSmooth,
                  }}
                  displaySize={view.displaySize}
                  speedMs={view.speedMs}
                  showMarkers={false}
                  hoverSky={hoverSky}
                  onHoverSky={setHoverSky}
                  showInfo
                  allowPin
                  pin={pin}
                  onPin={setPin}
                  onSpectrum={openSpectrumTab}
                />
              ) : (
                <p className="status">{coaddStatus}</p>
              )}
            </div>
          )}
          {view.showCoadd && coaddFrames.length > 0 && coaddStatus && (
            <p className="status coadd-note">{coaddStatus}</p>
          )}
          {view.showCombined && view.combinedMode === 'd6' && combinedCoaddStatus && (
            <p className="status coadd-note">{combinedCoaddStatus}</p>
          )}
          {view.showCombined &&
            queried &&
            (view.combinedMode === 'd6' ? combinedCoadds : spherexFrames).length > 0 &&
            wiseFrames.length > 0 && (
              <div className="viewer-row">
                <CombinedViewer
                  wiseFrames={wiseFrames}
                  spherexFrames={view.combinedMode === 'd6' ? combinedCoadds : spherexFrames}
                  target={queried}
                  fov={queried.fov}
                  view={view}
                  displaySize={view.displaySize}
                  speedMs={view.speedMs}
                  pin={pin}
                  onPin={setPin}
                />
              </div>
            )}
        </main>
      </div>
    </div>
  );
}
