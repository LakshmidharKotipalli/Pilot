import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/ui.css';
import OptionsApp from './OptionsApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OptionsApp />
  </StrictMode>,
);
