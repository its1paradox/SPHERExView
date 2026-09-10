import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// SPHEREx spectrum viewer (opened in its own tab).
//
// URL hash: #ra=<deg>&dec=<deg>[&bkg=15][&job=<uws-job-id>]
// Without a job id it submits a new IRSA spectrophotometry job and writes
// the assigned id back into the hash, so a reload (or a shared link)
// reattaches to the same job instead of resubmitting.

const BAND_COLORS = {
  D1: '#2f6fd4',
  D2: '#12939a',
  D3: '#5ba832',
  D4: '#d99a1f',
  D5: '#e2703a',
  D6: '#c8384a',
};
const BANDS = Object.keys(BAND_COLORS);

// Column names vary slightly between service versions; probe candidates.
const pick = (columns, candidates) =>
  candidates.find((c) => columns.includes(c)) || null;

function parseHashParams() {
  const params = new URLSearchParams(window.location.hash.replace(/^#\/?/, ''));
  const num = (k) => {
    const v = parseFloat(params.get(k));
    return Number.isFinite(v) ? v : null;
  };
  return {
    ra: num('ra'),
    dec: num('dec'),
    bkg: num('bkg') || 15,
    job: params.get('job') || null,
  };
}

function writeHash({ ra, dec, bkg, job }) {
  const parts = [`ra=${ra}`, `dec=${dec}`, `bkg=${bkg}`];
  if (job) parts.push(`job=${job}`);
  window.history.replaceState(null, '', '#' + parts.join('&'));
}

// Extracts the detector band (D1..D6) from a row: prefer the det_id
// column, fall back to parsing the publisher DID (…/D3).
function rowBand(row, detCol, didCol) {
  if (detCol && row[detCol] >= 1 && row[detCol] <= 6) return `D${row[detCol]}`;
  const did = didCol ? String(row[didCol] || '') : '';
  const m = did.match(/\/D([1-6])\b/) || did.match(/[Dd]([1-6])/);
  return m ? `D${m[1]}` : null;
}

const fmt = (v, digits = 4) =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toPrecision(digits);

export default function SpectrumPage() {
  const [params] = useState(parseHashParams);
  const [phase, setPhase] = useState(params.job ? 'ATTACHING' : 'SUBMITTING');
  const [jobId, setJobId] = useState(params.job);
  const [error, setError] = useState(null);
  const [table, setTable] = useState(null);
  const [elapsed, setElapsed] = useState(0);

  // Display state
  const [logFlux, setLogFlux] = useState(false);
  const [showErrors, setShowErrors] = useState(true);
  // Same trace styles as IRSA's spectrophotometry chart: points,
  // connected points, or lines.
  const [traceStyle, setTraceStyle] = useState('points');
  const [hideFlagged, setHideFlagged] = useState(false);
  const [bandsOn, setBandsOn] = useState(() => Object.fromEntries(BANDS.map((b) => [b, true])));
  const [viewMode, setViewMode] = useState('plot'); // 'plot' | 'table'
  const [hoverPt, setHoverPt] = useState(null);
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [plotW, setPlotW] = useState(900);

  const badTarget = params.ra === null || params.dec === null;

  // ---- job lifecycle -------------------------------------------------
  useEffect(() => {
    if (badTarget) return undefined;
    let stop = false;
    let timer = null;
    const t0 = Date.now();

    const tick = () => setElapsed(Math.round((Date.now() - t0) / 1000));

    const loadTable = async (id) => {
      const res = await fetch(`/api/spectra/table/${id}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || res.statusText);
      if (!stop) {
        setTable(body);
        setPhase('COMPLETED');
      }
    };

    const poll = async (id) => {
      while (!stop) {
        const res = await fetch(`/api/spectra/status/${id}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.detail || res.statusText);
        if (stop) return;
        setPhase(body.phase);
        if (body.phase === 'COMPLETED') {
          await loadTable(id);
          return;
        }
        if (body.phase === 'ERROR' || body.phase === 'ABORTED') {
          throw new Error(
            body.error_message ||
              `IRSA reported job phase ${body.phase} without an explanation.`,
          );
        }
        await new Promise((ok) => setTimeout(ok, 8000));
        tick();
      }
    };

    const run = async () => {
      try {
        let id = params.job;
        if (!id) {
          const query = new URLSearchParams({
            ra: params.ra,
            dec: params.dec,
            bkg_region: Math.round(params.bkg),
          });
          const res = await fetch(`/api/spectra/submit?${query}`, { method: 'POST' });
          const body = await res.json();
          if (!res.ok) throw new Error(body.detail || res.statusText);
          id = body.job_id;
          if (stop) return;
          setJobId(id);
          writeHash({ ...params, job: id });
        }
        await poll(id);
      } catch (err) {
        if (!stop) {
          setError(err.message);
          setPhase('FAILED');
        }
      }
    };

    run();
    timer = setInterval(tick, 1000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- derived data ---------------------------------------------------
  const cols = table?.columns || [];
  const wlCol = useMemo(() => pick(cols, ['wavelength', 'lambda', 'wave', 'wavelength_um']), [cols]);
  const wlWidthCol = useMemo(
    () => pick(cols, ['bandwidth', 'wavelength_width', 'lambda_width', 'dlambda', 'bandpass']),
    [cols],
  );
  const fluxCol = useMemo(() => pick(cols, ['flux', 'flux_mjy', 'fnu', 'flux_density']), [cols]);
  const errCol = useMemo(
    () => pick(cols, ['flux_err', 'flux_error', 'dflux', 'flux_unc', 'fluxerr']),
    [cols],
  );
  const flagsCol = useMemo(() => pick(cols, ['flags', 'flag', 'bitflags']), [cols]);
  const didCol = useMemo(
    () => pick(cols, ['obs_publisher_did', 'publisher_did', 'obs_id']),
    [cols],
  );
  const detCol = useMemo(() => pick(cols, ['det_id', 'detector', 'det']), [cols]);
  const mjdCol = useMemo(() => pick(cols, ['mjd', 'obs_mjd', 'mjd_mid', 'time']), [cols]);
  const fluxUnit = (table?.units && fluxCol && table.units[fluxCol]) || 'flux unit';

  const points = useMemo(() => {
    if (!table || !wlCol || !fluxCol) return [];
    return table.rows
      .map((row, i) => ({
        i,
        wl: row[wlCol],
        flux: row[fluxCol],
        err: errCol ? row[errCol] : null,
        flags: flagsCol ? row[flagsCol] : null,
        band: rowBand(row, detCol, didCol),
        mjd: mjdCol ? row[mjdCol] : null,
        row,
      }))
      .filter((p) => p.wl !== null && p.flux !== null);
  }, [table, wlCol, fluxCol, errCol, flagsCol, detCol, didCol, mjdCol]);

  const shown = useMemo(
    () =>
      points.filter(
        (p) =>
          (p.band === null || bandsOn[p.band]) &&
          (!hideFlagged || !p.flags || Number(p.flags) === 0) &&
          (!logFlux || p.flux > 0),
      ),
    [points, bandsOn, hideFlagged, logFlux],
  );

  // ---- responsive width ------------------------------------------------
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const update = () => setPlotW(Math.max(480, Math.min(el.clientWidth, 1400)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [table]);

  // Log-scale tick label: "10^n" at integer decades, else "3.2e2"-style.
  const SUP = { '-': '\u207b', 0: '\u2070', 1: '\u00b9', 2: '\u00b2', 3: '\u00b3', 4: '\u2074', 5: '\u2075', 6: '\u2076', 7: '\u2077', 8: '\u2078', 9: '\u2079' };
  const fmtLogTick = (vv) => {
    const near = Math.round(vv);
    if (Math.abs(vv - near) < 0.02) {
      return `10${String(near).split('').map((c) => SUP[c] || c).join('')}`;
    }
    const mant = 10 ** (vv - Math.floor(vv));
    return `${mant.toFixed(1)}\u00d710${String(Math.floor(vv)).split('').map((c) => SUP[c] || c).join('')}`;
  };

  // ---- plot geometry ----------------------------------------------------
  const H = 460;
  const M = { l: 74, r: 16, t: 14, b: 46 };
  const geom = useMemo(() => {
    if (shown.length === 0) return null;
    const xs = shown.map((p) => p.wl);
    const ysLo = shown.map((p) => (showErrors && p.err ? p.flux - p.err : p.flux));
    const ysHi = shown.map((p) => (showErrors && p.err ? p.flux + p.err : p.flux));
    let x0 = Math.min(...xs);
    let x1 = Math.max(...xs);
    let y0 = Math.min(...ysLo);
    let y1 = Math.max(...ysHi);
    if (logFlux) {
      y0 = Math.max(y0, Math.min(...shown.map((p) => p.flux)) * 0.5);
      y0 = Math.log10(Math.max(y0, 1e-12));
      y1 = Math.log10(Math.max(y1, 1e-12));
    }
    const padX = (x1 - x0 || 1) * 0.04;
    const padY = (y1 - y0 || 1) * 0.08;
    x0 -= padX;
    x1 += padX;
    y0 -= padY;
    y1 += padY;
    const X = (wl) => M.l + ((wl - x0) / (x1 - x0)) * (plotW - M.l - M.r);
    const Y = (f) => {
      const v = logFlux ? Math.log10(Math.max(f, 1e-12)) : f;
      return H - M.b - ((v - y0) / (y1 - y0)) * (H - M.t - M.b);
    };
    return { x0, x1, y0, y1, X, Y };
  }, [shown, logFlux, showErrors, plotW]);

  // ---- canvas drawing ---------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewMode !== 'plot') return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = plotW * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${plotW}px`;
    canvas.style.height = `${H}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, plotW, H);
    if (!geom) {
      ctx.fillStyle = '#555';
      ctx.font = '14px system-ui, sans-serif';
      ctx.fillText('No points to plot (check band / flag filters).', 40, 60);
      return;
    }
    const { x0, x1, y0, y1, X, Y } = geom;

    // Grid + ticks
    ctx.strokeStyle = '#e3e6ea';
    ctx.fillStyle = '#444';
    ctx.font = '12px system-ui, sans-serif';
    ctx.lineWidth = 1;
    const xTicks = 8;
    for (let i = 0; i <= xTicks; i++) {
      const wl = x0 + ((x1 - x0) * i) / xTicks;
      const px = X(wl);
      ctx.beginPath();
      ctx.moveTo(px, M.t);
      ctx.lineTo(px, H - M.b);
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillText(wl.toFixed(2), px, H - M.b + 18);
    }
    const yTicks = 6;
    for (let i = 0; i <= yTicks; i++) {
      const vv = y0 + ((y1 - y0) * i) / yTicks;
      const py = H - M.b - ((vv - y0) / (y1 - y0)) * (H - M.t - M.b);
      ctx.beginPath();
      ctx.moveTo(M.l, py);
      ctx.lineTo(plotW - M.r, py);
      ctx.stroke();
      ctx.textAlign = 'right';
      const label = logFlux ? fmtLogTick(vv) : vv.toPrecision(3);
      ctx.fillText(label, M.l - 8, py + 4);
    }

    // Axes labels
    ctx.fillStyle = '#222';
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Wavelength (\u00b5m)', M.l + (plotW - M.l - M.r) / 2, H - 10);
    ctx.save();
    ctx.translate(16, M.t + (H - M.t - M.b) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`Flux density (${fluxUnit})${logFlux ? ' \u2014 log scale' : ''}`, 0, 0);
    ctx.restore();

    // Error bars first so traces/markers draw on top.  Bars are clamped to
    // the plot area (in log mode flux-err is often <= 0, which would
    // otherwise shoot far below the axis) and get serif caps so even bars
    // shorter than the marker stay visible.
    if (showErrors) {
      const yTop = M.t;
      const yBot = H - M.b;
      const clampY = (v) => Math.min(yBot, Math.max(yTop, v));
      for (const p of shown) {
        if (p.err === null || p.err === undefined || !(p.err > 0)) continue;
        const color = BAND_COLORS[p.band] || '#666';
        const px = X(p.wl);
        const yLo = clampY(Y(p.flux - p.err));
        const yHi = clampY(Y(p.flux + p.err));
        ctx.strokeStyle = color + 'aa';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(px, yLo);
        ctx.lineTo(px, yHi);
        // serif caps (skip a cap when its end was clamped to the plot edge)
        if (Y(p.flux - p.err) <= yBot) {
          ctx.moveTo(px - 2.5, yLo);
          ctx.lineTo(px + 2.5, yLo);
        }
        if (Y(p.flux + p.err) >= yTop) {
          ctx.moveTo(px - 2.5, yHi);
          ctx.lineTo(px + 2.5, yHi);
        }
        ctx.stroke();
      }
    }

    // Connecting trace (IRSA "connected points" / "lines" styles): one
    // polyline through all shown measurements in wavelength order, each
    // segment coloured by the band of its bluer endpoint.
    if (traceStyle !== 'points' && shown.length > 1) {
      const ordered = [...shown].sort((a, b) => a.wl - b.wl);
      ctx.lineWidth = traceStyle === 'lines' ? 1.6 : 1.2;
      for (let k = 1; k < ordered.length; k++) {
        const a = ordered[k - 1];
        const b = ordered[k];
        ctx.strokeStyle = (BAND_COLORS[a.band] || '#666') + (traceStyle === 'lines' ? 'ff' : 'aa');
        ctx.beginPath();
        ctx.moveTo(X(a.wl), Y(a.flux));
        ctx.lineTo(X(b.wl), Y(b.flux));
        ctx.stroke();
      }
    }

    // Point markers (flagged points get a hollow ring).
    if (traceStyle !== 'lines') {
      for (const p of shown) {
        const color = BAND_COLORS[p.band] || '#666';
        const px = X(p.wl);
        const py = Y(p.flux);
        const flagged = p.flags && Number(p.flags) !== 0;
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, 2 * Math.PI);
        if (flagged) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        } else {
          ctx.fillStyle = color;
          ctx.fill();
        }
      }
    }

    // Hover crosshair + highlight
    if (hoverPt) {
      const px = X(hoverPt.wl);
      const py = Y(hoverPt.flux);
      ctx.strokeStyle = '#00000030';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, M.t);
      ctx.lineTo(px, H - M.b);
      ctx.moveTo(M.l, py);
      ctx.lineTo(plotW - M.r, py);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, py, 5.5, 0, 2 * Math.PI);
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
  }, [shown, geom, viewMode, hoverPt, showErrors, logFlux, plotW, fluxUnit, traceStyle]);

  // ---- hover ------------------------------------------------------------
  const onMove = useCallback(
    (e) => {
      if (!geom) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      let best = null;
      let bestD = 14 * 14;
      for (const p of shown) {
        const dx = geom.X(p.wl) - mx;
        const dy = geom.Y(p.flux) - my;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      setHoverPt(best);
    },
    [geom, shown],
  );

  const downloadPng = () => {
    const link = document.createElement('a');
    link.download = `spherex_spectrum_${(jobId || 'plot').slice(0, 8)}.png`;
    link.href = canvasRef.current.toDataURL('image/png');
    link.click();
  };

  // ---- render -----------------------------------------------------------
  const running = !badTarget && !error && phase !== 'COMPLETED';
  const nFlagged = points.filter((p) => p.flags && Number(p.flags) !== 0).length;

  return (
    <div className="app spectrum-app">
      <header>
        <h1>SPHERExView {'\u2014'} Spectrum</h1>
        <p className="subtitle">
          IRSA SPHEREx forced-photometry spectrum
          {params.ra !== null && (
            <>
              {' at \u03b1 '}
              {params.ra.toFixed(6)}{'\u00b0, \u03b4 '}{params.dec >= 0 ? '+' : ''}
              {params.dec.toFixed(6)}{'\u00b0'}
            </>
          )}
        </p>
      </header>

      {badTarget && (
        <p className="status error">
          Missing target: open this page as spectrum.html#ra=&lt;deg&gt;&amp;dec=&lt;deg&gt;
        </p>
      )}

      {running && (
        <div className="spectrum-progress">
          <div className="spinner" aria-hidden="true" />
          <div>
            <p className="progress-phase">
              {phase === 'SUBMITTING' && 'Submitting job to IRSA\u2026'}
              {phase === 'ATTACHING' && 'Reattaching to existing job\u2026'}
              {['PENDING', 'QUEUED', 'HELD'].includes(phase) && `Job queued at IRSA (${phase})\u2026`}
              {['EXECUTING', 'RUN', 'UNKNOWN', 'SUSPENDED'].includes(phase) &&
                'IRSA is extracting the spectrum from every SPHEREx image covering this position\u2026'}
            </p>
            <p className="progress-detail">
              Elapsed {Math.floor(elapsed / 60)}m {elapsed % 60}s{' \u00b7 '}typical jobs take 2{'\u2013'}15
              minutes (longer near the ecliptic poles). Keep this tab open {'\u2014'} or bookmark it: the
              URL now carries the job id and will reattach after a reload.
              {jobId && (
                <>
                  {' '}Job: <code>{jobId}</code>
                </>
              )}
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="status error spectrum-error">
          <p>Spectrum job failed: {error}</p>
          <p className="hint">
            IRSA limits each user to two concurrent jobs, and positions with no SPHEREx coverage
            return errors. You can retry by reloading this tab without the job id in the URL.
          </p>
        </div>
      )}

      {table && (
        <div className="spectrum-main" ref={wrapRef}>
          <div className="spectrum-toolbar">
            <div className="spectrum-bands">
              {BANDS.map((b) => (
                <label
                  key={b}
                  className={`band-chip ${bandsOn[b] ? '' : 'off'}`}
                  style={{ '--chip': BAND_COLORS[b] }}
                >
                  <input
                    type="checkbox"
                    checked={bandsOn[b]}
                    onChange={() => setBandsOn({ ...bandsOn, [b]: !bandsOn[b] })}
                  />
                  {b}
                </label>
              ))}
            </div>
            <label className="trace-style">
              Trace
              <select value={traceStyle} onChange={(e) => setTraceStyle(e.target.value)}>
                <option value="points">Points</option>
                <option value="connected">Connected points</option>
                <option value="lines">Lines</option>
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={logFlux} onChange={() => setLogFlux(!logFlux)} />
              Log flux
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={showErrors}
                onChange={() => setShowErrors(!showErrors)}
              />
              Error bars
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={hideFlagged}
                onChange={() => setHideFlagged(!hideFlagged)}
              />
              Hide flagged ({nFlagged})
            </label>
            <div className="spectrum-viewtoggle">
              <button
                type="button"
                className={viewMode === 'plot' ? 'active' : ''}
                onClick={() => setViewMode('plot')}
              >
                Plot
              </button>
              <button
                type="button"
                className={viewMode === 'table' ? 'active' : ''}
                onClick={() => setViewMode('table')}
              >
                Table
              </button>
            </div>
          </div>

          {viewMode === 'plot' && (
            <>
              <canvas
                ref={canvasRef}
                className="spectrum-canvas"
                onMouseMove={onMove}
                onMouseLeave={() => setHoverPt(null)}
              />
              <div className="spectrum-readout">
                {hoverPt ? (
                  <>
                    <span style={{ color: BAND_COLORS[hoverPt.band] || '#333', fontWeight: 600 }}>
                      {hoverPt.band || 'band ?'}
                    </span>
                    {' \u00b7 \u03bb '}{fmt(hoverPt.wl)}{' \u00b5m'}
                    {' \u00b7 flux '}{fmt(hoverPt.flux)}
                    {hoverPt.err !== null && <>{' \u00b1 '}{fmt(hoverPt.err, 3)}</>} {fluxUnit}
                    {hoverPt.mjd !== null && <> {' \u00b7 MJD '}{fmt(hoverPt.mjd, 8)}</>}
                    {hoverPt.flags !== null && Number(hoverPt.flags) !== 0 && (
                      <span className="flagged-note"> {' \u00b7 flags '}{String(hoverPt.flags)}</span>
                    )}
                  </>
                ) : (
                  `${shown.length} of ${points.length} measurements shown \u2014 hover a point for details; hollow rings are flagged`
                )}
              </div>
            </>
          )}

          {viewMode === 'table' && (
            <div className="spectrum-table-wrap">
              <table className="spectrum-table">
                <thead>
                  <tr>
                    {cols.map((c) => (
                      <th key={c}>
                        {c}
                        {table.units[c] ? <span className="unit"> ({table.units[c]})</span> : null}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row, i) => (
                    <tr key={i}>
                      {cols.map((c) => (
                        <td key={c}>
                          {row[c] === null || row[c] === undefined
                            ? ''
                            : typeof row[c] === 'number'
                              ? Number.isInteger(row[c])
                                ? String(row[c])
                                : Number(row[c]).toPrecision(6)
                              : String(row[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="spectrum-downloads">
            <span>Download:</span>
            <a href={`/api/spectra/download/${jobId}?fmt=votable`}>VOTable (XML)</a>
            <a href={`/api/spectra/download/${jobId}?fmt=csv`}>CSV</a>
            <a href={`/api/spectra/download/${jobId}?fmt=json`}>JSON</a>
            {viewMode === 'plot' && (
              <button type="button" className="pin-btn" onClick={downloadPng}>
                PNG of plot
              </button>
            )}
            <span className="hint-inline">
              VOTable is the original IRSA product (re-uploadable to IRSA tools); CSV/JSON are the
              flattened per-exposure table ({table.count} rows).
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
