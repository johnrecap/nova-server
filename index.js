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

// --- Auth (نفس القديم) ---
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

// --- 🌍 نظام الترجمة المجاني (The Magic Trick) ---
async function translateText(text, targetLang = 'ar') {
    // جوجل عنده حد أقصى للحروف في المرة الواحدة، فبنقسم النص لقطع
    const chunks = text.match(/.{1,1800}/g) || []; 
    let translatedText = "";

    for (const chunk of chunks) {
        try {
            // استخدام رابط API جوجل المخفي (المجاني)
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(chunk)}`;
            const response = await axios.get(url);
            // تجميع النص المترجم
            if (response.data && response.data[0]) {
                response.data[0].forEach(item => {
                    if (item[0]) translatedText += item[0];
                });
            }
        } catch (e) {
            console.error("Translate chunk error", e.message);
            translatedText += chunk; // لو فشل، حط النص الأصلي
        }
    }
    return translatedText;
}

app.post('/translate', async (req, res) => {
    const { text, lang } = req.body;
    if (!text) return res.json({ translated: "" });
    
    const translated = await translateText(text, lang || 'ar');
    res.json({ translated });
});

// --- باقي الروابط ---

// 4. البحث (تم إصلاح المشكلة + فلترة النتائج الفارغة)
app.get('/search', async (req, res) => {
    const queryText = req.query.q;
    if (!queryText) return res.json([]);

    console.log(`🔍 Searching for: ${queryText}`);
    
    const targetUrl = `${BASE_URL}/fictions/search?title=${encodeURIComponent(queryText)}`;

    try {
        const response = await axios.get(targetUrl, { headers, timeout: 15000 });
        const $ = cheerio.load(response.data);
        const novels = [];

        // البحث في Royal Road له تصميم مختلف (search-item)
        $('.fiction-list-item').each((i, el) => {
            // محاولة اصطياد العنوان بأكثر من طريقة
            let title = $(el).find('.fiction-title').text().trim();
            if (!title) title = $(el).find('h2.fiction-title').text().trim();

            // محاولة اصطياد الرابط
            let urlPart = $(el).find('.fiction-title a').attr('href');
            if (!urlPart) urlPart = $(el).find('a').attr('href'); // محاولة احتياطية

            // محاولة اصطياد الصورة
            let image = $(el).find('img').attr('src');
            
            // اصطياد المؤلف
            let author = $(el).find('.author').text().trim().replace('by ', '');
            if (!author) author = "Unknown";

            // اصطياد التقييم
            let rating = '4.5';
            const starTitle = $(el).find('.star').attr('title');
            if (starTitle) rating = starTitle.substring(0, 3);

            // ⚠️ الفلتر الأمني: لو مفيش عنوان أو مفيش صورة، متقبلش الرواية دي
            if (title && title.length > 1 && urlPart && image) {
                novels.push({
                    id: urlPart,
                    title: title,
                    image: image,
                    author: author,
                    rating: rating,
                    source: 'royalroad'
                });
            }
        });

        console.log(`✅ Found ${novels.length} valid results.`);
        res.json(novels);

    } catch (error) {
        console.error("Search failed:", error.message);
        res.json([]); 
    }
});

app.get('/novels', async (req, res) => {
    const page = req.query.page || 1;
    const category = req.query.category || 'all';
    const genreMap = { 'all': '', 'action': 'action', 'adventure': 'adventure', 'fantasy': 'fantasy', 'mystery': 'mystery', 'horror': 'horror', 'scifi': 'sci_fi' };
    
    let targetUrl = `${BASE_URL}/fictions/best-rated`;
    const params = [`page=${page}`];
    if (genreMap[category]) params.push(`genre=${genreMap[category]}`);
    targetUrl += `?${params.join('&')}`;

    try {
        const response = await axios.get(targetUrl, { headers });
        const $ = cheerio.load(response.data);
        const novels = [];
        $('.fiction-list-item').each((i, el) => {
            const title = $(el).find('.fiction-title').text().trim();
            const urlPart = $(el).find('.fiction-title a').attr('href');
            const image = $(el).find('img').attr('src');
            const author = $(el).find('.author').text().trim().replace('by ', '');
            const rating = $(el).find('.star').attr('title') || '4.5';
            if (title && urlPart && image) novels.push({ id: urlPart, title, image, author, rating: rating.substring(0, 3), source: 'royalroad' });
        });
        if (novels.length > 0) {
            // حفظ بسيط
            novels.forEach(n => query(`INSERT INTO novels (source_id, title, cover_url, rating, status, synced_at) VALUES ($1, $2, $3, $4, 'ongoing', NOW()) ON CONFLICT (source_id) DO NOTHING`, [n.id, n.title, n.image, n.rating]).catch(()=>{}));
            res.json(novels);
        } else res.json([]);
    } catch (error) { res.json([]); }
});

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
        res.json({ description, chapters });
    } catch (error) { res.json({ description: "Error", chapters: [] }); }
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
    } catch (error) { res.json({ content: "Error" }); }
});

app.get('/init-db', async (req, res) => { res.send("DB Ready"); });
app.get('/', (req, res) => res.send("Nova Server + Translate 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = app;
