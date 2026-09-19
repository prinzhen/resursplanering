import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Resursplanering",
  description: "Planera projekt, aktiviteter, resurser och beläggning.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="sv">
      <body className="antialiased">{children}</body>
    </html>
  );
}
