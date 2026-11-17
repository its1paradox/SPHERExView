import { useEffect, useRef, useState } from 'react';
import { parseCoords } from './ControlPanel.jsx';
import { researchRequest, targetLink, formatBytes, persistResearch } from '../lib/research.js';
import '../dashboard.css';

const when = seconds => seconds ? new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not checked yet';
const tools = [['timeline', 'WISE–SPHEREx'], ['detectors', '6 detectors']];
const ageDays = seconds => seconds ? (Date.now() / 1000 - seconds) / 86400 : 0;

export default function ResearchDashboard() {
  const [history, setHistory] = useState({ targets: [], bytes: 0 });
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [coords, setCoords] = useState(''), [size, setSize] = useState('120'), [release, setRelease] = useState('all');
  const [filter, setFilter] = useState(''), [sort, setSort] = useState('recent');
  const [dialog, setDialog] = useState(null), [working, setWorking] = useState(false);
  const modal = useRef(null), opener = useRef(null);
  async function load() {
    try { setHistory(await researchRequest()); setError(''); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    load();
    const focus = () => load();
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, []);
  useEffect(() => {
    if (dialog) modal.current?.showModal();
    else { modal.current?.close(); opener.current?.focus(); }
  }, [dialog]);

  async function start(event) {
    event.preventDefault();
    const parsed = parseCoords(coords);
    if (!parsed || parsed.ra < 0 || parsed.ra >= 360 || parsed.dec < -90 || parsed.dec > 90) {
      setError('Enter RA from 0 to <360° and Dec from −90 to +90° in decimal degrees.'); return;
    }
    const width = Number(size);
    if (!Number.isFinite(width) || width < 24 || width > 240) { setError('Enter a field width between 24 and 240 arcsec.'); return; }
    setWorking(true); setError('');
    try {
      const target = await researchRequest('', {method:'POST', body:JSON.stringify({...parsed, size:width, survey:'wide', release})});
      window.location.assign(targetLink(target, event.nativeEvent.submitter?.value || 'timeline'));
    } catch (e) { setError(e.message); setWorking(false); }
  }

  function open(event, target, mode) { opener.current = event.currentTarget; setDialog({target, mode}); }
  async function act(action, tool) {
    setWorking(true); setError('');
    try {
      const id = dialog.target.id;
      if (action === 'refresh') {
        await researchRequest(`/${id}/refresh?tool=${tool}`, {method:'POST'});
        window.location.assign(`${targetLink(dialog.target, tool)}&refresh=${tool}`);
        return;
      }
      const result = await researchRequest(`/${id}${action === 'clear' ? '/cache' : ''}`, {method:'DELETE'});
      setNotice(`${formatBytes(result.freed_bytes)} freed. ${action === 'clear' ? 'Target kept; open either tool to rebuild its data.' : 'Target removed from your history.'}`);
      setDialog(null); await load();
    } catch (e) { setError(e.message); }
    finally { setWorking(false); }
  }
  const filtered = history.targets.filter(t => `${t.ra} ${t.dec} ${t.release}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const rows = [...filtered].sort((a, b) => sort === 'size' ? b.bytes - a.bytes : b.visited_at - a.visited_at);
  return <div className="research-dashboard">
    <header className="research-header"><a href="index.html" className="research-brand">SPHERExView <span>RESEARCH WORKSPACE</span></a><span className="research-private">This browser’s library</span></header>
    <main className="research-main">
      <section className="research-intro"><div><p className="research-eyebrow">OBSERVE · COMPARE · REVISIT</p><h1>Your research library</h1><p>Saved sky fields, scientific recipes and data. Pick up where you left off.</p></div><dl className="research-totals"><div><dt>Saved targets</dt><dd>{history.targets.length}</dd></div><div><dt>Stored on this device</dt><dd>{formatBytes(history.bytes)}</dd></div></dl></section>
      <section className="research-new" aria-labelledby="new-target-title"><div><h2 id="new-target-title">New target</h2><p>ICRS · decimal degrees</p></div><form onSubmit={start}>
        <label className="research-coordinates">RA, Dec<input aria-label="New target coordinates" placeholder="133.7599588 −7.2449993" value={coords} onChange={e => setCoords(e.target.value.replaceAll('−','-'))} required /></label>
        <label>Field width (arcsec)<input aria-label="New field width" type="number" min="24" max="240" step="any" value={size} onChange={e => setSize(e.target.value)} required /></label>
        <label>Data release<select value={release} onChange={e => setRelease(e.target.value)}><option value="all">DR1 + QR3</option><option value="dr1">DR1</option><option value="qr3">QR3</option></select></label>
        <div className="research-launch">{tools.map(([key, label]) => <button key={key} className={key === 'timeline' ? 'primary' : ''} type="submit" value={key} disabled={working}>Open {label} <span aria-hidden="true">↗</span></button>)}</div>
      </form></section>
      {error && !dialog && <p className="research-error" role="alert">{error}</p>}
      {notice && <p className="research-notice" role="status">{notice}</p>}
      <section aria-labelledby="saved-targets-title">
        <div className="research-list-header"><div><h2 id="saved-targets-title">Saved targets <span>{history.targets.length}</span></h2><p>Opening a saved recipe reuses its retained data. Refresh explicitly to check the archive.</p></div><div className="research-filter"><input aria-label="Filter saved targets" placeholder="Filter coordinates or release" value={filter} onChange={e => setFilter(e.target.value)} /><select aria-label="Sort targets" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">Recently visited</option><option value="size">Largest first</option></select><button onClick={load} aria-label="Reload history">↻</button></div></div>
        {loading ? <p role="status">Loading saved research…</p> : rows.length === 0 ? <div className="research-empty"><h3>{filter ? 'No matching targets' : 'Your next observation starts here'}</h3><p>{filter ? 'Try another coordinate or release.' : 'Enter a sky position above. Searches from either tool are saved here automatically.'}</p></div> : <div className="research-list">{rows.map(target => {
          const checked = Math.max(...Object.values(target.tools || {}).map(t => t.checked_at || 0), 0);
          const due = Object.values(target.tools || {}).some(t => ageDays(t.checked_at) >= 7);
          const partial = Object.values(target.tools || {}).some(t => t.status === 'incomplete');
          return <article className="research-row" key={target.id} aria-label={`Target ${target.ra} ${target.dec}`}>
            <div className="research-target"><div className="research-row-kicker">ICRS <span>{target.release === 'all' ? 'DR1 + QR3' : target.release.toUpperCase()}</span></div><h3><span>{target.ra}°</span> <span>{target.dec > 0 ? '+' : ''}{target.dec}°</span></h3><p>{target.size}″ field · {target.survey} survey</p><small>Visited {when(target.visited_at)}</small></div>
            <div className="research-retention"><strong>{formatBytes(target.bytes)}</strong><span>Retained data</span><details><summary>Storage breakdown</summary><dl>{[['responses','Timeline products'],['assets','Frame pixels'],['comparisons','Detector products'],['exports','FITS & manifests']].map(([key,label]) => <div key={key}><dt>{label}</dt><dd>{formatBytes(target.storage[key])}</dd></div>)}</dl></details></div>
            <div className="research-freshness"><span className={`research-badge ${target.busy ? 'processing' : due || partial ? 'due' : ''}`}>{target.busy ? 'Processing' : target.tools?.detectors?.pending ? 'Reopen to finish saving' : !target.bytes ? 'No cached files' : partial ? 'Partial data retained' : due ? 'Review for updates' : 'Data retained'}</span><small>Last archive check<br/>{when(checked)}</small><button disabled={target.busy || working} onClick={e => open(e, target, 'refresh')}>Refresh data</button></div>
            <div className="research-row-actions"><div>{tools.map(([key, label]) => <a key={key} className="research-tool" href={targetLink(target, key)}>{label} <span aria-hidden="true">↗</span></a>)}</div><button className="research-manage" disabled={target.busy || working} onClick={e => open(e, target, 'storage')}>Manage storage</button></div>
          </article>;
        })}</div>}
      </section>
      <footer className="research-footer"><p><strong>Saved on this device.</strong> Saved results and history live on this device. Totals measure saved result payloads, excluding browser database overhead. The server uses a bounded temporary cache for processing.</p><p>Review weekly for archive updates. A reminder does not mean new observations are available. Clearing site data removes local history and results. Browser storage may be evicted unless persistent storage is granted.</p><button onClick={async () => { try { const kept=await persistResearch(); setNotice(kept ? "Persistent storage enabled for this browser. Clearing site data still removes saved research." : "This browser did not grant persistent storage. Download important exports for safekeeping."); await load(); } catch(e) { setError(e.message); } }}>{history.persistent ? "Persistent storage enabled" : "Protect local storage"}</button></footer>
    </main>
    <dialog ref={modal} className="research-modal" aria-labelledby="research-dialog-title" onCancel={e => { if (working) e.preventDefault(); else setDialog(null); }}>
      {dialog && <><div className="research-modal-heading"><h2 id="research-dialog-title">{dialog.mode === 'refresh' ? 'Refresh from the archive' : 'Manage retained data'}</h2><button aria-label="Close dialog" disabled={working} onClick={() => setDialog(null)}>×</button></div><p className="research-dialog-target">{dialog.target.ra}°, {dialog.target.dec}° · {dialog.target.size}″</p>
        {dialog.mode === 'refresh' ? <><p>Choose a tool to re-query the archive and rebuild its saved recipe. All eligible observations are processed. Existing local results stay available until their replacement is fully saved.</p><div className="research-refresh-tools">{tools.map(([key,label]) => <div key={key}><strong>{label}</strong><small>Checked {when(dialog.target.tools?.[key]?.checked_at)}</small><button disabled={working} onClick={() => act('refresh',key)}>Refresh {label}</button></div>)}</div><p className="research-muted">Processing may take several minutes. Scientific filters and quality masks still apply.</p></> : <><p><strong>{formatBytes(dialog.target.bytes)}</strong> stored for this field. Choose what to remove. Downloaded exports on your computer are unaffected.</p><div className="research-delete-option"><h3>Clear cached files</h3><p>Keep this target and its saved recipes. Delete its locally saved images, numerical results and exports; opening a tool will rebuild them.</p><button disabled={working || !dialog.target.bytes} onClick={() => act('clear')}>Clear {formatBytes(dialog.target.bytes)} of cache</button></div><div className="research-delete-option"><h3>Remove target and data</h3><p>Delete the history entry and all its retained files. This cannot be undone.</p><button className="danger" disabled={working} onClick={() => act('remove')}>Remove target and data</button></div></>}
        {working && <p role="status">Working…</p>}{error && <p role="alert" className="research-error">{error}</p>}
      </>}
    </dialog>
  </div>;
}
