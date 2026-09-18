import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: "Jev's Kitchen Chaos",
  description: 'Autonomous Jev agents run a restaurant kitchen. Hire, fire, sabotage, or save them in real time.',
  openGraph: {
    title: "Jev's Kitchen Chaos",
    description: 'Autonomous Jev agents run a restaurant kitchen. Watch them cook, collide, panic, and burn things.',
    type: 'website',
    url: 'https://jevs-kitchen-chaos.vercel.app',
  },
  twitter: {
    card: 'summary_large_image',
    title: "Jev's Kitchen Chaos",
    description: 'Autonomous Jev agents run a restaurant kitchen. Watch them cook, collide, panic, and burn things.',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
