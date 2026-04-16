import "./globals.css";

export const metadata = {
  title: "rplace — Collaborative Pixel Canvas",
  description: "A Reddit r/place clone. Place pixels, create art together.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
