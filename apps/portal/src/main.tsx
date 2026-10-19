import './global.css';
import { applyThemePreference } from './lib/theme-preference.js';
import './posthog.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import { ConsentBanner } from './lib/ConsentBanner.js';

// Resolve System / Light / Dark onto <html data-theme> before the first
// render (index.html's inline bootstrap already did this pre-paint; this
// also starts following OS + cross-tab changes).
applyThemePreference();

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <ConsentBanner />
    </QueryClientProvider>
  </StrictMode>,
);
