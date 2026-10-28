"use client";
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) { return <main className="full-state"><h1>เปิดหน้านี้ไม่สำเร็จ</h1><p>กรุณาลองโหลดอีกครั้ง ข้อมูลที่บันทึกแล้วจะยังอยู่</p><button className="button button-primary" onClick={reset}>ลองอีกครั้ง</button></main>; }
