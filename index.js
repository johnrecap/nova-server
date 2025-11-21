const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const bcrypt = require('bcryptjs'); // للتشفير
const jwt = require('jsonwebtoken'); // لتوكين الدخول
const { query } = require('./db'); 

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-123'; // مفتاح سري مؤقت

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
};

const BASE_URL = 'https://www.royalroad.com';

// --- 1. قسم المستخدمين (Auth) ---

// تسجيل حساب جديد
app.post('/auth/register', async (req, res) => {
    const { email, password, username } = req.body;
    if (!email || !password) return res.status(400).json({ error: "البيانات ناقصة" });

    try {
        // تشفير كلمة السر
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // إنشاء المستخدم
        const result = await query(
            `INSERT INTO users (email, username, password_hash, auth_method) 
             VALUES ($1, $2, $3, 'email') RETURNING user_id`,
            [email, username || 'Reader', hashedPassword]
        );
        
        const userId = result.rows[0].user_id;

        // إنشاء إحصائيات مبدئية للمستخدم (Level 1)
        await query(`INSERT INTO user_stats (user_id) VALUES ($1)`, [userId]);

        res.json({ success: true, userId });
    } catch (e) {
        if (e.code === '23505') return res.status(400).json({ error: "الايميل مستخدم من قبل" });
        res.status(500).json({ error: e.message });
    }
});

