import LocalSaveStatus from './components/LocalSaveStatus.jsx';
import React from 'react';
import { createRoot } from 'react-dom/client';
import DetectorComparison from './components/DetectorComparison.jsx';

createRoot(document.getElementById('root')).render(<><LocalSaveStatus /><DetectorComparison /></>);
