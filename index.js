const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('./db'); 

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-123';
const BASE_URL = 'https://www.royalroad.com';

// تمويه السيرفر كأنه متصفح حقيقي عشان ميتعملوش بلوك
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Referer': 'https://www.royalroad.com/fictions/best-rated'
};

// --- Auth (زي ما هو) ---
app.post('/auth/register', async (req, res) => {
    const { email, password, username } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Missing data" });
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await query(`INSERT INTO users (email, username, password_hash, auth_method) VALUES ($1, $2, $3, 'email') RETURNING user_id`, [email, username || 'Reader', hashedPassword]);
        await query(`INSERT INTO user_stats (user_id) VALUES ($1)`, [result.rows[0].user_id]);
        res.json({ success: true, userId: result.rows[0].user_id });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await query(`SELECT * FROM users WHERE email = $1`, [email]);
        if (result.rows.length === 0) return res.status(400).json({ error: "User not found" });
        const user = result.rows[0];
        if (!await bcrypt.compare(password, user.password_hash)) return res.status(400).json({ error: "Wrong password" });
        const token = jwt.sign({ userId: user.user_id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token, user: { id: user.user_id, name: user.username, email: user.email } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- المنطق الجديد للروايات ---

async function saveImportedNovels(novelsList) {
    for (const novel of novelsList) {
        try {
            await query(`
                INSERT INTO novels (source_id, title, author, cover_url, rating, status, synced_at)
                VALUES ($1, $2, $3, $4, $5, 'ongoing', NOW())
                ON CONFLICT (source_id) DO UPDATE SET 
                rating = EXCLUDED.rating, title = EXCLUDED.title, synced_at = NOW()
            `, [novel.id, novel.title, novel.author, novel.image, novel.rating]);
        } catch (e) { console.error("Skipped:", novel.title); }
    }
}

// 1. جلب الروايات (Royal Road فقط)
app.get('/novels', async (req, res) => {
    const page = req.query.page || 1;
    const category = req.query.category || 'all';
    
    // 1. تحديد الرابط بدقة
    // Best Rated هو أفضل خيار لأنه بيجيب روايات عالية الجودة ومضمونة
    let urlPath = 'best-rated';
    
    if (category !== 'all') {
        // لو اختار تصنيف، نستخدم البحث بالتصنيف
        urlPath = `active?genre=${category}`;
    }

    // تظبيط الفاصل (? أو &) عشان الرابط ميبوظش
    const separator = urlPath.includes('?') ? '&' : '?';
    const targetUrl = `${BASE_URL}/fictions/${urlPath}${separator}page=${page}`;

    console.log(`🚀 Scraping: ${targetUrl}`);

    try {
        const response = await axios.get(targetUrl, { headers, timeout: 10000 });
        const $ = cheerio.load(response.data);
        const novels = [];

        $('.fiction-list-item').each((i, el) => {
            const title = $(el).find('.fiction-title').text().trim();
            const urlPart = $(el).find('.fiction-title a').attr('href');
            const image = $(el).find('img').attr('src');
            const author = $(el).find('.author').text().trim().replace('by ', '');
            const rating = $(el).find('.star').attr('title') || '4.5';
            
            // تصفية النتائج البايزة
            if (title && urlPart && image) {
                novels.push({
                    id: urlPart,
                    title,
                    image,
                    author,
                    rating: rating.substring(0, 3),
                    source: 'royalroad'
                });
            }
        });

        console.log(`✅ Found ${novels.length} novels.`);

        if (novels.length > 0) {
            // حفظ في قاعدة البيانات للزمن
            saveImportedNovels(novels); 
            res.json(novels);
        } else {
            // لو ملقاش حاجة (ممكن الصفحة خلصت)، نرجع مصفوفة فاضية
            res.json([]);
        }

    } catch (error) {
        console.error("❌ Scraping failed:", error.message);
        // لو السحب فشل، نجرب نجيب من "المخزن" (قاعدة البيانات) كحل أخير
        // عشان لو النت قطع أو الموقع وقع، التطبيق يفضل شغال باللي عنده
        try {
            const offset = (page - 1) * 20;
            const dbNovels = await query(`
                SELECT source_id as id, title, cover_url as image, author, rating 
                FROM novels 
                ORDER BY synced_at DESC 
                LIMIT 20 OFFSET $1`, [offset]);
            
            res.json(dbNovels.rows);
        } catch (dbError) {
            res.json([]); // لو كله فشل، رجع فاضي وخلاص
        }
    }
});

// 2. التفاصيل (تحديث البيانات)
app.get('/details', async (req, res) => {
    const url = req.query.url;
    try {
        const response = await axios.get(`${BASE_URL}${url}`, { headers });
        const $ = cheerio.load(response.data);
        const description = $('.description').text().trim();
        const image = $('.cover-art-container img').attr('src');
        
        const chapters = [];
        $('#chapters tbody tr').each((i, el) => {
            const link = $(el).find('a').attr('href');
            const cTitle = $(el).find('a').text().trim();
            if (link) chapters.push({ title: cTitle, url: link });
        });

        // تحديث البيانات في الداتا بيز
        await query(`UPDATE novels SET description = $1, total_chapters = $2, cover_url = $3 WHERE source_id = $4`, [description, chapters.length, image, url]);
        
        // حفظ الفصول
        const novelRes = await query(`SELECT novel_id FROM novels WHERE source_id = $1`, [url]);
        if (novelRes.rows.length > 0) {
             const novelId = novelRes.rows[0].novel_id;
             // حفظ أول 100 فصل
             for (let i = 0; i < Math.min(chapters.length, 100); i++) {
                const ch = chapters[i];
                await query(`INSERT INTO chapters (novel_id, chapter_number, title, url) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [novelId, i + 1, ch.title, ch.url]);
            }
        }
        res.json({ description, chapters });
    } catch (error) { res.json({ description: "Failed to load details.", chapters: [] }); }
});

// 3. القراءة
app.get('/read', async (req, res) => {
    const url = req.query.url;
    try {
        const response = await axios.get(`${BASE_URL}${url}`, { headers });
        const $ = cheerio.load(response.data);
        let content = $('.chapter-content').text().trim().replace(/\n\s*\n/g, '\n\n');
        const title = $('h1').text().trim();
        
        // حفظ المحتوى
        await query('UPDATE chapters SET content = $1 WHERE url = $2', [content, url]);
        
        res.json({ title, content });
    } catch (error) { res.json({ content: "Failed to load chapter content." }); }
});

app.get('/init-db', async (req, res) => { res.send("DB is ready"); });
app.get('/', (req, res) => res.send("Nova Server (RoyalRoad Only) is Ready! 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = app;
