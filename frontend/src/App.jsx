import { useEffect, useMemo, useRef, useState } from 'react';
import ControlPanel, { parseCoords } from './components/ControlPanel.jsx';
import FrameViewer from './components/FrameViewer.jsx';
import CombinedViewer from './components/CombinedViewer.jsx';
import { decodeB64Float32, sortPixels } from './lib/render.js';
import { DEFAULT_DISPLAY, buildHash, parseHash } from './lib/urlstate.js';
import { comparisonUrl } from './lib/comparison.js';

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

// Convert an epoch-coadd API result into a combined-timeline frame. Recipes
// may be single-channel, WiseView-matched D4+D6, or any custom two-channel
// detector grouping. WiseView-matched frames deliberately skip colorScale:
// that routes them through the exact same W1+W2 channel mapping and display
// controls as the preceding WISE epochs.
function toCombinedCoaddFrame(c, recipe) {
  const md = c.metadata;
  const isColor = Boolean(c.data2_b64 && md.channels === 'color');
  let long = decodeB64Float32(c.data2_b64 || c.data_b64);
  const channelName = (ch) =>
    ch?.detectors?.length ? ch.detectors.map((d) => `D${d}`).join('+') : 'channel';
  const shortName = channelName(md.short_channel);
  const longName = channelName(md.long_channel);
  const fullDepthReference = [md.short_channel, md.long_channel]
    .find((channel) => channel?.ref_scope === 'full-depth');
  const referenceNote = fullDepthReference
    ? ` \u00b7 ${channelName(fullDepthReference)} full-depth reference`
    : '';
  if (!isColor) {
    return {
      ...c,
      data: long,
      data2: null,
      sorted: sortPixels(long),
      label: `${recipe.label} \u00b7 ${md.n_exposures} exp \u00b7 grayscale`,
      sublabel: `${md.datetime_min_utc.slice(0, 10)} \u2192 ${md.datetime_max_utc.slice(0, 10)}`,
      metadata: { ...md, mjd_mid: (md.mjd_min + md.mjd_max) / 2, target_covered: true },
    };
  }
  let short = decodeB64Float32(c.data_b64);
  // The API transmits each channel in robust sky-noise units. Restore the
  // calibrated MJy/sr deviations before using WiseView's ordinary W1+W2
  // renderer, otherwise unequal D4/D6 noise would create false colors.
  if (recipe.wiseStyle) {
    const shortSigma = md.short_channel?.sky_sigma_mjy_sr;
    const longSigma = md.long_channel?.sky_sigma_mjy_sr;
    if (shortSigma && longSigma) {
      short = Float32Array.from(short, (value) => value * shortSigma);
      long = Float32Array.from(long, (value) => value * longSigma);
    }
  }
  const both = new Float32Array(short.length + long.length);
  both.set(short, 0);
  both.set(long, short.length);
  return {
    ...c,
    data: short,
    data2: long,
    sigmaS: md.short_channel?.sky_sigma_mjy_sr || null,
    sigmaL: md.long_channel?.sky_sigma_mjy_sr || null,
    wiseStyle: recipe.wiseStyle,
    sorted2: sortPixels(long),
    sorted: sortPixels(both),
    label:
      `${recipe.label} \u00b7 ${shortName} ${md.short_channel.n_exposures} exp` +
      ` + ${longName} ${md.long_channel.n_exposures} exp`,
    sublabel:
      `${md.datetime_min_utc.slice(0, 10)} \u2192 ${md.datetime_max_utc.slice(0, 10)}` +
      referenceNote,
    metadata: { ...md, mjd_mid: (md.mjd_min + md.mjd_max) / 2, target_covered: true },
  };
}

