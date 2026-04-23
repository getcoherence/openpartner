import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Dashboard } from './Dashboard.js';

const queryClient = new QueryClient();

function App() {
  const partnerId = new URLSearchParams(window.location.search).get('partnerId');

  return (
    <div style={{ fontFamily: 'system-ui', padding: '2rem', maxWidth: 960, margin: '0 auto' }}>
      <h1 style={{ marginBottom: '0.25rem' }}>OpenPartner</h1>
      <div style={{ color: '#666', marginBottom: '2rem', fontSize: 14 }}>Partner dashboard</div>
      {partnerId ? <Dashboard partnerId={partnerId} /> : <PartnerPicker />}
    </div>
  );
}

function PartnerPicker() {
  return (
    <div>
      <p>No partner selected. Append <code>?partnerId=&lt;id&gt;</code> to the URL.</p>
      <p style={{ color: '#666', fontSize: 14 }}>
        Create one via <code>POST /partners</code> and use the returned <code>id</code>.
      </p>
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
