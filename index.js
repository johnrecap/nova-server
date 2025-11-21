const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const { query } = require('./db'); 

const app = express();
app.use(cors());
app.use(express.json());

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
};

const BASE_URL = 'https://www.royalroad.com';

// --- 🛠️ الزرار السحري: رابط لإنشاء الجداول (شغله مرة واحدة بس) ---
app.get('/init-db', async (req, res) => {
    const createTablesQuery = `
      CREATE TABLE IF NOT EXISTS users (
        user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        username VARCHAR(100),
        auth_method VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS novels (
        novel_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_id VARCHAR(255) UNIQUE,
        title VARCHAR(500),
        author VARCHAR(255),
        cover_url TEXT,
        description TEXT,
        status VARCHAR(50),
        rating VARCHAR(10),
        total_chapters INT DEFAULT 0,
        synced_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS chapters (
        chapter_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        novel_id UUID REFERENCES novels(novel_id) ON DELETE CASCADE,
        chapter_number INT,
        title VARCHAR(500),
        url VARCHAR(500),
        content TEXT,
        synced_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS user_library (
        library_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        novel_id UUID REFERENCES novels(novel_id) ON DELETE CASCADE,
        added_at TIMESTAMP DEFAULT NOW(),
        current_chapter INT DEFAULT 1,
        UNIQUE(user_id, novel_id)
      );

      CREATE TABLE IF NOT EXISTS user_stats (
        stats_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        level INT DEFAULT 1,
        total_xp INT DEFAULT 0,
        reading_time_minutes INT DEFAULT 0
      );
    `;

    try {
        await query(createTablesQuery);
        res.send("✅ Database Tables Created Successfully! (مبروك، الجداول اتعملت)");
    } catch (e) {
        res.status(500).send("❌ Error creating tables: " + e.message);
    }
});

// --- باقي الكود (حفظ وجلب الروايات) ---

async function saveNovelToDB(novelData, chapters) {
    try {
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
        const values = [novelData.id, novelData.title, novelData.author, novelData.image, novelData.summary, novelData.rating, chapters.length];
        const res = await query(novelQuery, values);
        const novelId = res.rows[0].novel_id;

        // إدخال الفصول (بحد أقصى 50 فصل في المرة الواحدة لتجنب الضغط)
        for (let i = 0; i < Math.min(chapters.length, 50); i++) {
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

async function saveChapterContent(url, content) {
    try {
        await query('UPDATE chapters SET content = $1, synced_at = NOW() WHERE url = $2', [content, url]);
    } catch (e) { console.error("Error saving content:", e); }
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

app.get('/', (req, res) => {
    res.send("Nova Server is Running! 🚀 Go to /init-db to setup database.");
});

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
            console.log("🚀 Served from DB!");
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

    if (!url.includes('/fiction/')) return res.json({ content: "Google Book content unavailable." });

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
