import type { Metadata } from "next";
import "@fontsource-variable/noto-sans-thai";
import "./globals.css";
import "@/components/widget-settings.css";
export const metadata: Metadata = { title: "RRS Connect — AI Chat & CRM", description: "พื้นที่ทำงานทีมขายรุ่งเรืองดั๊มพ์ เชื่อมบทสนทนากับโอกาสขาย" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="th"><body>{children}</body></html>; }
