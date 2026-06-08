import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'BodyMaps CT Viewer — JHU CCVL',
  description:
    'Web-based CT scan and per-voxel organ segmentation viewer. Johns Hopkins University CCVL Lab.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Start fetching the 17 MB CT scan as early as possible — before JS parses */}
        <link rel="preload" href="/data/BDMAP_00000338/ct.nii.gz" as="fetch" crossOrigin="anonymous" />
      </head>
      <body>{children}</body>
    </html>
  );
}
