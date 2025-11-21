const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
};

const BASE_URL = 'https://www.royalroad.com';

// دالة مساعدة لاستخراج البيانات من كارت الرواية
const extractNovelData = ($, element) => {
    const title = $(element).find('.fiction-title').text().trim();
    const urlPath = $(element).find('.fiction-title a').attr('href');
    const image = $(element).find('img').attr('src');
    const author = $(element).find('.author').text().trim().replace('by ', '');
    const rating = $(element).find('.star').attr('title') || '4.5';
    
    if (title && urlPath) {
        return {
            id: urlPath, // الرابط هو المعرف
            title,
            image,
            author,
            rating: rating.substring(0, 3),
            summary: "اضغط للتفاصيل..."
        };
    }
    return null;
};

// 1. الرئيسية (الأكثر شهرة)
app.get('/novels', async (req, res) => {
    console.log("📡 جلب الروايات المشهورة...");
    try {
        const response = await axios.get(`${BASE_URL}/fictions/weekly-popular`, { headers });
        const $ = cheerio.load(response.data);
        const novels = [];

        $('.fiction-list-item').each((i, el) => {
            const novel = extractNovelData($, el);
            if (novel) novels.push(novel);
        });

        res.json(novels);
    } catch (error) {
        res.status(500).json([]);
    }
});

// 2. البحث (ميزة جديدة 🔥)
app.get('/search', async (req, res) => {
    const query = req.query.q;
    console.log(`🔍 جاري البحث عن: ${query}`);
    try {
        const response = await axios.get(`${BASE_URL}/fictions/search?title=${encodeURIComponent(query)}`, { headers });
        const $ = cheerio.load(response.data);
        const novels = [];

        $('.fiction-list-item').each((i, el) => {
            const novel = extractNovelData($, el);
            if (novel) novels.push(novel);
        });

        res.json(novels);
    } catch (error) {
        res.status(500).json([]);
    }
});

// 3. تفاصيل الرواية + قائمة الفصول (ميزة جديدة 🔥)
app.get('/details', async (req, res) => {
    const novelUrl = req.query.url;
    console.log(`📑 جلب فصول الرواية: ${novelUrl}`);
    try {
        const response = await axios.get(`${BASE_URL}${novelUrl}`, { headers });
        const $ = cheerio.load(response.data);

        // جلب الوصف
        const description = $('.description').text().trim();
        
        // جلب الفصول
        const chapters = [];
        $('#chapters tbody tr').each((i, el) => {
            const link = $(el).find('a').attr('href');
            const title = $(el).find('a').text().trim();
            if (link) {
                chapters.push({
                    title: title,
                    url: link
                });
            }
        });

        res.json({ description, chapters });
    } catch (error) {
        res.status(500).json({ description: "خطأ", chapters: [] });
    }
});

// 4. قراءة فصل محدد
app.get('/read', async (req, res) => {
    const chapterUrl = req.query.url;
    try {
        const response = await axios.get(`${BASE_URL}${chapterUrl}`, { headers });
        const $ = cheerio.load(response.data);
        let content = $('.chapter-content').text().trim();
        content = content.replace(/\n\s*\n/g, '\n\n');
        const title = $('h1').text().trim();

        res.json({ title, content });
    } catch (error) {
        res.status(500).json({ content: "فشل تحميل الفصل." });
    }
});

// التعديل: بنقوله استخدم البورت اللي الموقع بيديهولك، ولو مفيش استخدم 3000
const PORT = process.env.PORT || 3000; 

app.listen(PORT, () => {
    console.log(`🚀 Server is running!`);
});