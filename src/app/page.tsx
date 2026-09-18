'use client';

import dynamic from 'next/dynamic';

const Broadcast = dynamic(() => import('@/components/Broadcast'), {
  ssr: false,
  loading: () => (
    <div
      style={{
        height: '100vh',
        display: 'grid',
        placeItems: 'center',
        fontFamily: 'var(--font-mono), monospace',
        color: 'var(--dim)',
        letterSpacing: '0.2em',
        fontSize: 12,
      }}
    >
      FIRING UP THE KITCHEN…
    </div>
  ),
});

export default function Page() {
  return <Broadcast />;
}
