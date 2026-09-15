import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AIHub } from '@/components/hub/AIHub';
import { HubSkeleton } from '@/components/hub/HubStates';

export const metadata: Metadata = { title: 'AI Hub' };

// useSearchParams (shareable ?q=&cat=&sub=&sort= views) needs a Suspense boundary for static rendering.
export default function HubPage() {
  return (
    <Suspense fallback={<HubSkeleton />}>
      <AIHub />
    </Suspense>
  );
}