// تسجيل الدخول
app.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await query(`SELECT * FROM users WHERE email = $1`, [email]);
        if (result.rows.length === 0) return res.status(400).json({ error: "المستخدم غير موجود" });

        const user = result.rows[0];
        const validPass = await bcrypt.compare(password, user.password_hash);
        if (!validPass) return res.status(400).json({ error: "كلمة السر خطأ" });

        // إنشاء توكين (تصريح دخول)
        const token = jwt.sign({ userId: user.user_id }, JWT_SECRET, { expiresIn: '7d' });
        
        res.json({ 
            success: true, 
            token, 
            user: { id: user.user_id, name: user.username, email: user.email } 
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- 2. قسم مكتبة المستخدم ---

// إضافة رواية للمكتبة
app.post('/user/library', async (req, res) => {
    const { token, novelUrl } = req.body;
    try {
        // التأكد من المستخدم
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId;

        // التأكد ان الرواية موجودة عندنا في الـ Novels
        const novelRes = await query(`SELECT novel_id FROM novels WHERE source_id = $1`, [novelUrl]);
        if (novelRes.rows.length === 0) return res.status(404).json({ error: "الرواية غير موجودة في النظام" });
        
        const novelId = novelRes.rows[0].novel_id;

        // إضافتها للمكتبة
        await query(
            `INSERT INTO user_library (user_id, novel_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [userId, novelId]
        );

        res.json({ success: true, message: "تمت الإضافة للمكتبة" });
    } catch (e) {
        res.status(401).json({ error: "غير مصرح" });
    }
});

// جلب مكتبة المستخدم
app.get('/user/library', async (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ error: "مطلوب تسجيل دخول" });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const result = await query(`
            SELECT n.title, n.cover_url as image, n.source_id as id, ul.current_chapter
            FROM user_library ul
            JOIN novels n ON ul.novel_id = n.novel_id
            WHERE ul.user_id = $1
        `, [decoded.userId]);

        res.json(result.rows);
    } catch (e) {
        res.status(401).json({ error: "Invalid Token" });
    }
});


// --- 3. باقي كود الروايات (زي ما هو) ---

// رابط إنشاء الجداول (احتياطي)
app.get('/init-db', async (req, res) => {
    // ... (نفس كود إنشاء الجداول السابق، لا داعي لتكراره هنا لتوفير المساحة، لكن اتركه كما كان)
    // لو الجداول موجودة، مفيش ضرر، الأمر IF NOT EXISTS بيحمينا
    res.send("Database is ready.");
});

async function saveNovelToDB(novelData, chapters) {
    try {
        const novelQuery = `
            INSERT INTO novels (source_id, title, author, cover_url, description, rating, total_chapters, synced_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            ON CONFLICT (source_id) 
            DO UPDATE SET title = EXCLUDED.title, total_chapters = EXCLUDED.total_chapters, synced_at = NOW()
            RETURNING novel_id;
        `;
        const values = [novelData.id, novelData.title, novelData.author, novelData.image, novelData.summary, novelData.rating, chapters.length];
        const res = await query(novelQuery, values);
        const novelId = res.rows[0].novel_id;

        for (let i = 0; i < Math.min(chapters.length, 50); i++) {
            const ch = chapters[i];
            await query(`
                INSERT INTO chapters (novel_id, chapter_number, title, url)
                VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING
            `, [novelId, i + 1, ch.title, ch.url]);
        }
        console.log(`✅ Saved novel: ${novelData.title}`);
    } catch (e) { console.error("Error saving novel:", e); }
}

async function saveChapterContent(url, content) {
    try { await query('UPDATE chapters SET content = $1, synced_at = NOW() WHERE url = $2', [content, url]); } catch (e) {}
}

const mapGoogleBook = (item) => {
    const info = item.volumeInfo;
    return {
        id: item.id, 
        title: info.title,
        image: (info.imageLinks?.thumbnail || '').replace('http://', 'https://'),
        author: info.authors ? info.authors[0] : 'Unknown',
        rating: info.averageRating ? info.averageRating.toString() : '4.5',
        summary: info.description || "No description available.",
        source: 'google'
    };
};

app.get('/', (req, res) => res.send("Nova Server Ready with Auth! 🔐"));

app.get('/novels', async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/fictions/weekly-popular`, { headers, timeout: 5000 });
        const $ = cheerio.load(response.data);
        const novels = [];
        $('.fiction-list-item').each((i, el) => {
            const title = $(el).find('.fiction-title').text().trim();
            const urlPath = $(el).find('.fiction-title a').attr('href');
            const image = $(el).find('img').attr('src');
            const author = $(el).find('.author').text().trim().replace('by ', '');
            const rating = $(el).find('.star').attr('title') || '4.5';
            if (title && urlPath) novels.push({ id: urlPath, title, image, author, rating: rating.substring(0, 3), summary: "Tap to read...", source: 'royalroad' });
        });
        res.json(novels.length > 0 ? novels : []);
    } catch (error) {
        try {
            const googleRes = await axios.get('https://www.googleapis.com/books/v1/volumes?q=subject:fantasy+litrpg&orderBy=newest&maxResults=20&langRestrict=en');
            res.json(googleRes.data.items.map(mapGoogleBook));
        } catch (e) { res.json([]); }
    }
});

app.get('/search', async (req, res) => {
    const q = req.query.q;
    try {
        const googleRes = await axios.get(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=15&langRestrict=en`);
        res.json(googleRes.data.items.map(mapGoogleBook));
    } catch (error) { res.json([]); }
});

app.get('/details', async (req, res) => {
    const url = req.query.url;
    try {
        const dbCheck = await query(`
            SELECT n.*, json_agg(json_build_object('title', c.title, 'url', c.url)) as chapters
            FROM novels n
            LEFT JOIN chapters c ON n.novel_id = c.novel_id
            WHERE n.source_id = $1
            GROUP BY n.novel_id
        `, [url]);

        if (dbCheck.rows.length > 0 && dbCheck.rows[0].total_chapters > 0) {
            return res.json({ description: dbCheck.rows[0].description, chapters: dbCheck.rows[0].chapters });
        }
    } catch (e) {}

    if (!url.includes('/fiction/')) return res.json({ description: "From Google Books", chapters: [{title: "Read Full", url: url}] });

    try {
        const response = await axios.get(`${BASE_URL}${url}`, { headers });
        const $ = cheerio.load(response.data);
        const description = $('.description').text().trim();
        const title = $('h1').text().trim();
        const image = $('.cover-art-container img').attr('src');
        const author = $('.author').text().trim().replace('by ', '');
        const chapters = [];
        $('#chapters tbody tr').each((i, el) => {
            const link = $(el).find('a').attr('href');
            const cTitle = $(el).find('a').text().trim();
            if (link) chapters.push({ title: cTitle, url: link });
        });
        await saveNovelToDB({ id: url, title, image, author, summary: description, rating: '4.5' }, chapters);
        res.json({ description, chapters });
    } catch (error) { res.json({ description: "Error loading details", chapters: [] }); }
});

app.get('/read', async (req, res) => {
    const url = req.query.url;
    try {
        const dbCh = await query('SELECT content, title FROM chapters WHERE url = $1', [url]);
        if (dbCh.rows.length > 0 && dbCh.rows[0].content) return res.json({ title: dbCh.rows[0].title, content: dbCh.rows[0].content });
    } catch (e) {}

    if (!url.includes('/fiction/')) return res.json({ content: "Content unavailable." });

    try {
        const response = await axios.get(`${BASE_URL}${url}`, { headers });
        const $ = cheerio.load(response.data);
        let content = $('.chapter-content').text().trim().replace(/\n\s*\n/g, '\n\n');
        const title = $('h1').text().trim();
        await saveChapterContent(url, content);
        res.json({ title, content });
    } catch (error) { res.json({ content: "Failed to load chapter." }); }
});

app.get('/genre', async (req, res) => {
    const tag = req.query.tag;
    try {
        const response = await axios.get(`https://www.googleapis.com/books/v1/volumes?q=subject:${tag}&orderBy=relevance&maxResults=20&langRestrict=en`);
        res.json(response.data.items.map(mapGoogleBook));
    } catch (error) { res.json([]); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = app;
