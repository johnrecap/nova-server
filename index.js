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
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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

// --- دوال مساعدة ---
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

const mapGoogleBook = (item) => {
    const info = item.volumeInfo;
    return {
        id: item.id, 
        title: info.title,
        image: (info.imageLinks?.thumbnail || '').replace('http://', 'https://'),
        author: info.authors ? info.authors[0] : 'Unknown',
        rating: info.averageRating ? info.averageRating.toString() : '4.5',
        source: 'google'
    };
};

// --- الروابط الأساسية ---

// 1. جلب الروايات (التعديل هنا 👇)
app.get('/novels', async (req, res) => {
    const page = req.query.page || 1;
    const category = req.query.category || 'all';
    
    // خريطة التصنيفات
    const genreMap = {
        'all': 'active',
        'fantasy': 'active?genre=fantasy',
        'action': 'active?genre=action',
        'adventure': 'active?genre=adventure',
        'mystery': 'active?genre=mystery',
        'horror': 'active?genre=horror',
        'scifi': 'active?genre=sci_fi'
    };

    let urlPath = genreMap[category] || 'active';
    
    // ✅ التصحيح: التأكد من العلامة المناسبة (? أو &)
    const separator = urlPath.includes('?') ? '&' : '?';
    const targetUrl = `${BASE_URL}/fictions/${urlPath}${separator}page=${page}`;

    console.log(`Fetching: ${targetUrl}`);

    try {
        const response = await axios.get(targetUrl, { headers, timeout: 10000 }); // زودنا الوقت لـ 10 ثواني
        const $ = cheerio.load(response.data);
        const novels = [];

        $('.fiction-list-item').each((i, el) => {
            const title = $(el).find('.fiction-title').text().trim();
            const urlPart = $(el).find('.fiction-title a').attr('href');
            const image = $(el).find('img').attr('src');
            const author = $(el).find('.author').text().trim().replace('by ', '');
            const rating = $(el).find('.star').attr('title') || '4.5';
            
            if (title && urlPart) {
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
            // لو لقينا روايات، نحفظهم ونرجعهم
            await saveImportedNovels(novels);
            return res.json(novels);
        }
        
        throw new Error("No novels found via scraping");

    } catch (error) {
        console.error("Scraping failed, switching to Backup plan...");
        
        // الخطة ب (Backup): لو Royal Road فشل، هات من Google Books عشان الشاشة متبقاش فاضية
        try {
            const googleQuery = category === 'all' ? 'fantasy' : category;
            const googleRes = await axios.get(`https://www.googleapis.com/books/v1/volumes?q=subject:${googleQuery}&orderBy=newest&startIndex=${(page-1)*10}&maxResults=10&langRestrict=en`);
            
            if (googleRes.data.items) {
                const gNovels = googleRes.data.items.map(mapGoogleBook);
                res.json(gNovels); // ارجع روايات جوجل
            } else {
                res.json([]); // مفيش أمل
            }
        } catch (gError) {
            res.json([]); 
        }
    }
});

// 2. التفاصيل
app.get('/details', async (req, res) => {
    const url = req.query.url;
    
    // لو الرواية جاية من Google (الـ ID بتاعها مش رابط)
    if (!url.includes('/fiction/')) {
        return res.json({ description: "Book from Google Library.", chapters: [{title: "Read Preview", url: url}] });
    }

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

        await query(`UPDATE novels SET description = $1, total_chapters = $2, cover_url = $3 WHERE source_id = $4`, [description, chapters.length, image, url]);
        
        // حفظ الفصول (أول 50)
        const novelRes = await query(`SELECT novel_id FROM novels WHERE source_id = $1`, [url]);
        if (novelRes.rows.length > 0) {
             const novelId = novelRes.rows[0].novel_id;
             for (let i = 0; i < Math.min(chapters.length, 50); i++) {
                const ch = chapters[i];
                await query(`INSERT INTO chapters (novel_id, chapter_number, title, url) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [novelId, i + 1, ch.title, ch.url]);
            }
        }
        res.json({ description, chapters });
    } catch (error) { res.json({ description: "Error loading details", chapters: [] }); }
});

// 3. القراءة
app.get('/read', async (req, res) => {
    const url = req.query.url;
    
    // Google Preview Logic
    if (!url.includes('/fiction/')) {
        try {
            const gRes = await axios.get(`https://www.googleapis.com/books/v1/volumes/${url}`);
            const desc = (gRes.data.volumeInfo.description || "").replace(/<[^>]*>?/gm, '');
            return res.json({ title: "Preview", content: desc });
        } catch (e) { return res.json({ content: "Content not available." }); }
    }

    try {
        const response = await axios.get(`${BASE_URL}${url}`, { headers });
        const $ = cheerio.load(response.data);
        let content = $('.chapter-content').text().trim().replace(/\n\s*\n/g, '\n\n');
        const title = $('h1').text().trim();
        await query('UPDATE chapters SET content = $1 WHERE url = $2', [content, url]);
        res.json({ title, content });
    } catch (error) { res.json({ content: "Failed to load chapter." }); }
});

app.get('/init-db', async (req, res) => { res.send("DB is ready"); });
app.get('/', (req, res) => res.send("Nova Server Fixed & Ready! 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = app;
