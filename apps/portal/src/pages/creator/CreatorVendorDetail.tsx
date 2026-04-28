import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { Card, ErrorBanner, Page } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi } from './creator-api.js';

interface Vendor {
  id: string;
  displayName: string;
  instanceUrl: string;
  status: string;
  partnerCount: number;
  description?: string | null;
  websiteUrl?: string | null;
  createdAt: string;
}

export function CreatorVendorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ['creator-vendor', id],
    queryFn: () => creatorApi<Vendor>(`/vendors/${id}`),
    enabled: !!id,
    retry: false,
  });

  return (
    <Page title={data?.displayName ?? 'Vendor'} subtitle="Network member">
      <ErrorBanner error={error} />
      {isLoading && <Card>Loading…</Card>}
      {data && (
        <Card>
          <div style={{ color: theme.textMuted, fontSize: 13 }}>
            {data.partnerCount} partner{data.partnerCount === 1 ? '' : 's'}
          </div>
          {data.description && <p style={{ marginTop: 12 }}>{data.description}</p>}
          {data.websiteUrl && (
            <p style={{ marginTop: 12 }}>
              <a href={data.websiteUrl} target="_blank" rel="noopener noreferrer">Visit website →</a>
            </p>
          )}
        </Card>
      )}
    </Page>
  );
}
