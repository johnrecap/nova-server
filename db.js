const { Pool } = require('pg');
require('dotenv').config();

// إعداد الاتصال بقاعدة البيانات
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // ضروري عشان Supabase يقبل الاتصال
  }
});

// تصدير أدوات الاتصال عشان نستخدمها في باقي الملفات
module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
