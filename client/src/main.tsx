import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import SyncPage from './SyncPage';
import './index.css';

// /sync is the unattended copy-verify-delete page used by the companion
// extension; everything else gets the normal SPA. (Served by the same SPA
// fallback on the server, so no extra routes are needed there.)
const isSyncPage = window.location.pathname === '/sync';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isSyncPage ? <SyncPage /> : <App />}
  </React.StrictMode>,
);
