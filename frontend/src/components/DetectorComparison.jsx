import { useEffect, useMemo, useRef, useState } from 'react';
import { pixelToWorld, worldToPixel } from '../lib/render.js';
import { DETECTORS, NOMINAL_RANGES, LAYERS, readState, recipeFromForm, stateHash, decodeResult, layerArray, pooledLimits, displayFraction, screenToImage, imageToScreen, sampleAt, zoomAt } from '../lib/comparison.js';
import { COLOR_METHOD, colorFrame, colorPixel, colorDescription, pairSample } from '../lib/color.js';
import { wavelengthFrame, wavelengthPixel, wavelengthDescription, wavelengthProvenance } from '../lib/wavelength.js';
import ExpandedDetector from './ExpandedDetector.jsx';
import '../comparison.css';

const fmt = (x, digits = 5) => Number.isFinite(x) ? Number(x.toPrecision(digits)).toString() : '—';
const date = x => Number.isFinite(x) ? new Date((x - 40587) * 86400000).toISOString().slice(0, 16).replace('T', ' ') : '—';
const COLORS = ['#8cc9ff', '#78d8de', '#a6dcac', '#ebd68c', '#eab082', '#e98d99'];

function WavelengthKey({ strength }) {
  const stops = Array.from({ length: 65 }, (_, i) => `rgb(${wavelengthPixel(.55, .75 + 4.25 * i / 64, 1, 'linear', strength).join(',')}) ${100 * i / 64}%`);
  return <div className="wavelength-key" aria-label="Wavelength color key, 0.75 to 5 micrometers">
    <div className="wavelength-ramp" style={{ background: `linear-gradient(to right, ${stops.join(',')})` }} />
    <div className="wavelength-ticks">{[.75, 1, 2, 3, 4, 5].map(x => <span key={x} style={{ left: `${100 * (x - .75) / 4.25}%` }}>{x === .75 ? '≤0.75' : x === 1 ? '' : x === 5 ? '≥5.00 µm' : x.toFixed(1)}</span>)}</div>
  </div>;
}

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : Array.isArray(data.detail) ? data.detail.map(e => `${e.loc.at(-1)}: ${e.msg}`).join('; ') : `Request failed (${response.status})`);
  return data;
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderTile(canvas, tile, values, result, display, limits, pin, hover, color = null, colorWhite = 1) {
  const n = result.width, side = canvas.width, ctx = canvas.getContext('2d');
  ctx.fillStyle = '#101820'; ctx.fillRect(0, 0, side, side);
  if (!values && !color) return;
  const off = document.createElement('canvas'); off.width = n; off.height = n;
  const pixels = off.getContext('2d').createImageData(n, n);
  const activeValues = color ? color.brightness : values;
  for (let i = 0; i < activeValues.length; i++) {
    let level;
    if (!Number.isFinite(activeValues[i]) || tile.arrays?.coverage[i] === 0) {
      const hatch = (Math.floor(i / n) + i % n) % 6 < 2;
      pixels.data.set(hatch ? [55, 64, 74, 255] : [20, 29, 38, 255], i * 4);
      continue;
    }
    if (color) {
      const rgb = display.mode === 'wavelength'
        ? wavelengthPixel(color.brightness[i], color.wavelength[i], colorWhite, display.stretch, display.wavelengthStrength)
        : colorPixel(color.brightness[i], color.contrast[i], color.colored[i], colorWhite, display.stretch, display.colorStrength);
      pixels.data.set([...rgb, 255], i * 4);
      continue;
    }
    level = displayFraction(values[i], ...limits, display.stretch);
    if (display.invert) level = 1 - level;
    const v = Math.round(level * 255); pixels.data.set([v, v, v, 255], i * 4);
  }
  off.getContext('2d').putImageData(pixels, 0, 0);
  const extent = side * display.zoom;
  const [left, top] = imageToScreen(0, 0, side, n, display);
  ctx.imageSmoothingEnabled = display.smooth;
  ctx.drawImage(off, left, top, extent, extent);
  const marker = (sky, color, ring) => {
    const xy = sky && worldToPixel(result.wcs, sky.ra, sky.dec);
    if (!xy) return;
    const [x, y] = imageToScreen(...xy, side, n, display);
    ctx.strokeStyle = '#07101b'; ctx.lineWidth = 5;
    for (const stroke of [true, false]) {
      if (!stroke) { ctx.strokeStyle = color; ctx.lineWidth = 2; }
      ctx.beginPath();
      if (ring) ctx.arc(x, y, 10, 0, 2 * Math.PI);
      else { ctx.moveTo(x - 12, y); ctx.lineTo(x + 12, y); ctx.moveTo(x, y - 12); ctx.lineTo(x, y + 12); }
      ctx.stroke();
    }
  };
  marker(pin, '#ffd583', true); marker(hover, '#88d7f0', false);
  ctx.fillStyle = '#08121cbb'; ctx.fillRect(8, side - 43, 150, 33);
  ctx.fillStyle = '#ecf2f7'; ctx.font = '16px sans-serif';
  const scaleArcsec = result.recipe.pixscale_arcsec * n / (display.zoom * 4);
  ctx.fillText(`${fmt(scaleArcsec, 3)}″`, 16, side - 19);
  ctx.strokeStyle = '#eaf2f7'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(side - 20 - side / 4, side - 23); ctx.lineTo(side - 20, side - 23); ctx.stroke();
  ctx.fillStyle = '#07101bcc'; ctx.fillRect(8, 8, 77, 26);
  ctx.fillStyle = '#eaf2f7'; ctx.fillText('N ↑  E ←', 14, 27);
}

