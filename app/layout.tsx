import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import ConvexClientProvider from "@/components/ConvexClientProvider";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "intern · company brain",
  description:
    "A company brain you can see, and interns that go find what it doesn't know yet.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistMono.variable} h-full antialiased`}>
      <body className="h-full overflow-hidden bg-bg text-fg">
        <ConvexClientProvider>{children}</ConvexClientProvider>
      </body>
    </html>
  );
}