// Attach one FROZEN Lupton color scale to a set of two-channel frames:
// W = white-point percentile of the pooled positive calibrated intensity,
// floored at 25 sigma_I (never re-estimated frame by frame, so hue and
// brightness stay comparable through the whole sequence).
function attachLuptonScale(frames, { sat = 1.25, whitePct = 99.5 } = {}) {
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
  const sorted = Float64Array.from(pos).sort();
  const W = Math.max(
    sorted[Math.min(sorted.length - 1, Math.round((whitePct / 100) * (sorted.length - 1)))],
    25 * sigI,
  );
  return frames.map((f) =>
    f.data2 && f.sigmaS && f.sigmaL
      ? { ...f, colorScale: { sigmaS: f.sigmaS, sigmaL: f.sigmaL, W, sat, mode: 'color' } }
      : f,
  );
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
  // Epoch coadds for the combined timeline (lazy, cached per recipe).
  const [combinedCoadds, setCombinedCoadds] = useState([]);
  const [combinedCoaddStatus, setCombinedCoaddStatus] = useState(null);
  const combinedCoaddKey = useRef(null);
  const combinedCoaddAbort = useRef(null);
  const wiseMatchAbort = useRef(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState(initial.form);
  const [coordsError, setCoordsError] = useState(null);
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

  // Coadd modes are fetched lazily and cached by the full scientific recipe.
  useEffect(() => {
    if (!queried || loading || !view.showCombined || view.combinedMode === 'exposures') return;
    const recipe =
      view.combinedMode === 'd6'
        ? { label: 'D6 CO-ADD', band: 'SPHEREx-D6', ref: 'none', wiseStyle: false }
        : view.combinedMode === 'wise'
          ? {
              label: 'W1+W2-MATCHED CO-ADD',
              band: 'SPHEREx-D6',
              ref: 'auto',
              wiseStyle: true,
            }
          : {
              label: 'CUSTOM COLOR CO-ADD',
              short: view.combinedShortDetectors,
              long: view.combinedLongDetectors,
              wiseStyle: false,
            };
    const key = JSON.stringify({ queried, recipe, view: {
      months: view.combinedMonths,
      limit: view.combinedLimit,
      background: view.combinedBackground,
      sigma: view.combinedSigma,
      maxiters: view.combinedMaxiters,
      minChannel: view.combinedMinChannelExposures,
      pixscale: view.combinedPixscale,
      resampling: view.combinedResampling,
    } });
    if (combinedCoaddKey.current === key) return;
    combinedCoaddKey.current = key;
    const controller = new AbortController();
    combinedCoaddAbort.current = controller;
    setCombinedCoadds([]);
    setCombinedCoaddStatus(
      `Building ${recipe.label.toLowerCase()}\u2026 one stack per sky-pass visit.`,
    );
    const params = new URLSearchParams({
      ra: queried.ra,
      dec: queried.dec,
      radius_arcsec: queried.fov / 2,
      survey: queried.survey,
      bin_months: view.combinedMonths,
      limit: view.combinedLimit,
      background: view.combinedBackground,
      sigma: view.combinedSigma,
      maxiters: view.combinedMaxiters,
      min_channel_exposures: view.combinedMinChannelExposures,
      pixscale_arcsec: view.combinedPixscale,
      resampling: view.combinedResampling,
    });
    if (recipe.band) {
      params.set('band', recipe.band);
      params.set('ref', recipe.ref);
    } else {
      params.set('short_detectors', recipe.short.join(','));
      params.set('long_detectors', recipe.long.join(','));
    }
    const timer = window.setTimeout(() => {
      fetch(`/api/epoch-coadds?${params}`, { signal: controller.signal })
        .then((r) =>
          r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.detail || r.statusText))),
        )
        .then((d) => {
          if (combinedCoaddKey.current !== key) return;
          const mapped = d.frames.map((frame) => toCombinedCoaddFrame(frame, recipe));
          setCombinedCoadds(
            recipe.wiseStyle ? mapped : attachLuptonScale(mapped, { sat: 1.25 }),
          );
          setCombinedCoaddStatus(
            d.count
              ? null
              : `No ${recipe.label.toLowerCase()} frames are available for this field.`,
          );
        })
        .catch((err) => {
          if (err.name === 'AbortError' || combinedCoaddKey.current !== key) return;
          combinedCoaddKey.current = null;
          setCombinedCoaddStatus(`${recipe.label} failed: ${err.message}`);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (combinedCoaddAbort.current === controller) {
        combinedCoaddAbort.current = null;
        combinedCoaddKey.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    queried,
    loading,
    view.showCombined,
    view.combinedMode,
    view.combinedMonths,
    view.combinedLimit,
    view.combinedBackground,
    view.combinedSigma,
    view.combinedMaxiters,
    view.combinedMinChannelExposures,
    view.combinedPixscale,
    view.combinedResampling,
    view.combinedShortDetectors,
    view.combinedLongDetectors,
  ]);

  // The matched product is a full color handoff, not W2 grayscale followed
  // by D4+D6 color. Fetch W1+W2 epochs automatically when this mode is used.
  useEffect(() => {
    if (!queried || loading || !view.showCombined || view.combinedMode !== 'wise') return;
    const controller = new AbortController();
    wiseMatchAbort.current = controller;
    const params = new URLSearchParams({
      ra: queried.ra,
      dec: queried.dec,
      size_arcsec: queried.fov,
      band: 'w1w2',
      gaia: 'true',
    });
    fetch(`/api/wise-stack?${params}`, { signal: controller.signal })
      .then((r) =>
        r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.detail || r.statusText))),
      )
      .then((d) => {
        if (controller.signal.aborted) return;
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
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setCombinedCoaddStatus(`WISE W1+W2 fetch failed: ${err.message}`);
      });
    return () => controller.abort();
  }, [queried, loading, view.showCombined, view.combinedMode]);

  const search = async ({ ra, dec, fov, survey, band, limit, wiseBand }) => {
    setLoading(true);
    setError(null);
    setStatus('Querying SPHEREx + WiseView\u2026 first fetch of a field can take a minute.');
    setSpherexFrames([]);
    setWiseFrames([]);
    setCombinedCoadds([]);
    setCombinedCoaddStatus(null);
    combinedCoaddKey.current = null;
    combinedCoaddAbort.current?.abort();
    wiseMatchAbort.current?.abort();
    setPin(null); // shared pin belongs to the previous field
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
    <div className="app timeline-app">
      <header className="timeline-header">
        <div>
          <a className="timeline-brand" href="index.html">SPHERExView</a>
          <h1>WISE → SPHEREx</h1>
          <p className="subtitle">One sky field. Two missions. A continuous timeline.</p>
        </div>
        <span className="timeline-tag">QR2 · ICRS</span>
      </header>
      <div className="layout">
        <main className="viewers">
          <div className="timeline-toolbar">
            <section className="panel-switch" aria-label="Visible panels">
              <span>Panels</span>
              {[
                ['showCombined', 'Combined timeline'],
                ['showWise', 'WISE panel'],
                ['showSpherex', 'SPHEREx panel'],
              ].map(([key, label]) => (
                <label className={view[key] ? 'active' : ''} key={key}>
                  <input
                    type="checkbox"
                    checked={view[key]}
                    onChange={(event) => setView((current) => ({ ...current, [key]: event.target.checked }))}
                  />
                  {label}
                </label>
              ))}
            </section>
            <div className="timeline-tools" role="group" aria-label="Tools for this target">
              <span>Tools</span>
              <button
                type="button"
                className="spectrum-btn"
                onClick={() => {
                  const coords = parseCoords(form.coords);
                  if (!coords) {
                    setCoordsError('Enter RA and Dec in decimal degrees, e.g. 11.889632 28.089606');
                    return;
                  }
                  openSpectrumTab(coords.ra, coords.dec);
                }}
              >
                Generate spectrum at target
              </button>
              <button
                type="button"
                className="spectrum-btn"
                onClick={() => {
                  const coords = parseCoords(form.coords);
                  if (!coords) {
                    setCoordsError('Enter RA and Dec in decimal degrees, e.g. 11.889632 28.089606');
                    return;
                  }
                  openBlinkTab(coords.ra, coords.dec, form.fov, form.survey, form.limit);
                }}
              >
                Epoch blink sequence
              </button>
              <button type="button" className="spectrum-btn" onClick={() => {
                const coords = parseCoords(form.coords);
                if (!coords) {
                  setCoordsError('Enter RA and Dec in decimal degrees, e.g. 11.889632 28.089606');
                  return;
                }
                window.open(comparisonUrl(coords.ra, coords.dec, form.fov, form.survey), '_blank', 'noopener');
              }}>
                Six-detector comparison
              </button>
            </div>
          </div>
          <div className="timeline-status" role="status">
            {loading && <span className="timeline-spinner" aria-hidden="true" />}
            {status || 'Choose a sky position and fetch images to begin.'}
          </div>
          {error && <p className="status error" role="alert">{error}</p>}
          {view.showCombined && (
            <div className="timeline-primary" aria-label="Combined timeline view">
              {view.combinedMode !== 'exposures' && combinedCoaddStatus && (
                <p className="status coadd-note" role="status">{combinedCoaddStatus}</p>
              )}
              {queried &&
                (view.combinedMode === 'exposures' ? spherexFrames : combinedCoadds).length > 0 &&
                wiseFrames.length > 0 ? (
                  <CombinedViewer
                    wiseFrames={wiseFrames}
                    spherexFrames={view.combinedMode === 'exposures' ? spherexFrames : combinedCoadds}
                    target={queried}
                    fov={queried.fov}
                    view={view}
                    displaySize={view.displaySize}
                    speedMs={view.speedMs}
                    pin={pin}
                    onPin={setPin}
                    onSpectrum={openSpectrumTab}
                  />
                ) : (
                  <section className="panel viewer combined-viewer timeline-empty">
                    <h2>Combined timeline (WISE → SPHEREx)</h2>
                    <div className="timeline-placeholder">
                      <span className="timeline-missions" aria-hidden="true">WISE → SPHEREx</span>
                      <h3>{loading ? 'Loading images…' : !queried ? 'Awaiting target' : combinedCoaddStatus ? 'Preparing timeline' : 'No combined timeline available'}</h3>
                      <p>{!queried
                        ? 'Enter coordinates and fetch images to follow the same sky field across both missions.'
                        : 'The timeline needs WISE and SPHEREx frames. Check the query status or enable an individual panel to inspect the available images.'}</p>
                    </div>
                    <p className="combined-note">Chronological playback · shared sky coordinates · linked source pin</p>
                  </section>
                )}
            </div>
          )}
          {!view.showCombined && !view.showWise && !view.showSpherex && (
            <p className="timeline-placeholder">Choose a panel above to display the images.</p>
          )}
          <div className="viewer-row">
            {view.showSpherex && spherexFrames.length > 0 && (
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
        </main>
        <ControlPanel
          onSearch={search}
          loading={loading}
          view={view}
          setView={setView}
          form={form}
          setForm={setForm}
          coordsError={coordsError}
          setCoordsError={setCoordsError}
        />
      </div>
    </div>
  );
}
