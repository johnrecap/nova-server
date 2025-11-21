const { query, pool } = require('./db');

const createTablesQuery = `
  -- 1. جدول المستخدمين
  CREATE TABLE IF NOT EXISTS users (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(100),
    password_hash VARCHAR(255), -- تأكدنا من وجود هذا العمود
    auth_method VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW()
  );

  -- 2. جدول الروايات
  CREATE TABLE IF NOT EXISTS novels (
    novel_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id VARCHAR(255) UNIQUE,
    title VARCHAR(500),
    author VARCHAR(255),
    cover_url TEXT,
    status VARCHAR(50),
    rating VARCHAR(10),
    description TEXT,
    total_chapters INT DEFAULT 0,
    synced_at TIMESTAMP DEFAULT NOW()
  );

  -- 3. جدول الفصول
  CREATE TABLE IF NOT EXISTS chapters (
    chapter_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    novel_id UUID REFERENCES novels(novel_id) ON DELETE CASCADE,
    chapter_number INT, -- قد نحتاجه للترتيب
    title VARCHAR(500),
    url VARCHAR(500) UNIQUE,
    content TEXT,
    synced_at TIMESTAMP DEFAULT NOW()
  );

  -- 4. مكتبة المستخدم
  CREATE TABLE IF NOT EXISTS user_library (
    library_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    novel_id UUID REFERENCES novels(novel_id) ON DELETE CASCADE,
    added_at TIMESTAMP DEFAULT NOW(),
    current_chapter INT DEFAULT 1,
    UNIQUE(user_id, novel_id)
  );

  -- 5. إحصائيات اللاعب + رصيد الوقت (تم التحديث)
  CREATE TABLE IF NOT EXISTS user_stats (
    stats_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE UNIQUE,
    level INT DEFAULT 1,
    total_xp INT DEFAULT 0,
    reading_time_minutes INT DEFAULT 120, -- يبدأ بـ 120 دقيقة مجانية
    last_updated TIMESTAMP DEFAULT NOW()
  );

  -- 6. سجل الإعلانات (جديد - للحماية والتحليل)
  CREATE TABLE IF NOT EXISTS ad_logs (
    log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    reward_minutes INT DEFAULT 20,
    watched_at TIMESTAMP DEFAULT NOW()
  );
`;

async function setupDatabase() {
  try {
    console.log("⏳ جاري تحديث جداول قاعدة البيانات...");
    await query(createTablesQuery);
    console.log("✅ تم تحديث الجداول بنجاح.");
  } catch (err) {
    console.error("❌ خطأ في قاعدة البيانات:", err);
  } finally {
    pool.end();
  }
}

setupDatabase();
