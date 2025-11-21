const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const { query } = require('./db'); // استدعاء الاتصال بقاعدة البيانات

const app = express();
app.use(cors());
app.use(express.json());

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
};

const BASE_URL = 'https://www.royalroad.com';

// --- دوال مساعدة للتعامل مع قاعدة البيانات ---

// حفظ الرواية والفصول في قاعدة البيانات
async function saveNovelToDB(novelData, chapters) {
    try {
        // 1. إدخال الرواية أو تحديثها إذا كانت موجودة
        const novelQuery = `
            INSERT INTO novels (source_id, title, author, cover_url, description, rating, total_chapters, synced_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            ON CONFLICT (source_id) 
            DO UPDATE SET 
                title = EXCLUDED.title,
                total_chapters = EXCLUDED.total_chapters,
                synced_at = NOW()
            RETURNING novel_id;
        `;
        
        const novelValues = [
            novelData.id, novelData.title, novelData.author, 
            novelData.image, novelData.summary, novelData.rating, chapters.length
        ];
        
        const res = await query(novelQuery, novelValues);
        const novelId = res.rows[0].novel_id;

        // 2. إدخال الفصول (فقط إذا لم تكن موجودة)
        // ملاحظة: هذا تبسيط، في الإنتاج نستخدم Bulk Insert
        for (let i = 0; i < chapters.length; i++) {
            const ch = chapters[i];
            await query(`
                INSERT INTO chapters (novel_id, chapter_number, title, url)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT DO NOTHING
            `, [novelId, i + 1, ch.title, ch.url]);
        }
        console.log(`✅ Saved novel: ${novelData.title}`);
    } catch (e) {
        console.error("Error saving novel:", e);
    }
}

// حفظ محتوى الفصل عند القراءة
async function saveChapterContent(url, content) {
    try {
        await query(`
            UPDATE chapters SET content = $1, synced_at = NOW()
            WHERE url = $2
        `, [content, url]);
    } catch (e) {
        console.error("Error saving content:", e);
    }
}

// دالة تحويل بيانات جوجل
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

// --- الروابط (Endpoints) ---

// 1. الرئيسية (Discovery)
app.get('/novels', async (req, res) => {
    // هنا سنجلب البيانات الطازجة دائمًا من المصادر
    // ولكن مستقبلاً يمكننا جلب "الأكثر قراءة" من قاعدة البيانات
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

            if (title && urlPath) {
                novels.push({
                    id: urlPath,
                    title, image, author, rating: rating.substring(0, 3),
                    summary: "Tap to read...",
                    source: 'royalroad'
                });
            }
        });
        res.json(novels.length > 0 ? novels : []);
    } catch (error) {
        // Fallback to Google
        try {
            const googleRes = await axios.get('https://www.googleapis.com/books/v1/volumes?q=subject:fantasy+litrpg&orderBy=newest&maxResults=20&langRestrict=en');
            res.json(googleRes.data.items.map(mapGoogleBook));
        } catch (e) { res.json([]); }
    }
});

// 2. البحث
app.get('/search', async (req, res) => {
    const q = req.query.q;
    try {
        const googleRes = await axios.get(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=15&langRestrict=en`);
        res.json(googleRes.data.items.map(mapGoogleBook));
    } catch (error) { res.json([]); }
});

// 3. التفاصيل (ذكي: DB أولاً -> ثم Web)
app.get('/details', async (req, res) => {
    const url = req.query.url; // هذا هو source_id

    try {
        // أ: التحقق من قاعدة البيانات
        const dbCheck = await query(`
            SELECT n.*, json_agg(json_build_object('title', c.title, 'url', c.url)) as chapters
            FROM novels n
            LEFT JOIN chapters c ON n.novel_id = c.novel_id
            WHERE n.source_id = $1
            GROUP BY n.novel_id
        `, [url]);

        if (dbCheck.rows.length > 0 && dbCheck.rows[0].total_chapters > 0) {
            console.log("🚀 Served from DB!");
            return res.json({
                description: dbCheck.rows[0].description,
                chapters: dbCheck.rows[0].chapters
            });
        }
    } catch (e) { console.error("DB Check failed, falling back to web"); }

    // ب: الجلب من الويب (Scraping)
    if (!url.includes('/fiction/')) {
        // Google Book logic (No chapters usually)
        return res.json({ description: "From Google Books", chapters: [{title: "Read Full", url: url}] });
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

        // ج: حفظ في قاعدة البيانات للمستقبل
        saveNovelToDB({ id: url, title, image, author, summary: description, rating: '4.5' }, chapters);

        res.json({ description, chapters });
    } catch (error) {
        res.json({ description: "Error loading details", chapters: [] });
    }
});

// 4. القراءة (ذكي: DB أولاً -> ثم Web)
app.get('/read', async (req, res) => {
    const url = req.query.url;

    try {
        // أ: التحقق من قاعدة البيانات
        const dbCh = await query('SELECT content, title FROM chapters WHERE url = $1', [url]);
        if (dbCh.rows.length > 0 && dbCh.rows[0].content) {
            console.log("📖 Chapter served from DB!");
            return res.json({ title: dbCh.rows[0].title, content: dbCh.rows[0].content });
        }
    } catch (e) {}

    // ب: الجلب من الويب
    if (!url.includes('/fiction/')) {
        // Google logic
        try {
            const gRes = await axios.get(`https://www.googleapis.com/books/v1/volumes/${url}`);
            const desc = (gRes.data.volumeInfo.description || "").replace(/<[^>]*>?/gm, '');
            return res.json({ title: "Preview", content: desc });
        } catch (e) { return res.json({ content: "Error" }); }
    }

    // Royal Road Logic
    try {
        const response = await axios.get(`${BASE_URL}${url}`, { headers });
        const $ = cheerio.load(response.data);
        let content = $('.chapter-content').text().trim();
        content = content.replace(/\n\s*\n/g, '\n\n'); 
        const title = $('h1').text().trim();

        // ج: الحفظ في قاعدة البيانات
        saveChapterContent(url, content);

        res.json({ title, content });
    } catch (error) {
        res.json({ content: "Failed to load chapter." });
    }
});

// 5. التصنيفات
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
