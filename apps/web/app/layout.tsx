import type { ReactNode } from 'react';

export const metadata = {
  title: 'FiyatUcuz',
  description: 'Türkiye’de akıllı fiyat karşılaştırma platformu.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
