import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Brand } from "@/components/brand";
import { Icon } from "@/components/icons";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "TagMix — Learn a tag, your way",
    template: "%s · TagMix",
  },
  description:
    "Search four-part barbershop tags, follow the score, and rehearse with a flexible voice-part mixer.",
  icons: { icon: "/mark.svg" },
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#f4efe5",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="site-shell">
          <header className="site-header">
            <div className="header-inner">
              <Brand />
              <nav className="header-nav" aria-label="Primary navigation">
                <Link href="/">
                  <Icon name="search" size={17} />
                  Browse tags
                </Link>
                <a href="https://www.barbershoptags.com" rel="noreferrer" target="_blank">
                  Source library
                  <Icon name="external" size={15} />
                </a>
              </nav>
            </div>
          </header>
          <main>{children}</main>
          <footer className="site-footer">
            <p>
              Scores and learning tracks are provided by{" "}
              <a href="https://www.barbershoptags.com" rel="noreferrer" target="_blank">
                BarbershopTags.com
              </a>
              .
            </p>
            <p>Built for one more run-through.</p>
          </footer>
        </div>
      </body>
    </html>
  );
}
