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

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.royalroad.com/'
};

// --- Auth Routes (زي ما هي) ---
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

// --- Helper: Save Novels ---
async function saveImportedNovels(novelsList, category) {
    // ملاحظة: هنا ممكن مستقبلاً نضيف التصنيف للداتا بيز لو حابب
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

// --- 1. جلب الروايات (مع التصنيف الصحيح) ---
app.get('/novels', async (req, res) => {
    const page = req.query.page || 1;
    const category = req.query.category || 'all';
    
    // خريطة تحويل أسماء التصنيفات من التطبيق -> لرابط الموقع
    const genreMap = {
        'all': '', // الكل = مفيش فلتر
        'action': 'action',
        'adventure': 'adventure',
        'fantasy': 'fantasy',
        'mystery': 'mystery',
        'horror': 'horror',
        'scifi': 'sci_fi', // لاحظ الفرق في الكتابة للموقع
        'magic': 'magic',
        'history': 'history'
    };

    // 1. بناء الرابط بدقة
    // بنستخدم Best Rated كأفضل خيار للجودة
    let targetUrl = `${BASE_URL}/fictions/best-rated`;
    
    // تجميع العوامل (Query Parameters)
    const params = [];
    
    // إضافة رقم الصفحة
    params.push(`page=${page}`);
    
    // إضافة التصنيف لو موجود
    const genreCode = genreMap[category];
    if (genreCode) {
        params.push(`genre=${genreCode}`);
    }

    // دمج الرابط النهائي
    if (params.length > 0) {
        targetUrl += `?${params.join('&')}`;
    }

    console.log(`🚀 Fetching: ${targetUrl}`);

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

        if (novels.length > 0) {
            await saveImportedNovels(novels, category);
            res.json(novels);
        } else {
            res.json([]);
        }

    } catch (error) {
        console.error("Scraping failed:", error.message);
        // لو فشل، هات أي حاجة من الداتا بيز عشان الشكل العام
        try {
            const dbNovels = await query(`SELECT source_id as id, title, cover_url as image, author, rating FROM novels LIMIT 20`);
            res.json(dbNovels.rows);
        } catch (dbError) { res.json([]); }
    }
});

// --- باقي الروابط (التفاصيل والقراءة) ---
// (زي ما هي بالظبط، متغيرة)
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
        await query(`UPDATE novels SET description = $1, total_chapters = $2, cover_url = $3 WHERE source_id = $4`, [description, chapters.length, image, url]);
        
        const novelRes = await query(`SELECT novel_id FROM novels WHERE source_id = $1`, [url]);
        if (novelRes.rows.length > 0) {
             const novelId = novelRes.rows[0].novel_id;
             for (let i = 0; i < Math.min(chapters.length, 100); i++) {
                const ch = chapters[i];
                await query(`INSERT INTO chapters (novel_id, chapter_number, title, url) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [novelId, i + 1, ch.title, ch.url]);
            }
        }
        res.json({ description, chapters });
    } catch (error) { res.json({ description: "Failed to load details.", chapters: [] }); }
});

app.get('/read', async (req, res) => {
    const url = req.query.url;
    try {
        const response = await axios.get(`${BASE_URL}${url}`, { headers });
        const $ = cheerio.load(response.data);
        let content = $('.chapter-content').text().trim().replace(/\n\s*\n/g, '\n\n');
        const title = $('h1').text().trim();
        await query('UPDATE chapters SET content = $1 WHERE url = $2', [content, url]);
        res.json({ title, content });
    } catch (error) { res.json({ content: "Failed to load chapter content." }); }
});

app.get('/init-db', async (req, res) => { res.send("DB Ready"); });
app.get('/', (req, res) => res.send("Nova Server V3 (Genres Fixed) 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = app;
// ... (باقي الكود اللي فوق زي ما هو)

// 4. البحث (FIXED: Royal Road Search)
app.get('/search', async (req, res) => {
    const queryText = req.query.q;
    if (!queryText) return res.json([]);

    console.log(`🔍 Searching for: ${queryText}`);
    
    // رابط البحث الصحيح في Royal Road
    const targetUrl = `${BASE_URL}/fictions/search?title=${encodeURIComponent(queryText)}`;

    try {
        const response = await axios.get(targetUrl, { headers, timeout: 10000 });
        const $ = cheerio.load(response.data);
        const novels = [];

        // في صفحة البحث، الكلاسات مختلفة شوية
        $('.fiction-list-item').each((i, el) => {
            const title = $(el).find('.fiction-title').text().trim();
            const urlPart = $(el).find('.fiction-title a').attr('href');
            const image = $(el).find('img').attr('src');
            const author = $(el).find('.author').text().trim().replace('by ', '');
            
            // تقييم البحث بيكون مختلف أحياناً، هنحاول نجيبه
            let rating = '4.5'; 
            const starTitle = $(el).find('.star').attr('title');
            if (starTitle) rating = starTitle.substring(0, 3);

            if (title && urlPart) {
                novels.push({
                    id: urlPart,
                    title,
                    image,
                    author,
                    rating,
                    source: 'royalroad'
                });
            }
        });

        console.log(`✅ Found ${novels.length} results.`);
        res.json(novels);

    } catch (error) {
        console.error("Search failed:", error.message);
        res.json([]); 
    }
});

// ... (باقي الكود زي ما هو)
