// The jam's page (jam.html): jam rooms, apart from the dashboard (Jam.jsx says what's where).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { JamApp } from './pages/Jam.jsx';
import { applyTheme } from './theme.js';

applyTheme();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <JamApp />
  </StrictMode>,
);
