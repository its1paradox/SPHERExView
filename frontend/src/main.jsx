import LocalSaveStatus from './components/LocalSaveStatus.jsx';
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import ResearchDashboard from './components/ResearchDashboard.jsx'
import './styles.css'
import './timeline.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode><LocalSaveStatus />
    {window.location.pathname.endsWith('/timeline.html') || new URLSearchParams(window.location.hash.slice(1)).has('ra') ? <App /> : <ResearchDashboard />}
  </React.StrictMode>,
)
