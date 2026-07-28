import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Cairn — screen-aware help your team keeps",
  description:
    "Share a screen, ask out loud, and get pointed at the answer. Every answer becomes a trail your teammates inherit.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* The app owns the whole viewport and scrolls nothing at the document
          level — the stage is fixed and the drawer scrolls internally. */}
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
