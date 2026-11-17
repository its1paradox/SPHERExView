import { useLayoutEffect, useRef, useState } from 'react';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// Docked panels resize within the available viewport; scientific state is never
// read or written here. Pointer capture keeps a drag stable outside its handle.
export function useWorkspaceResize(display, setDisplay) {
  const ref = useRef(null), drag = useRef(null);
  const [available, setAvailable] = useState(600);
  const [heights, setHeights] = useState({});
  useLayoutEffect(() => {
    const measure = () => {
      if (!ref.current) return;
      const top = ref.current.getBoundingClientRect().top + window.scrollY;
      const next = Math.max(320, Math.floor(window.innerHeight - top - 10));
      setAvailable(previous => previous === next ? previous : next);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(ref.current.parentElement);
    observer?.observe(document.querySelector('.compare-header'));
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  const reset = () => { setHeights({}); setDisplay(d => ({ ...d, imageFraction: 50 })); };
  const resize = (panel, edge, dx, dy, start) => {
    if (/[ew]/.test(edge) && display.workspaceLayout === 'split') {
      // Inner edges form the common divider; outer edges change that panel's
      // width as well, keeping both panels docked and preventing overlap.
      const direction = (panel === 'image' && edge.includes('w')) || (panel === 'spectrum' && edge.includes('e')) ? -1 : 1;
      const minimum = Math.min(40, 360 / Math.max(1, start.width) * 100);
      const ratio = clamp(start.ratio + direction * dx / Math.max(1, start.width) * 100, minimum, 100 - minimum);
      setDisplay(d => ({ ...d, imageFraction: Math.round(ratio * 10) / 10 }));
    }
    if (/[ns]/.test(edge)) setHeights(h => ({ ...h, [panel]: clamp(start.height + (edge.includes('n') ? -dy : dy), Math.min(400, available), available) }));
  };
  const handlers = (panel, edge) => ({
    onPointerDown(event) {
      if (event.button !== 0) return;
      event.preventDefault();
      drag.current = { x: event.clientX, y: event.clientY, width: ref.current.getBoundingClientRect().width, ratio: display.imageFraction, height: Math.min(heights[panel] ?? available, available) };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event) { if (drag.current) resize(panel, edge, event.clientX - drag.current.x, event.clientY - drag.current.y, drag.current); },
    onPointerUp(event) { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); },
    onPointerCancel() { drag.current = null; },
    onLostPointerCapture() { drag.current = null; },
    onDoubleClick: reset,
    onKeyDown(event) {
      event.stopPropagation();
      if (event.key === 'Home') { event.preventDefault(); reset(); return; }
      const deltas = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] };
      if (!deltas[event.key]) return;
      event.preventDefault();
      resize(panel, edge, ...deltas[event.key], { width: ref.current.getBoundingClientRect().width, ratio: display.imageFraction, height: Math.min(heights[panel] ?? available, available) });
    },
  });
  return { ref, reset, handlers, height: panel => Math.min(heights[panel] ?? available, available) };
}

export function ResizeHandles({ panel, workspace }) {
  return <>{['w', 'e', 's', 'sw', 'se'].map(edge => <div key={edge}
    className={`panel-resize panel-resize-${edge}`} role="separator" tabIndex={0}
    aria-label={`Resize ${panel} panel ${edge}`} aria-orientation={edge === 's' ? 'horizontal' : 'vertical'}
    title="Drag to resize · arrow keys adjust · double-click or Home fits workspace"
    {...workspace.handlers(panel, edge)} />)}</>;
}

// Fit the entire image, including all six tiles, inside its actual stage. The
// inactive view remains mounted but cannot contribute an oversized intrinsic
// height. Both views use the same fixed panel dimensions.
export function useFittedImages(ref, dependencies) {
  useLayoutEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return;
    const grids = [...ref.current.querySelectorAll('.image-deck-view .detector-grid')];
    const fit = () => {
      for (const grid of grids) {
        const rgb = grid.closest('.image-deck-view').dataset.view === 'rgb';
        const columns = rgb ? 1 : 3, rows = rgb ? 1 : 2;
        const gap = parseFloat(getComputedStyle(grid).gap) || 0;
        const cards = [...grid.children];
        const overhead = Math.max(0, ...cards.map(card => [...card.children].filter(e => !e.classList.contains('detector-image')).reduce((sum, e) => sum + e.getBoundingClientRect().height, 2)));
        const side = Math.max(1, Math.floor(Math.min((grid.clientWidth - gap * (columns - 1)) / columns - 2, (grid.clientHeight - gap * (rows - 1)) / rows - overhead)));
        grid.style.setProperty('--fitted-side', `${side}px`);
      }
    };
    const observer = new ResizeObserver(fit);
    grids.forEach(grid => { observer.observe(grid); [...grid.children].forEach(card => [...card.children].filter(e => !e.classList.contains('detector-image')).forEach(e => observer.observe(e))); });
    fit();
    return () => observer.disconnect();
  }, dependencies);
}
