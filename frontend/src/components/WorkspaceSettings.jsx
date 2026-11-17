import { Children, useEffect, useRef } from 'react';
import '../workspaceSettings.css';

// One native modal and one scroll surface. Scientific controls stay mounted,
// so changing sections never resets a recipe or changes the displayed result.
export default function WorkspaceSettings({ section, onSection, onClose, children, sections = [['target', 'Target & recipe'], ['display', 'Image display'], ['data', 'Exports & provenance']], contentClassName = '' }) {
  const dialog = useRef(null);
  const open = section !== null;
  useEffect(() => {
    if (!open) return;
    const node = dialog.current, opener = document.activeElement;
    const overflow = document.body.style.overflow;
    node.showModal(); document.body.style.overflow = 'hidden';
    return () => {
      node.close(); document.body.style.overflow = overflow;
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);
  return <dialog ref={dialog} className="workspace-settings" aria-labelledby="settings-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="settings-header"><div><span className="workspace-eyebrow">Research workspace</span><h2 id="settings-title">Settings &amp; data</h2></div><button onClick={onClose} aria-label="Close settings">Done <span aria-hidden="true">×</span></button></header>
    <nav className="settings-navigation" aria-label="Settings sections">
      {sections.map(([id, label]) => <button key={id} aria-pressed={section === id} onClick={() => onSection(id)}>{label}</button>)}
    </nav>
    <div className={`compare-sidebar settings-content ${contentClassName}`}>
      {Children.toArray(children).map((child, i) => <div key={i} hidden={(child.props['data-settings-section'] || 'display') !== section}>{child}</div>)}
    </div>
  </dialog>;
}
