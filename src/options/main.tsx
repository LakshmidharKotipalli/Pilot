import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/ui.css';
import { applyTheme, getTheme } from '../shared/theme';
import OptionsApp from './OptionsApp';

applyTheme(getTheme());
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OptionsApp />
  </StrictMode>,
);
