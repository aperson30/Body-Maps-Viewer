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
      <body>{children}</body>
    </html>
  );
}
