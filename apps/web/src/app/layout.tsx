import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kukugram | Find your circle",
  description: "A creator-first social space for the moments and communities that matter."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
