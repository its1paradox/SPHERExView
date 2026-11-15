import { useEffect, useMemo, useRef, useState } from 'react';
import { DETECTOR_COLORS, frequencyTHz, spectrumAt, spectrumCsv, spectrumGuides, spectrumDiagnostics } from '../lib/liveSpectrum.js';

const number = (x, digits = 4) => Number.isFinite(x) ? Number(x.toPrecision(digits)).toLocaleString('en-US', { maximumFractionDigits: 5 }) : '—';
const save = (blob, name) => { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };

export default function LiveSpectrum({ epoch, index, sky, recipe, pinned, preview, display, setDisplay, failures = 0, previewSubset = false, onClearPin }) {
  const spectrumRelease = epoch?.spectrum_release_summary?.data_release || epoch?.data_release;
  const svg = useRef(null), [active, setActive] = useState(null);
  const frequency = display.spectrumFrequency, subtractSky = display.spectrumLocalSky, completeOnly = !!display.spectrumComplete;
  const setFrequency = change => setDisplay(d => ({ ...d, spectrumFrequency: change(d.spectrumFrequency) }));
  const setSubtractSky = value => setDisplay(d => ({ ...d, spectrumLocalSky: value }));
  const [plotWidth, setPlotWidth] = useState(920);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      if (width > 0) setPlotWidth(Math.max(300, Math.round(width)));
    });
    observer.observe(svg.current.parentElement);
    return () => observer.disconnect();
  }, []);
  useEffect(() => setActive(null), [epoch, index, subtractSky, completeOnly]);
  const points = useMemo(() => spectrumAt(epoch, index, subtractSky, completeOnly), [epoch, index, subtractSky, completeOnly]);
  const guides = useMemo(() => spectrumGuides(points), [points]);
  const availability = useMemo(() => spectrumDiagnostics(epoch, index, subtractSky, completeOnly), [epoch, index, subtractSky, completeOnly]);
  const peak = points.reduce((best, p) => !best || p.flux > best.flux ? p : best, null);
  const values = [...points.flatMap(p => [p.flux - p.error, p.flux + p.error]), ...(display.spectrumLines ? guides.flatMap(g => g.curve.map(p => p.flux)) : [])];
  const low = Math.min(0, ...values), high = Math.max(1, ...values), pad = (high - low) * .08;
  const ymin = low - pad, ymax = high + pad;
  const W = plotWidth, H = 290, left = 78, right = W - 20, top = 22, bottom = 239;
  const lambdaMin = Math.min(.7, ...points.map(p => p.lambda_min)), lambdaMax = Math.max(5.05, ...points.map(p => p.lambda_max));
  const xmin = frequency ? frequencyTHz(lambdaMax) : lambdaMin, xmax = frequency ? frequencyTHz(lambdaMin) : lambdaMax;
  const x = v => left + ((frequency ? frequencyTHz(v) : v) - xmin) / (xmax - xmin) * (right - left);
  const y = v => bottom - (v - ymin) / (ymax - ymin) * (bottom - top);
  const xTicks = frequency ? (W < 600 ? [100, 200, 300, 400] : [60, 100, 150, 200, 250, 300, 350, 400]) : (W < 600 ? [1, 2, 3, 4, 5] : [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]);
  const selected = points[active];
  const downloadPng = () => {
    const copy = svg.current.cloneNode(true);
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    copy.setAttribute('width', W); copy.setAttribute('height', H);
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' }));
    const image = new Image();
    image.onload = () => {
      const chartHeight = H * 1840 / W;
      const canvas = document.createElement('canvas'); canvas.width = 1840; canvas.height = Math.ceil(chartHeight + 160);
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#101b27'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 65, 1840, chartHeight); ctx.fillStyle = '#e0e9f2'; ctx.font = '24px sans-serif';
      ctx.fillText(`SPHEREx aperture spectrum · ${spectrumRelease?.toUpperCase()} · epoch ${epoch.index + 1} · ${sky.ra.toFixed(6)}°, ${sky.dec.toFixed(6)}° ICRS`, 24, 37);
      ctx.font = '19px sans-serif';
      ctx.fillText(`r = ${recipe.aperture_radius_arcsec}″; sky annulus ${1.5 * recipe.aperture_radius_arcsec}–${2.5 * recipe.aperture_radius_arcsec}″ · ${points.length} exposures (${availability.partial} partial)${previewSubset ? ' · PREVIEW SUBSET' : ''} · supplied background: ${recipe.background} · ${subtractSky ? "local annulus subtracted" : "local sky retained"}`, 24, canvas.height - 58);
      ctx.fillText('Fν in µJy · formal 1σ · no PSF correction. Open dots: partial flux; masked pixels not recovered. Masks can distort spectral shape. Red guides: DR1 solid, QR3 dashed; display only.', 24, canvas.height - 26);
      canvas.toBlob(blob => { if (blob) save(blob, 'spherex-aperture-spectrum.png'); }); URL.revokeObjectURL(url);
    };
    image.onerror = () => URL.revokeObjectURL(url); image.src = url;
  };
  return <section className="live-spectrum" aria-label="Live aperture spectrum">
    <div className="spectrum-heading"><div><h2>Aperture spectrum <span>{preview ? 'HOVER' : pinned ? 'PINNED' : 'LIVE'}</span></h2><p>{sky ? `${sky.ra.toFixed(6)}°, ${sky.dec.toFixed(6)}° ICRS · grid center · ` : ''}{points.length} exposure samples · {spectrumRelease?.toUpperCase() || 'current epoch'}{previewSubset ? ' · preview subset' : ''}</p></div>
      <div className="spectrum-actions"><label>Aperture pixels<select aria-label="Aperture pixels" value={completeOnly ? "complete" : "usable"} onChange={e => { const complete = e.target.value === "complete"; setDisplay(d => ({ ...d, spectrumComplete: complete })); }}><option value="usable">Usable pixels (include partial)</option><option value="complete">Complete apertures only</option></select></label><label>Spectrum background<select aria-label="Spectrum background" value={subtractSky ? "annulus" : "supplied"} onChange={e => setSubtractSky(e.target.value === "annulus")}><option value="supplied">{recipe?.background === "zodi" ? "ZODI model only" : "No subtraction"}</option><option value="annulus">Also subtract local annulus</option></select></label>{pinned && <button onClick={onClearPin}>Clear spectrum pin</button>}<button aria-pressed={frequency} onClick={() => setFrequency(v => !v)}>{frequency ? 'Wavelength axis' : 'Frequency axis'}</button><button disabled={!points.length} onClick={() => save(new Blob([spectrumCsv(points, sky, recipe, epoch, subtractSky, completeOnly)], { type: 'text/csv' }), 'spherex-aperture-spectrum.csv')}>Save spectrum CSV</button><button disabled={!points.length} onClick={downloadPng}>Save spectrum PNG</button></div>
    </div>
    <div className="spectrum-options">
      <label className="compare-check"><input type="checkbox" checked={display.spectrumLines} onChange={e => { const checked = e.target.checked; setDisplay(d => ({ ...d, spectrumLines: checked })); }} />Robust smooth guide</label>
      <label className="compare-check"><input type="checkbox" checked={display.showAperture} onChange={e => { const checked = e.target.checked; setDisplay(d => ({ ...d, showAperture: checked })); }} />Show measurement aperture</label>
    </div>
    {(availability.partial > 0 || availability.total > availability.usable) && <div className="spectrum-availability" role="status">
      <strong>{availability.usable} of {availability.total} exposures shown{availability.partial > 0 ? ` · ${availability.partial} partial apertures (open dots)` : ''}.</strong>{' '}
      {availability.partial > 0 && <span>Partial measurements sum only usable pixels. Masked star cores are excluded; varying missing flux can change the spectral shape and apparent peak. Coverage is area, not recovered star light. </span>}
      {availability.aperture > 0 && <span>{availability.aperture} omitted: {completeOnly ? 'the aperture is incomplete' : 'no usable aperture measurement'}. </span>}
      {availability.sky > 0 && <span>{availability.sky} lack enough clean sky for local-annulus subtraction. </span>}
      {availability.other > 0 && <span>{availability.other} lack a valid flux, uncertainty or wavelength. </span>}
      {completeOnly && availability.aperture > 0 && <span>Choose “Usable pixels” to inspect partial measurements without filling masked pixels.</span>}
    </div>}
    <div className="spectrum-plot">
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Aperture flux density F nu in microjanskys versus ${frequency ? 'frequency in terahertz' : 'wavelength in micrometers'}, ${points.length} exposure samples`} style={{ fontFamily: 'system-ui, sans-serif', background: '#101b27' }} onPointerLeave={() => setActive(null)}>
        <rect width={W} height={H} fill="#101b27" />
        {Array.from({ length: 5 }, (_, i) => ymin + (ymax - ymin) * i / 4).map(v => <g key={v}><line x1={left} x2={right} y1={y(v)} y2={y(v)} stroke="#2b3c4d" /><text x={left - 9} y={y(v) + 4} textAnchor="end" fill="#a8bfd0" fontSize="11">{number(v)}</text></g>)}
        {xTicks.filter(v => v >= xmin && v <= xmax).map(v => { const pos = left + (v - xmin) / (xmax - xmin) * (right - left); return <g key={v}><line x1={pos} x2={pos} y1={top} y2={bottom} stroke="#253646" /><text x={pos} y={bottom + 20} textAnchor="middle" fill="#a8bfd0" fontSize="12">{v}</text></g>; })}
        <line x1={left} x2={right} y1={y(0)} y2={y(0)} stroke="#6d8193" strokeDasharray="4 4" />
        {display.spectrumLines && <g className="spectrum-guides" aria-label="Robust median-anchor natural cubic spline, visual guide only" pointerEvents="none">{guides.map(({ curve, release }, i) => <path key={i} d={curve.map((p, j) => `${j ? 'L' : 'M'}${x(p.wavelength)},${y(p.flux)}`).join(' ')} fill="none" stroke="#ff626b" strokeWidth="1.6" strokeDasharray={release === 'qr3' ? '5 3' : undefined} />)}</g>}
        {points.map((p, i) => <g key={`${p.obs_id}-${p.detector}`} stroke={DETECTOR_COLORS[p.detector - 1]} onPointerEnter={() => setActive(i)}>
          <title>{`${p.release?.toUpperCase() || "Unknown release"} · D${p.detector} · ${number(p.wavelength)} µm · ${number(frequencyTHz(p.wavelength))} THz\nFν ${number(p.flux)} ± ${number(p.error)} µJy\nUsable aperture area: ${number(p.aperture_coverage * 100)}%${p.partial ? "; partial flux, missing pixels not recovered" : "; complete"}\nCBAND ${number(p.bandwidth)} µm; aperture λ ${number(p.lambda_min)}–${number(p.lambda_max)} µm\nMJD ${p.mjd.toFixed(6)} UTC · ${p.obs_id}`}</title>
          <line x1={x(p.wavelength)} x2={x(p.wavelength)} y1={y(p.flux - p.error)} y2={y(p.flux + p.error)} opacity=".65" />
          <line x1={x(p.lambda_min)} x2={x(p.lambda_max)} y1={y(p.flux)} y2={y(p.flux)} opacity=".35" />
          <circle cx={x(p.wavelength)} cy={y(p.flux)} r={p === peak ? 4 : 2.8} fill={p.partial ? '#101b27' : DETECTOR_COLORS[p.detector - 1]} stroke={p === peak ? '#fff' : DETECTOR_COLORS[p.detector - 1]} />
        </g>)}
        <text x={(left + right) / 2} y="282" textAnchor="middle" fill="#e0e9f2" fontSize="13">{frequency ? 'Frequency (THz)' : 'Wavelength (µm)'}</text>
        <text transform="translate(18 132) rotate(-90)" textAnchor="middle" fill="#e0e9f2" fontSize="13">Aperture flux density Fν (µJy)</text>
      </svg>
      {!points.length && <div className="spectrum-empty">{recipe?.include_spectra === false ? 'Images-only result. Enable Precompute aperture spectra and rebuild to explore measurements.' : sky ? epoch?.spectra?.length ? 'No measurements for this selection. Try usable pixels or another background choice; missing pixels and unavailable sky estimates are never filled.' : 'No precomputed aperture samples in this result. Rebuild coadds; inspect input provenance if calibration is unavailable.' : 'Hover any detector or the RGB tile to explore. Click to pin a spectrum.'}</div>}
    </div>
    <div className="spectrum-summary"><div className="spectrum-detectors">{DETECTOR_COLORS.map((c, i) => <span key={i} style={{ color: c }}>● D{i + 1}: {points.filter(p => p.detector === i + 1).length}</span>)}</div><strong>{peak ? `${availability.partial ? "Largest plotted Fν (partial apertures included)" : "Highest measured Fν"}: ${number(peak.flux)} ± ${number(peak.error)} µJy at ${number(peak.wavelength)} µm (${number(frequencyTHz(peak.wavelength))} THz)` : 'No measured peak'}</strong></div>
    {selected && <p className="spectral-point">{selected.release?.toUpperCase()} · D{selected.detector} · {number(selected.wavelength)} µm · {number(selected.flux)} ± {number(selected.error)} µJy · CBAND {number(selected.bandwidth)} µm · MJD {selected.mjd.toFixed(5)} UTC · {number(selected.aperture_coverage * 100)}% usable aperture area{selected.partial ? " · partial flux" : ""}</p>}
    <p className="spectrum-note"><strong>{subtractSky ? "Local annulus subtracted." : recipe?.background === "zodi" ? "ZODI model subtracted; local sky remains." : "No background subtraction; sky remains."}</strong> r = {recipe?.aperture_radius_arcsec ?? 12.4}″; source-masked sky annulus {1.5 * (recipe?.aperture_radius_arcsec ?? 12.4)}–{2.5 * (recipe?.aperture_radius_arcsec ?? 12.4)}″. All usable sampled wavelengths in this epoch. Red guides: independent per release (DR1 solid, QR3 dashed), using median-anchor cubic splines for display only; it can overshoot and large wavelength gaps stay open. Filled dots: complete apertures; open dots: partial flux, without correction for missing pixels. Bars: formal 1σ and aperture wavelength range. Native PSFs, no aperture correction; samples are not simultaneous. Hover previews temporarily; leaving the image restores the pin.</p>
    {failures > 0 && <p className="spectral-warning">{failures} accepted coadd exposures lack aperture calibration. Inspect input provenance.</p>}
  </section>;
}
