import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/ui.css';
import DecisionApp from './DecisionApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DecisionApp />
  </StrictMode>,
);
