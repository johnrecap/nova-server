const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Referer': 'https://www.google.com/'
};

const BASE_URL = 'https://www.royalroad.com';

// دالة لتحويل بيانات جوجل لشكل بياناتنا
const mapGoogleBook = (item) => {
    const info = item.volumeInfo;
    return {
        id: item.id, // بنستخدم ID جوجل
        title: info.title,
        image: (info.imageLinks?.thumbnail || '').replace('http://', 'https://'),
        author: info.authors ? info.authors[0] : 'Unknown',
        rating: info.averageRating ? info.averageRating.toString() : '4.5',
        summary: info.description || "No description available.",
        source: 'google' // علامة عشان نعرف المصدر
    };
};

// 1. الرئيسية (المحاولة المزدوجة)
app.get('/novels', async (req, res) => {
    try {
        console.log("1️⃣ محاولة Royal Road...");
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

        if (novels.length > 0) {
            console.log("✅ نجح Royal Road!");
            return res.json(novels);
        }
        throw new Error("No novels found");

    } catch (error) {
        console.log("⚠️ فشل Royal Road، جاري التحويل لـ Google Books...");
        try {
            // الخطة البديلة: نجيب روايات LitRPG و Fantasy من جوجل
            const googleRes = await axios.get('https://www.googleapis.com/books/v1/volumes?q=subject:fantasy+litrpg&orderBy=newest&maxResults=20&langRestrict=en');
            const googleNovels = googleRes.data.items.map(mapGoogleBook);
            res.json(googleNovels);
        } catch (gError) {
            res.json([]); // لو كله فشل نرجع فاضي (أحسن من القصتين القدام)
        }
    }
});

// 2. البحث (يدعم جوجل أيضاً)
app.get('/search', async (req, res) => {
    const query = req.query.q;
    try {
        // بحث جوجل أضمن وأسرع
        const googleRes = await axios.get(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=15&langRestrict=en`);
        const googleNovels = googleRes.data.items.map(mapGoogleBook);
        res.json(googleNovels);
    } catch (error) {
        res.json([]);
    }
});

// 3. التفاصيل والفصول
app.get('/details', async (req, res) => {
    const url = req.query.url;
    
    // لو الرواية جاية من جوجل (الـ ID بتاعها مش رابط)
    if (!url.includes('/fiction/')) {
        return res.json({ 
            description: "قراءة ممتعة من مكتبة جوجل.", 
            chapters: [{ title: "اقرأ الكتاب كامل", url: url }] // فصل واحد وهمي
        });
    }

    // لو من Royal Road
    try {
        const response = await axios.get(`${BASE_URL}${url}`, { headers });
        const $ = cheerio.load(response.data);
        const description = $('.description').text().trim();
        const chapters = [];
        $('#chapters tbody tr').each((i, el) => {
            const link = $(el).find('a').attr('href');
            const title = $(el).find('a').text().trim();
            if (link) chapters.push({ title, url: link });
        });
        res.json({ description, chapters });
    } catch (error) {
        res.json({ description: "خطأ في التحميل", chapters: [] });
    }
});

// 4. القراءة
app.get('/read', async (req, res) => {
    const url = req.query.url;

    // لو جوجل (مافيش نص كامل، بنجيب الوصف كأنه فصل)
    if (!url.includes('/fiction/')) {
        try {
            const gRes = await axios.get(`https://www.googleapis.com/books/v1/volumes/${url}`);
            const desc = gRes.data.volumeInfo.description || "عذراً، نص هذا الكتاب غير متاح للقراءة المباشرة بسبب حقوق النشر.";
            // تنظيف النص من كود HTML
            const cleanDesc = desc.replace(/<[^>]*>?/gm, ''); 
            return res.json({ title: "نظرة عامة", content: cleanDesc });
        } catch (e) { return res.json({ content: "Error loading content." }); }
    }

    // لو Royal Road
    try {
        const response = await axios.get(`${BASE_URL}${url}`, { headers });
        const $ = cheerio.load(response.data);
        let content = $('.chapter-content').text().trim();
        content = content.replace(/\n\s*\n/g, '\n\n'); 
        const title = $('h1').text().trim();
        res.json({ title, content });
    } catch (error) {
        res.json({ content: "Failed to load chapter. Source might be protected." });
    }
});

// 5. التصنيفات (جديد)
app.get('/genre', async (req, res) => {
    const tag = req.query.tag;
    // بنستخدم جوجل للتصنيفات لأنها مضمونة
    try {
        const response = await axios.get(`https://www.googleapis.com/books/v1/volumes?q=subject:${tag}&orderBy=relevance&maxResults=20&langRestrict=en`);
        const novels = response.data.items.map(mapGoogleBook);
        res.json(novels);
    } catch (error) { res.json([]); }
});

module.exports = app;
