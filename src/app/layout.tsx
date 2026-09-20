import type { Metadata, Viewport } from "next";
import { Brand } from "@/components/brand";
import { AccountNavigation, AccountProvider } from "@/components/account-provider";
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
        <AccountProvider>
        <div className="site-shell">
          <header className="site-header">
            <div className="header-inner">
              <Brand />
              <AccountNavigation />
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
          </footer>
        </div>
        </AccountProvider>
      </body>
    </html>
  );
}
