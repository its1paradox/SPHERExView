import { useEffect, useRef } from 'react';
import { DETECTORS, NOMINAL_RANGES } from '../lib/comparison.js';

// Native modal provides a focus trap and makes the grid behind it inert.
export default function ExpandedDetector({ detector, onSelect, onClose, returnFocus, epochLabel, modeSwitch, children }) {
  const dialog = useRef(null);
  useEffect(() => {
    const node = dialog.current, opener = returnFocus || document.activeElement;
    const overflow = document.body.style.overflow;
    node.showModal(); document.body.style.overflow = 'hidden';
    return () => { node.close(); document.body.style.overflow = overflow; if (opener?.isConnected) opener.focus(); };
  }, []);
  const move = delta => onSelect((detector - 1 + delta + 6) % 6 + 1);
  return <dialog ref={dialog} className="expanded-dialog" aria-labelledby="expanded-title"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      if (event.ctrlKey || event.metaKey || event.altKey || ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); move(event.key === 'ArrowLeft' ? -1 : 1); }
    }}>
    <header className="expanded-header"><div><h2 id="expanded-title">D{detector} · ≈ {NOMINAL_RANGES[detector - 1]} µm</h2><p>{epochLabel} · same sky position and scale across detectors</p></div><button autoFocus onClick={onClose}>Back to six tiles <span aria-hidden="true">×</span></button></header>
    <div className="expanded-controls"><div className="expanded-navigation" aria-label="Expanded detector navigation">
      <button onClick={() => move(-1)} aria-label="Previous detector">← Previous</button>
      <div className="detector-tabs" role="group" aria-label="Choose detector">{DETECTORS.map(d => <button key={d} onClick={() => onSelect(d)} aria-pressed={d === detector} aria-label={`View D${d}`}>D{d}</button>)}</div>
      <button onClick={() => move(1)} aria-label="Next detector">Next →</button>
    </div>{modeSwitch}</div>
    <div className="expanded-stage" aria-live="polite">{children}</div>
    <p className="expanded-help">← / → change detector · Esc returns to the grid · wheel zooms · drag pans · click pins. Shared display controls remain in the grid’s side panel.</p>
  </dialog>;
}
