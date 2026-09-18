import type { Metadata } from 'next';
import { Archivo, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

const display = Archivo({
  subsets: ['latin'],
  weight: ['500', '600', '700', '800'],
  variable: '--font-display',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: "Jev's Kitchen Chaos — Four Live Jev Chefs",
  description:
    'Four Jev decision-model agents run an Overcooked-style 3D kitchen. Live telemetry, policy confidence, and controller inputs for every chef.',
  openGraph: {
    title: "Jev's Kitchen Chaos — Four Live Jev Chefs",
    description:
      'Four Jev decision-model agents run an Overcooked-style 3D kitchen with live telemetry for every chef.',
    type: 'website',
    url: 'https://jevs-kitchen-chaos.vercel.app',
  },
  twitter: {
    card: 'summary_large_image',
    title: "Jev's Kitchen Chaos — Four Live Jev Chefs",
    description:
      'Four Jev decision-model agents run an Overcooked-style 3D kitchen with live telemetry for every chef.',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
