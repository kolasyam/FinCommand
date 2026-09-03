import { Suspense } from 'react';
import LandingPageClient from '@/components/landing/LandingPageClient';

export default function LandingPage() {
  return (
    <Suspense>
      <LandingPageClient />
    </Suspense>
  );
}
