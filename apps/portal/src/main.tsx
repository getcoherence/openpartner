import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const queryClient = new QueryClient();

function App() {
  return (
    <div style={{ fontFamily: 'system-ui', padding: '2rem', maxWidth: 720 }}>
      <h1>OpenPartner</h1>
      <p>Partner dashboard — scaffold. Phase 1 will wire links, clicks, and attributed revenue.</p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