function Tile({ tile, values, result, display, setDisplay, limits, pin, setPin, hover, setHover, selected, setSelected, color, colorWhite, referenceAvailable, onExpand, expanded = false }) {
  const canvas = useRef(null), drag = useRef(null);
  const side = expanded ? 1200 : 600;
  useEffect(() => { if (canvas.current && result) renderTile(canvas.current, tile, values, result, display, limits, pin, hover, color, colorWhite); }, [tile, values, result, display, limits, pin, hover, color, colorWhite]);
  useEffect(() => {
    const node = canvas.current;
    const wheel = event => {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      setDisplay(v => zoomAt(v, Math.exp(-Math.max(-200, Math.min(200, delta)) * .003), (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height));
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [setDisplay]);
  const position = event => {
    const rect = canvas.current.getBoundingClientRect();
    return [(event.clientX - rect.left) * side / rect.width, (event.clientY - rect.top) * side / rect.height];
  };
  const imagePosition = event => screenToImage(...position(event), side, result.width, display);
  const choosePin = xy => {
    if (!xy || xy[0] < 0 || xy[1] < 0 || xy[0] >= result.width || xy[1] >= result.height) return;
    const [ra, dec] = pixelToWorld(result.wcs, ...xy); setPin({ ra, dec });
  };
  const pointerMove = event => {
    if (drag.current) {
      const xy = position(event), d = drag.current;
      if (Math.hypot(xy[0] - d.x, xy[1] - d.y) > side / 150) d.moved = true;
      if (d.moved) setDisplay(v => ({ ...v, panX: Math.max(-1, Math.min(1, d.panX + (xy[0] - d.x) / (side * d.zoom))), panY: Math.max(-1, Math.min(1, d.panY + (xy[1] - d.y) / (side * d.zoom))) }));
    } else {
      const xy = imagePosition(event);
      if (xy[0] >= 0 && xy[1] >= 0 && xy[0] < result.width && xy[1] < result.height) {
        const [ra, dec] = pixelToWorld(result.wcs, ...xy); setHover({ ra, dec });
      } else setHover(null);
    }
  };
  return <article className={`detector-tile ${expanded ? 'expanded-tile' : ''} ${selected === tile.detector ? 'selected' : ''}`} style={{ '--detector-color': COLORS[tile.detector - 1] }}>
    <div className="detector-topline">
    <button className="detector-heading" onClick={() => setSelected(tile.detector)} aria-pressed={selected === tile.detector} aria-label={`Select D${tile.detector} details`}>
      <span><strong>D{tile.detector}</strong><small>≈ {NOMINAL_RANGES[tile.detector - 1]} µm</small></span>
      <span className="detector-key" aria-label={`Detector ${tile.detector} of 6`}>{DETECTORS.map(d => <i key={d} className={d === tile.detector ? 'active' : ''}>{d}</i>)}</span>
    </button>
    {!expanded && <button className="expand-tile" aria-label={`Expand D${tile.detector}`} title={`Expand D${tile.detector}; browse all six detectors`} onClick={event => onExpand(tile.detector, event.currentTarget)}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M7 2H2v5m11-5h5v5M2 13v5h5m11-5v5h-5" /></svg><span>Expand</span></button>}
    </div>
    {display.mode === 'color' && <div className="tile-color-key">{tile.detector === display.reference ? <span>Reference control · unscaled grayscale</span> : <><span className="warm-text">D{tile.detector} target</span><span className="cool-text">D{display.reference} × {fmt(display.referenceGain, 3)}</span></>}</div>}
    {display.mode === 'wavelength' && <div className="tile-color-key">Hue: mean sampled λ · shared intensity scale</div>}
    <div className="detector-image">
      <canvas ref={canvas} width={side} height={side} tabIndex={0} aria-label={`D${tile.detector} ${display.mode === 'color' ? `color comparison against D${display.reference}` : display.mode === 'wavelength' ? 'wavelength color' : LAYERS[display.layer][0]} image. Click to pin; drag to pan; wheel to zoom; Enter pins the view center.`}
        onPointerDown={event => { const [x, y] = position(event); drag.current = { x, y, moved: false, ...display }; canvas.current.setPointerCapture(event.pointerId); setSelected(tile.detector); }}
        onPointerMove={pointerMove} onPointerUp={event => { if (!drag.current?.moved) choosePin(imagePosition(event)); drag.current = null; canvas.current.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { drag.current = null; }} onPointerLeave={() => { if (!drag.current) setHover(null); }}
        onDoubleClick={event => { const [x, y] = position(event); setDisplay(v => zoomAt(v, event.shiftKey ? .5 : 2, x / side, y / side)); }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); choosePin(screenToImage(side / 2, side / 2, side, result.width, display)); } }} />
      {tile.status !== 'ok' && <div className="detector-empty"><strong>{tile.status === 'missing' ? 'No observations in this epoch' : 'No usable coadd'}</strong><span>{tile.n_accepted ? `Coverage below ${result.recipe.min_exposures} exposures per pixel` : Object.keys(tile.failures).join(' · ').replaceAll('_', ' ') || 'This detector remains empty'}</span></div>}
      {tile.status === 'ok' && display.mode === 'color' && !referenceAvailable && <div className="detector-empty"><strong>Reference D{display.reference} unavailable</strong><span>Select another reference or use grayscale to inspect D{tile.detector}.</span></div>}
    </div>
    <footer><span>{tile.n_accepted} / {tile.n_selected} exposures used{tile.n_selected < tile.n_inventory ? ' · subset' : ''}</span><span>{date(tile.mjd_start)}{tile.mjd_end > tile.mjd_start ? ` → ${date(tile.mjd_end)}` : ''} UTC</span></footer>
  </article>;
}

export default function DetectorComparison() {
  const initial = useRef(readState(window.location.hash)).current;
  const [form, setForm] = useState(initial.form), [display, setDisplay] = useState(initial.display);
  const [result, setResult] = useState(null), [resultForm, setResultForm] = useState(null);
  const [epoch, setEpoch] = useState(initial.epoch), [pin, setPin] = useState(initial.pin), [hover, setHover] = useState(null);
  const [selected, setSelected] = useState(1), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(1000), [completeOnly, setCompleteOnly] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const expandOpener = useRef(null);
  const [busy, setBusy] = useState(false), [status, setStatus] = useState('Choose a target to build all six detector coadds.'), [error, setError] = useState('');
  const [jobId, setJobId] = useState(null), [resultJobId, setResultJobId] = useState(null);
  const generation = useRef(0), mounted = useRef(true), booted = useRef(false);
  const update = (key, value) => setForm(f => ({ ...f, [key]: value }));
  const show = (key, value) => setDisplay(v => ({ ...v, [key]: value }));
  const pending = resultForm && JSON.stringify(form) !== JSON.stringify(resultForm);

  const build = async (event) => {
    event?.preventDefault();
    let recipe;
    try { recipe = recipeFromForm(form); } catch (e) { setError(e.message); return; }
    const snapshot = structuredClone(form), current = ++generation.current;
    setBusy(true); setPlaying(false); setError(''); setStatus('Starting comparison…');
    try {
      const started = await jsonRequest('/api/detector-comparison', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(recipe) });
      if (!mounted.current || current !== generation.current) return;
      setJobId(started.job_id);
      while (mounted.current && current === generation.current) {
        const job = await jsonRequest(`/api/detector-comparison/${started.job_id}`);
        if (!mounted.current || current !== generation.current) return;
        setStatus(job.message);
        if (job.status === 'complete') {
          const raw = await jsonRequest(`/api/detector-comparison/${started.job_id}/result`);
          if (!mounted.current || current !== generation.current) return;
          const decoded = decodeResult(raw);
          setResult(decoded); setResultForm(snapshot); setResultJobId(started.job_id);
          setEpoch(k => Math.min(k, Math.max(0, decoded.epochs.length - 1))); setHover(null);
          setStatus(`${decoded.epochs.length} epochs · ${decoded.inputs.filter(i => i.status === 'accepted').length}/${decoded.n_selected} exposures accepted`);
          break;
        }
        if (job.status === 'error') throw new Error(job.message);
        if (job.status === 'cancelled') { setStatus('Build cancelled.'); break; }
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
    } catch (e) { if (mounted.current && current === generation.current) { setError(e.message); setStatus('Build did not complete.'); } }
    finally { if (mounted.current && current === generation.current) { setBusy(false); setJobId(null); } }
  };
  useEffect(() => {
    mounted.current = true;
    if (!booted.current && initial.form.coords) { booted.current = true; build(); }
    return () => { mounted.current = false; generation.current++; };
  }, []);

  useEffect(() => { window.history.replaceState(null, '', stateHash(resultForm || form, display, epoch, pin)); }, [form, resultForm, display, epoch, pin]);
  const eligible = useMemo(() => result ? result.epochs.map((e, i) => !completeOnly || e.complete_six ? i : -1).filter(i => i >= 0) : [], [result, completeOnly]);
  const currentEpoch = result?.epochs[epoch];
  const next = delta => setEpoch(k => eligible.length ? eligible[(Math.max(0, eligible.indexOf(k)) + delta + eligible.length) % eligible.length] : k);
  useEffect(() => { if (eligible.length && !eligible.includes(epoch)) setEpoch(eligible[0]); if (!eligible.length) setPlaying(false); }, [eligible, epoch]);
  useEffect(() => { if (!playing || eligible.length < 2) return; const timer = setInterval(() => next(1), speed); return () => clearInterval(timer); }, [playing, speed, eligible]);
  useEffect(() => {
    const key = event => {
      if (event.defaultPrevented || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(event.target.tagName) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (expanded && (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.code === 'Space')) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); next(event.key === 'ArrowLeft' ? -1 : 1); }
      if (event.code === 'Space' && eligible.length > 1) { event.preventDefault(); setPlaying(v => !v); }
      if (event.key === '+' || event.key === '=') { event.preventDefault(); setDisplay(v => zoomAt(v, 1.4)); }
      if (event.key === '-' || event.key === '_') { event.preventDefault(); setDisplay(v => zoomAt(v, 1 / 1.4)); }
      if (event.key === '0') { event.preventDefault(); setDisplay(v => ({ ...v, zoom: 1, panX: 0, panY: 0 })); }
    };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, [eligible, expanded]);
  const layers = useMemo(() => result?.epochs.map(e => e.tiles.map(t => layerArray(t, display.layer))) || [], [result, display.layer]);
  const automatic = useMemo(() => pooledLimits(layers.flat(), display.layer), [layers, display.layer]);
  const lo = display.vmin === '' ? automatic[0] : Number(display.vmin), hi = display.vmax === '' ? automatic[1] : Number(display.vmax);
  const scaleValid = Number.isFinite(lo) && Number.isFinite(hi) && hi > lo;
  const limits = useMemo(() => scaleValid ? [lo, hi] : automatic, [lo, hi, scaleValid, automatic]);
  const colorFrames = useMemo(() => result && display.mode !== 'gray' ? result.epochs.map(e => e.tiles.map(t => display.mode === 'wavelength' ? wavelengthFrame(t, result.width * result.height) : colorFrame(t, e.tiles[display.reference - 1], display, result.width * result.height))) : [], [result, display.mode, display.reference, display.referenceGain, display.colorSigma]);
  const colorAutomatic = useMemo(() => pooledLimits(colorFrames.flat().map(f => f.brightness), 'intensity')[1], [colorFrames]);
  const whiteSetting = display.mode === 'wavelength' ? display.wavelengthWhite : display.colorWhite;
  const colorScaleValid = whiteSetting === '' || (Number.isFinite(Number(whiteSetting)) && Number(whiteSetting) > 0);
  const colorWhite = whiteSetting === '' || !colorScaleValid ? Math.max(colorAutomatic, 1e-6) : Number(whiteSetting);
  const referenceAvailable = currentEpoch?.tiles[display.reference - 1]?.status === 'ok';
  const chosenSky = pin || hover;
  const point = chosenSky && result ? worldToPixel(result.wcs, chosenSky.ra, chosenSky.dec) : null;
  const measurements = currentEpoch?.tiles.map(t => point ? sampleAt(t, ...point, result.width, result.height) : null);
  const pixelIndex = point && point[0] >= 0 && point[1] >= 0 && point[0] < result.width && point[1] < result.height ? Math.floor(point[1]) * result.width + Math.floor(point[0]) : null;
  const colorMeasurements = currentEpoch?.tiles.map(t => pixelIndex === null ? null : pairSample(t, currentEpoch.tiles[display.reference - 1], pixelIndex, display, t.detector === display.reference));
  const currentInputs = result?.inputs.filter(i => i.epoch === epoch && i.detector === selected) || [];
  const numeric = (key, label, props = {}) => <label>{label}<input type="number" step="any" {...props} value={form[key]} onChange={e => update(key, e.target.value)} /></label>;
  const modeSwitch = <div className="view-switch" role="group" aria-label="Comparison display">{[['gray', 'Grayscale'], ['color', 'Color comparison'], ['wavelength', 'Wavelength color']].map(([mode, label]) => <button key={mode} aria-pressed={display.mode === mode} onClick={() => show('mode', mode)}>{label}</button>)}</div>;
  const openExpanded = (detector, opener) => { expandOpener.current = opener; setSelected(detector); setPlaying(false); setHover(null); setExpanded(true); };
  const tileView = (tile, expandedTile = false) => <Tile key={tile.detector} {...{ tile, result, display, setDisplay, limits, pin, setPin, hover, setHover, selected, setSelected }} values={layers[epoch]?.[tile.detector - 1]} color={colorFrames[epoch]?.[tile.detector - 1]} colorWhite={colorWhite} referenceAvailable={referenceAvailable} onExpand={openExpanded} expanded={expandedTile} />;

  const exportFigure = () => {
    const canvas = document.createElement('canvas'); canvas.width = 1800; canvas.height = 1590;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#07101a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#eef3f8'; ctx.font = 'bold 30px sans-serif'; ctx.fillText(`SpherexMultiView · ${display.mode === 'color' ? 'color comparison' : display.mode === 'wavelength' ? 'wavelength color' : 'six detectors'} · epoch ${epoch + 1}`, 28, 44);
    ctx.font = '18px sans-serif'; ctx.fillText(`${result.recipe.ra.toFixed(6)}°, ${result.recipe.dec.toFixed(6)}° ICRS  |  ${currentEpoch.datetime_start} — ${currentEpoch.datetime_end} UTC`, 28, 78);
    currentEpoch.tiles.forEach((tile, i) => {
      const x = 28 + (i % 3) * 590, y = 115 + Math.floor(i / 3) * 635;
      ctx.fillStyle = COLORS[i]; ctx.font = 'bold 24px sans-serif'; ctx.fillText(`D${i + 1} · ≈ ${NOMINAL_RANGES[i]} µm`, x, y);
      const tileCanvas = document.createElement('canvas'); tileCanvas.width = tileCanvas.height = 560;
      renderTile(tileCanvas, tile, layers[epoch][i], result, display, limits, pin, null, colorFrames[epoch]?.[i], colorWhite);
      ctx.drawImage(tileCanvas, x, y + 14); ctx.fillStyle = '#d7e1ea'; ctx.font = '15px sans-serif';
      if (tile.status !== 'ok') ctx.fillText('NO USABLE DATA', x + 180, y + 290);
      ctx.fillText(`${tile.n_accepted}/${tile.n_selected} exposures · ${date(tile.mjd_start)} → ${date(tile.mjd_end)} UTC`, x, y + 598);
      if (display.mode === 'color') {
        ctx.fillStyle = '#f0c992';
        ctx.fillText(tile.detector === display.reference ? 'Reference control · unscaled grayscale' : `Orange: D${tile.detector} | Blue: D${display.reference} × ${fmt(display.referenceGain, 3)}`, x, y + 618);
        if (tile.status === 'ok' && !referenceAvailable) ctx.fillText('REFERENCE UNAVAILABLE', x + 150, y + 290);
      }
      if (display.mode === 'wavelength') ctx.fillText('Hue: mean sampled CWAVE wavelength', x, y + 618);
    });
    ctx.font = '18px sans-serif'; ctx.fillStyle = '#eef3f8';
    if (display.mode === 'color') {
      ctx.fillText(`Two-channel color · ${display.stretch} · shared brightness: 0 to ${fmt(colorWhite)} MJy/sr · strength ${fmt(display.colorStrength)}`, 28, 1405);
      ctx.font = '16px sans-serif';
      ctx.fillText(`Orange: target stronger | Blue: reference stronger | Neutral: equal or below ${display.colorSigma} formal σ | k = ${display.referenceGain}`, 28, 1440);
      for (let x = 0; x < 450; x++) { const rgb = colorPixel(colorWhite, 2 * x / 449 - 1, true, colorWhite, display.stretch, display.colorStrength); ctx.fillStyle = `rgb(${rgb.join(',')})`; ctx.fillRect(1260 + x, 1390, 1, 18); }
    } else if (display.mode === 'wavelength') {
      ctx.fillText(`Wavelength color · ${display.stretch} · shared brightness: 0 to ${fmt(colorWhite)} MJy/sr · strength ${fmt(display.wavelengthStrength)}`, 28, 1405);
      ctx.font = '16px sans-serif'; ctx.fillText('Hue: coadd-weighted mean CWAVE; mixed wavelengths are summarized, not spectrally resolved.', 28, 1440);
      for (let x = 0; x < 450; x++) { const rgb = wavelengthPixel(.55, .75 + 4.25 * x / 449, 1, 'linear', display.wavelengthStrength); ctx.fillStyle = `rgb(${rgb.join(',')})`; ctx.fillRect(1260 + x, 1420, 1, 18); }
      ctx.fillStyle = '#eef3f8'; ctx.fillText('≤0.75', 1260, 1460); ctx.fillText('2', 1385, 1460); ctx.fillText('3', 1490, 1460); ctx.fillText('4', 1596, 1460); ctx.fillText('≥5.00 µm', 1705, 1460);
    } else {
      ctx.fillText(`${LAYERS[display.layer][0]} · shared ${display.stretch} scale: ${fmt(limits[0])} to ${fmt(limits[1])} ${LAYERS[display.layer][1]}`, 28, 1405);
      for (let x = 0; x < 450; x++) { const v = Math.round(255 * (display.invert ? 1 - x / 449 : x / 449)); ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(1260 + x, 1420, 1, 18); }
    }
    ctx.fillStyle = '#bfcfdb'; ctx.font = '16px sans-serif';
    ctx.fillText(`Mixed wavelength · native PSF · ${result.recipe.background} background · ${result.recipe.weighting} weights · ${result.recipe.resampling} · ${result.recipe.pixscale_arcsec}″/pixel${result.preview_subset ? ' · PREVIEW SUBSET' : ''}`, 28, 1480);
    ctx.fillText(`Hatching: missing / masked / insufficient coverage in ${display.mode === 'color' ? 'either channel' : 'the detector'}. ${display.smooth ? 'Display smoothing enabled. ' : ''}Zoom ${fmt(display.zoom, 3)}×.`, 28, 1515);
    ctx.fillText(display.mode === 'color' ? 'Visual comparison; PSF and spectral/time sampling can create color. Nonpositive values clip to zero for display only. Not a calibrated excess.' : display.mode === 'wavelength' ? 'False color shows wavelength sampling, not a source spectrum. Negative values display as black; bright highlights desaturate to white.' : 'Scientific arrays and provenance remain in the accompanying FITS and JSON exports.', 28, 1550);
    canvas.toBlob(blob => saveBlob(blob, `SpherexMultiView-${display.mode}-epoch-${epoch + 1}.png`));
    const epochMetadata = { ...currentEpoch, tiles: currentEpoch.tiles.map(({ maps, arrays, ...metadata }) => metadata) };
    saveBlob(new Blob([JSON.stringify({ ...result, application: 'SpherexMultiView', application_version: '0.2.0', epochs: [epochMetadata], display: { ...display, actual_limits: limits, color_method: display.mode === 'color' ? COLOR_METHOD : null, color_white: display.mode === 'color' ? colorWhite : null, color_legend: display.mode === 'color' ? colorDescription(display) : null, wavelength_color: display.mode === 'wavelength' ? wavelengthProvenance(display, colorWhite) : null }, epoch: currentEpoch.index, pin, job_id: resultJobId }, null, 2)], { type: 'application/json' }), `SpherexMultiView-${display.mode}-epoch-${epoch + 1}.json`);
  };

  return <div className="compare-page" data-mode={display.mode}>
    <header className="compare-header"><div><a href="index.html" className="compare-brand">SpherexMultiView</a><h1>Six-detector comparison</h1></div><span className="comparison-tag">QR2 · ICRS</span></header>
    <div className="compare-layout">
      <main className="compare-main">
        <section className="compare-toolbar" aria-label="Epoch playback">
          <div className="epoch-buttons"><button disabled={!eligible.length} onClick={() => next(-1)} aria-label="Previous epoch">←</button><button disabled={eligible.length < 2} onClick={() => setPlaying(v => !v)}>{playing ? 'Pause' : 'Play'}</button><button disabled={!eligible.length} onClick={() => next(1)} aria-label="Next epoch">→</button></div>
          <label className="epoch-slider">Epoch {result ? epoch + 1 : '—'} / {result?.epochs.length || '—'}<input aria-label="Epoch" type="range" min="0" max={Math.max(0, eligible.length - 1)} value={Math.max(0, eligible.indexOf(epoch))} disabled={eligible.length < 2} onChange={e => { setPlaying(false); setEpoch(eligible[Number(e.target.value)]); }} /></label>
          <label>Interval<select value={speed} onChange={e => setSpeed(Number(e.target.value))}><option value={500}>0.5 s</option><option value={1000}>1 s</option><option value={2000}>2 s</option></select></label>
          <label className="compare-check"><input type="checkbox" checked={completeOnly} onChange={e => setCompleteOnly(e.target.checked)} />Complete six only</label>
        </section>
        <section className="view-toolbar" aria-label="Comparison display options">{modeSwitch}</section>
        <div className="compare-status" role="status">{busy && <span className="comparison-spinner" />}{status}{result?.preview_subset && <strong className="subset-badge">Preview subset</strong>}</div>
        {error && <div className="compare-error" role="alert">{error}</div>}
        {pending && <p className="compare-pending">Recipe changes pending. The displayed coadds and exports still use the last completed build.</p>}
        {currentEpoch && <div className="epoch-caption"><strong>{currentEpoch.datetime_start.slice(0, 10)} — {currentEpoch.datetime_end.slice(0, 10)}</strong><span>{currentEpoch.grouping} · UTC · actual detector times below each tile</span></div>}
        {result && completeOnly && !eligible.length ? <div className="compare-placeholder">No epoch has usable data in all six detectors. Disable “Complete six only” to inspect available data.</div> : result ? <div className="detector-grid">{currentEpoch.tiles.map(tile => tileView(tile))}</div> : <div className="detector-grid empty-grid">{DETECTORS.map(d => <article className="detector-tile" key={d} style={{ '--detector-color': COLORS[d - 1] }}><div className="detector-heading"><strong>D{d}</strong><small>≈ {NOMINAL_RANGES[d - 1]} µm</small></div><div className="compare-placeholder">{busy ? 'Building calibrated coadds…' : 'Awaiting target'}</div></article>)}</div>}
        {display.mode === 'gray' ? <section className="compare-scale" aria-label="Shared intensity scale"><span>{fmt(limits[0])}</span><div className={display.invert ? 'inverse' : ''} /><span>{fmt(limits[1])} {LAYERS[display.layer][1]}</span><small>{display.stretch} · shared across every detector and epoch</small></section> : display.mode === 'wavelength' ? <section className="wavelength-legend" aria-label="Wavelength color meaning"><WavelengthKey strength={display.wavelengthStrength} /><p>{wavelengthDescription}</p><p>Shared brightness: 0–{fmt(colorWhite)} MJy/sr · {display.stretch}. Bright highlights become white. Inspect the wavelength span in the readout for mixed samples.</p></section> : <section className="color-legend" aria-label="Color meaning"><div><span className="cool-text">Reference stronger</span><div className="color-ramp" style={{ background: `linear-gradient(to right, rgb(${colorPixel(colorWhite, -1, true, colorWhite, display.stretch, display.colorStrength).join(',')}), white, rgb(${colorPixel(colorWhite, 1, true, colorWhite, display.stretch, display.colorStrength).join(',')}))` }} /><span className="warm-text">Target stronger</span></div><p>{colorDescription(display)}</p><p>Shared brightness: 0–{fmt(colorWhite)} MJy/sr · {display.stretch} · native PSFs. Colors identify candidates to inspect; PSF, background and wavelength/time sampling differences also affect color.</p></section>}
        <p className="compare-help">Expand a tile to browse D1–D6 at full size · wheel or double-click to magnify · drag to pan · click to pin · arrows change epoch in the grid · hatching marks unavailable samples.</p>
        {result && <section className="source-readout"><div className="source-title"><h2>{pin ? 'Pinned source' : hover ? 'Cursor position' : 'Linked source readout'}</h2>{chosenSky && <span>{chosenSky.ra.toFixed(7)}°, {chosenSky.dec.toFixed(7)}° ICRS</span>}{pin && <button onClick={() => setPin(null)}>Clear pin</button>}</div>
          <div className="readout-scroll"><table><thead><tr><th>Detector</th><th>I (MJy/sr)</th><th>Formal σ</th><th>Exposures</th><th>λ mean [min–max], µm</th><th>Bandwidth, µm</th><th>Time range, MJD UTC</th>{display.mode === 'color' && <><th>ΔI vs ref (MJy/sr)</th><th>ΔI / formal σΔ</th></>}</tr></thead><tbody>{DETECTORS.map((d, i) => { const m = measurements?.[i]; return <tr key={d}><th>D{d}</th><td>{fmt(m?.intensity)}</td><td>{fmt(m?.variance >= 0 ? Math.sqrt(m.variance) : NaN)}</td><td>{fmt(m?.coverage)}</td><td>{m ? `${fmt(m.wavelength)} [${fmt(m.lambda_min)}–${fmt(m.lambda_max)}]` : '—'}</td><td>{fmt(m?.bandwidth)}</td><td>{m ? `${fmt(m.mjd_min, 10)}–${fmt(m.mjd_max, 10)}` : '—'}</td>{display.mode === 'color' && <><td>{fmt(colorMeasurements?.[i]?.difference)}</td><td>{fmt(colorMeasurements?.[i]?.z)}</td></>}</tr>; })}</tbody></table></div>
          <p>Readouts use the unsmoothed coadd pixel under the pin. Formal σ excludes calibration, foreground-model and input covariance errors. {display.mode === 'color' && 'ΔI uses the signed values and the reference multiplier; its formal error assumes independent detector noise. It is not a source-detection significance.'}</p>
          <button disabled={!pin} onClick={() => window.open(`spectrum.html#${new URLSearchParams({ ra: pin.ra, dec: pin.dec })}`, '_blank', 'noopener')}>Generate spectrum at pin</button>
        </section>}
      </main>
      <aside className="compare-sidebar">
        {display.mode === 'wavelength' && <fieldset className="wavelength-options"><legend>Wavelength color</legend>
          <p>Inspired by SPHEREx’s first-light image: violet for short infrared wavelengths through red for long wavelengths. Each pixel uses its calibrated mean sampled wavelength.</p>
          <label>Wavelength color strength · {Math.round(display.wavelengthStrength * 100)}%<input aria-label="Wavelength color strength" type="range" min="0" max="1" step=".05" value={display.wavelengthStrength} onChange={e => show('wavelengthStrength', Number(e.target.value))} /></label>
          <label>Wavelength white scale (MJy/sr)<input type="number" min="0" step="any" value={display.wavelengthWhite} placeholder={fmt(colorAutomatic)} onChange={e => show('wavelengthWhite', e.target.value)} /></label>
          {!colorScaleValid && <p role="alert">Enter a positive white scale. Showing the pooled automatic scale.</p>}
          <button onClick={() => show('wavelengthWhite', '')}>Automatic wavelength brightness</button>
          <p>The same intensity scale applies to all six detectors and every epoch. Hue shows the wavelengths sampled by the coadd; it does not identify an emission line or measure a source’s spectrum. Missing wavelength calibration is hatched.</p>
          <a href="https://spherex.caltech.edu/image/spherex20250401b-spherex-first-images" target="_blank" rel="noreferrer">SPHEREx first-light color explanation ↗</a>
        </fieldset>}
        {display.mode === 'color' && <fieldset className="color-options"><legend>Color comparison</legend>
          <label>Reference detector<select value={display.reference} onChange={e => show('reference', Number(e.target.value))}>{DETECTORS.map(d => <option key={d} value={d}>D{d} · ≈ {NOMINAL_RANGES[d - 1]} µm</option>)}</select></label>
          <label>Reference multiplier k · {fmt(display.referenceGain, 3)}<input aria-label="Reference multiplier" type="range" min="-2" max="2" step=".01" value={Math.log10(display.referenceGain)} onChange={e => show('referenceGain', Number((10 ** Number(e.target.value)).toPrecision(4)))} /></label><button onClick={() => show('referenceGain', 1)}>Reset reference to ×1</button>
          <label>Color threshold · {display.colorSigma} formal σ<input aria-label="Color threshold" type="range" min="0" max="10" step=".5" value={display.colorSigma} onChange={e => show('colorSigma', Number(e.target.value))} /></label>
          <label>Color strength · {Math.round(display.colorStrength * 100)}%<input aria-label="Color strength" type="range" min="0" max="1" step=".05" value={display.colorStrength} onChange={e => show('colorStrength', Number(e.target.value))} /></label>
          <label>Color white scale (MJy/sr)<input type="number" min="0" step="any" value={display.colorWhite} placeholder={fmt(colorAutomatic)} onChange={e => show('colorWhite', e.target.value)} /></label>
          {!colorScaleValid && <p role="alert">Enter a positive white scale. Showing the pooled automatic scale.</p>}
          <button onClick={() => show('colorWhite', '')}>Automatic color brightness</button>
          <p>Orange means brighter in that tile’s detector; blue means brighter in the selected reference. The same gain and scale apply to every epoch. The reference tile stays neutral at its original brightness. Colors require valid samples in both detectors.</p>
          <p>Negative values stay in FITS and readouts; only the color image clips them to zero. The threshold suppresses noisy color but excludes PSF and calibration errors.</p>
        </fieldset>}
        <form onSubmit={build}><fieldset disabled={busy}><legend>Target &amp; coadd recipe</legend>
          <label>RA, Dec · ICRS degrees<input value={form.coords} onChange={e => update('coords', e.target.value)} placeholder="304.693509 42.443687" required /></label>
          <div className="compare-two">{numeric('size_arcsec', 'Field width (arcsec)', { min: 24, max: 1800 })}<label>Survey<select value={form.survey} onChange={e => update('survey', e.target.value)}><option value="wide">Wide</option><option value="deep">Deep</option></select></label></div>
          <div className="compare-two"><label>Epoch grouping<select value={form.grouping} onChange={e => update('grouping', e.target.value)}><option value="visit">Sky-pass visits</option><option value="fixed">Fixed MJD bins</option></select></label>{numeric('bin_months', 'Maximum span (months)', { min: .1, max: 12 })}</div>
          {form.grouping === 'fixed' && numeric('epoch_origin_mjd', 'Bin origin (MJD UTC)')}
          <details><summary>Time selection &amp; depth</summary><div className="compare-two">{numeric('mjd_start', 'Start MJD (inclusive)')}{numeric('mjd_end', 'End MJD (exclusive)')}</div>{numeric('max_per_tile', 'Max exposures per tile (0 = all)', { min: 0, max: 10000, step: 1 })}{numeric('min_exposures', 'Minimum exposures per pixel', { min: 1, max: 10000, step: 1 })}<p>Epoch membership is fixed before downloads. A cap selects a declared time-spread preview within each detector and epoch.</p></details>
          <details><summary>Background, weights &amp; sampling</summary><label>Background<select value={form.background} onChange={e => update('background', e.target.value)}><option value="zodi">Subtract supplied ZODI model</option><option value="none">No subtraction</option></select></label><label>Sample weights<select value={form.weighting} onChange={e => update('weighting', e.target.value)}><option value="equal">Equal native-sample weights</option><option value="sky">Inverse source-free sky variance</option></select></label><label>Resampling<select value={form.resampling} onChange={e => update('resampling', e.target.value)}><option value="bin">Input-pixel binning</option><option value="nearest">Nearest neighbor</option></select></label>{numeric('pixscale_arcsec', 'Output pixel size (arcsec)', { min: 3.1, max: 24.8 })}<p>Finer pixels do not improve angular resolution. Binning may leave gaps; nearest neighbor can correlate output pixels. Source flags are preserved in the science image. Additional clipping is off.</p></details>
          <details><summary>Calibrated wavelength selection</summary><p>Optional input-pixel central-wavelength limits in µm, lower inclusive / upper exclusive. Empty pairs use full detector depth.</p><div className="wavelength-ranges">{DETECTORS.map(d => <div key={d}><strong>D{d}</strong>{['Lower', 'Upper'].map((label, i) => <input key={label} aria-label={`D${d} ${label} wavelength`} type="number" step="any" min="0" max="10" placeholder={label} value={form.ranges[d]?.[i] ?? ''} onChange={e => setForm(f => { const bounds = [...(f.ranges[d] || ['', ''])]; bounds[i] = e.target.value; return { ...f, ranges: { ...f.ranges, [d]: bounds } }; })} />)}</div>)}</div><p>CWAVE/CBAND calibration is required. A detector is never substituted when calibration or coverage is missing.</p></details>
          <button className="compare-primary" type="submit">{busy ? 'Building…' : 'Build coadds'}</button>
        </fieldset></form>
        {busy && <button className="compare-cancel" disabled={!jobId} onClick={async () => { try { await jsonRequest(`/api/detector-comparison/${jobId}`, { method: 'DELETE' }); setStatus('Cancelling after the current archive request…'); } catch (e) { setError(e.message); } }}>Cancel build</button>}
        <fieldset><legend>Shared display</legend><label>Grayscale layer<select disabled={display.mode !== 'gray'} value={display.layer} onChange={e => setDisplay(v => ({ ...v, layer: e.target.value, vmin: '', vmax: '' }))}>{Object.entries(LAYERS).map(([key, [label, unit]]) => <option key={key} value={key}>{label} ({unit})</option>)}</select></label>
          <label>Stretch<select value={display.stretch} onChange={e => show('stretch', e.target.value)}><option value="asinh">Signed asinh</option><option value="linear">Linear</option></select></label>
          <div className="compare-two"><label>Black limit<input type="number" step="any" disabled={display.mode !== 'gray'} value={display.vmin} placeholder={fmt(automatic[0])} onChange={e => show('vmin', e.target.value)} /></label><label>White limit<input type="number" step="any" disabled={display.mode !== 'gray'} value={display.vmax} placeholder={fmt(automatic[1])} onChange={e => show('vmax', e.target.value)} /></label></div>
          {display.mode === 'gray' && !scaleValid && <p role="alert" className="compare-error">White limit must exceed black limit. Showing the automatic shared range.</p>}
          <button disabled={display.mode !== 'gray'} onClick={() => setDisplay(v => ({ ...v, vmin: '', vmax: '' }))}>Reset to pooled range</button>
          <label>Linked zoom · {display.zoom.toFixed(1)}×<input aria-label="Linked zoom slider" type="range" min="0.5" max="16" step="0.1" value={display.zoom} onChange={e => show('zoom', Number(e.target.value))} /></label>
          <button onClick={() => setDisplay(v => ({ ...v, zoom: 1, panX: 0, panY: 0 }))}>Reset field of view</button>
          <label className="compare-check"><input type="checkbox" disabled={display.mode !== 'gray'} checked={display.invert} onChange={e => show('invert', e.target.checked)} />Invert grayscale</label><label className="compare-check"><input type="checkbox" checked={display.smooth} onChange={e => show('smooth', e.target.checked)} />Display smoothing</label><p>A shared scale is frozen across all loaded epochs; grayscale limits and inversion apply in grayscale mode. Display adjustments never rebuild or alter scientific arrays.</p>
        </fieldset>
        {result && <fieldset><legend>Export &amp; provenance</legend><button onClick={exportFigure}>Export six-panel PNG + settings</button><a className="compare-download" href={`/api/detector-comparison/${resultJobId}/epochs/${currentEpoch.index}.fits`}>Download epoch FITS</a><a className="compare-download" href={`/api/detector-comparison/${resultJobId}/manifest`}>Download full manifest</a><p>FITS includes intensity, variance, coverage, weights, wavelength/time maps, WCS and input provenance. PNG retains labels and display limits.</p><details><summary>D{selected} input provenance ({currentInputs.length})</summary><div className="comparison-inputs">{currentInputs.length ? currentInputs.map((input, i) => <article key={i}><a href={input.url} target="_blank" rel="noreferrer">{input.obs_id}</a><span>{input.status.replaceAll('_', ' ')}</span>{input.reason && <p>{input.reason}</p>}{input.pipeline_version && <small>Pipeline {input.pipeline_version} · PSF header: {input.psf_header_status.replaceAll('_', ' ')}</small>}</article>) : <p>No observations for D{selected} in this epoch.</p>}</div></details></fieldset>}
        <details className="comparison-science"><summary>Scientific interpretation</summary><p>Each tile averages the detector’s sampled LVF wavelengths. Different PSFs, depths and wavelength distributions affect source prominence. These images are inspection products; use exposure-level spectra for quantitative source comparisons.</p><p>PSFs are native and unmatched. A color fringe or bright core can reflect PSF mismatch. Detector coadds are not six fixed photometric filters, and color is not an object classification. Formal uncertainty is not a complete measurement error budget.</p><a href="https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/" target="_blank" rel="noreferrer">IRSA data-product documentation ↗</a></details>
      </aside>
    </div>
    {expanded && currentEpoch && <ExpandedDetector detector={selected} onSelect={d => { setSelected(d); setHover(null); }} onClose={() => { setExpanded(false); setHover(null); }} returnFocus={expandOpener.current} epochLabel={`Epoch ${epoch + 1} · ${currentEpoch.datetime_start.slice(0, 10)} — ${currentEpoch.datetime_end.slice(0, 10)} UTC`} modeSwitch={modeSwitch}>
      {tileView(currentEpoch.tiles[selected - 1], true)}
      {display.mode === 'wavelength' ? <div className="expanded-key"><WavelengthKey strength={display.wavelengthStrength} /><p>Hue: mean sampled CWAVE · brightness 0–{fmt(colorWhite)} MJy/sr · {display.stretch}</p></div> : <p className="expanded-scale">{display.mode === 'color' ? `${colorDescription(display)} Shared brightness 0–${fmt(colorWhite)} MJy/sr.` : `${LAYERS[display.layer][0]}: ${fmt(limits[0])}–${fmt(limits[1])} ${LAYERS[display.layer][1]} · ${display.stretch}`} · Zoom {fmt(display.zoom, 3)}×</p>}
    </ExpandedDetector>}
  </div>;
}
