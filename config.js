// ตั้งค่าการเชื่อมต่อ Supabase
// SUPABASE_URL / SUPABASE_ANON_KEY ว่าง = โหมดสาธิต (ข้อมูลเดโม่ในเบราว์เซอร์)
// anon key เปิดเผยได้ ข้อมูลถูกป้องกันด้วยการล็อกอิน + Row Level Security  (ห้ามใส่ service_role key)
window.APP_CONFIG = {
  SUPABASE_URL: "https://lcyzhgotqjpkuturbtcz.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxjeXpoZ290cWpwa3V0dXJidGN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2MzA0MzgsImV4cCI6MjEwODIwNjQzOH0.P86jtoKu8bG25SPdO1syDxPqA0z6U4DLEpQ4MAMa2Wk",
  // ล็อกอินด้วยชื่อผู้ใช้: "Counter 1" → counter1@<STAFF_DOMAIN>
  STAFF_DOMAIN: "royal-event.example.com",
  EVENT_NAME: "ลงทะเบียนแขก · รอบเสด็จ",
  VENUE: "หอประชุมใหญ่ ศูนย์วัฒนธรรมแห่งประเทศไทย",
};
