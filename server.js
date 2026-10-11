const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

// الاتصال بقاعدة بيانات PostgreSQL
const connectionString = process.env.DATABASE_URL || 'postgresql://sqlite_data_pk5r_user:k2mq3R6TCkI29LWipvlRsAHqJy8Lptuo@dpg-db1ml097lnhs73dl51p0-a/sqlite_data_pk5r';

const pool = new Pool({
    connectionString: connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'application/pdf',
            'image/jpeg',
            'image/png',
            'image/webp',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel'
        ];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('نوع الملف غير مسموح به!'));
        }
    }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/', express.static(__dirname));
app.set('view engine', 'ejs');

app.use(session({
    secret: process.env.SESSION_SECRET || 'institute-forum-secure-2026',
    resave: false,
    saveUninitialized: false
}));

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS allowed_students (
            national_id VARCHAR(50) PRIMARY KEY,
            full_name VARCHAR(255) NOT NULL
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            national_id VARCHAR(50) UNIQUE,
            display_name VARCHAR(255),
            password VARCHAR(255),
            role VARCHAR(50) DEFAULT 'student',
            is_banned INT DEFAULT 0,
            ban_reason TEXT
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS posts (
            id SERIAL PRIMARY KEY,
            user_id INT REFERENCES users(id) ON DELETE CASCADE,
            content TEXT,
            file_path TEXT,
            file_type VARCHAR(50),
            media_status VARCHAR(50) DEFAULT 'approved',
            is_pinned INT DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS comments (
            id SERIAL PRIMARY KEY,
            post_id INT REFERENCES posts(id) ON DELETE CASCADE,
            user_id INT REFERENCES users(id) ON DELETE CASCADE,
            content TEXT NOT NULL,
            is_hidden INT DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS reports (
            id SERIAL PRIMARY KEY,
            reporter_id INT REFERENCES users(id) ON DELETE CASCADE,
            target_type VARCHAR(50) NOT NULL,
            target_id INT NOT NULL,
            reason TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS likes (
            id SERIAL PRIMARY KEY,
            user_id INT REFERENCES users(id) ON DELETE CASCADE,
            target_type VARCHAR(50) NOT NULL,
            target_id INT NOT NULL,
            UNIQUE(user_id, target_type, target_id)
        );
    `);

    const ADMIN_NID = "29000000000000";
    const adminCheck = await pool.query('SELECT * FROM users WHERE role = $1 OR national_id = $2', ['admin', ADMIN_NID]);
    const hashedAdminPass = await bcrypt.hash('admin2026Pass', 10);

    if (adminCheck.rows.length === 0) {
        await pool.query('INSERT INTO users (national_id, display_name, password, role) VALUES ($1, $2, $3, $4)', [ADMIN_NID, 'إدارة المعهد', hashedAdminPass, 'admin']);
    } else {
        await pool.query('UPDATE users SET national_id = $1, password = $2 WHERE role = $3', [ADMIN_NID, hashedAdminPass, 'admin']);
    }

    console.log(`⚡ تم تهيئة قاعدة البيانات بنجاح.`);
}

function isAuthenticated(req, res, next) {
    if (req.session && req.session.user) {
        if (req.session.user.is_banned) {
            req.session.destroy();
            return res.status(403).json({ success: false, error: 'تم حظر حسابك من استخدام المنصة.' });
        }
        return next();
    }
    if (req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('json'))) {
        return res.status(401).json({ success: false, error: 'غير مسجل الدخول' });
    }
    res.redirect('/login');
}

function isAdmin(req, res, next) {
    if (req.session && req.session.user && req.session.user.role === 'admin') return next();
    res.status(403).send('غير مصرح لك بالوصول.');
}

function deleteFileIfExists(filePath) {
    if (!filePath) return;
    const fullPath = path.join(__dirname, filePath);
    if (fs.existsSync(fullPath)) {
        try { fs.unlinkSync(fullPath); } catch (e) { console.error('خطأ حذف الملف:', e); }
    }
}

// --- Auth Routes ---

app.get('/login', (req, res) => {
    res.render('login', { error: null, needPasswordSetup: false, national_id: null });
});

app.post('/login', async (req, res) => {
    try {
        const { national_id, password } = req.body;
        const cleanId = national_id ? national_id.trim() : '';

        const userRes = await pool.query('SELECT * FROM users WHERE national_id = $1', [cleanId]);
        const user = userRes.rows[0];

        if (user && user.is_banned) {
            return res.render('login', { error: `تم حظر هذا الحساب. سبب الحظر: (${user.ban_reason || 'مخالفة الشروط'})`, needPasswordSetup: false, national_id: null });
        }

        if (cleanId === '29000000000000') {
            if (!password) return res.render('login', { error: 'يرجى كتابة كلمة مرور الأدمن.', needPasswordSetup: false, national_id: cleanId });
            
            const isMatch = user && user.password ? await bcrypt.compare(password, user.password) : (password === 'admin2026Pass');
            if (isMatch) {
                req.session.user = user || { id: 1, national_id: '29000000000000', display_name: 'إدارة المعهد', role: 'admin' };
                return res.redirect('/admin');
            } else {
                return res.render('login', { error: 'كلمة مرور الأدمن غير صحيحة!', needPasswordSetup: false, national_id: cleanId });
            }
        }

        const allowedRes = await pool.query('SELECT * FROM allowed_students WHERE national_id = $1', [cleanId]);
        const allowed = allowedRes.rows[0];

        if (!allowed) {
            return res.render('login', { error: 'الرقم القومي غير مسجل في القائمة المعتمدة للطلاب.', needPasswordSetup: false, national_id: null });
        }

        if (!user || !user.password) {
            return res.render('login', { 
                error: null, 
                needPasswordSetup: true, 
                national_id: cleanId,
                studentName: allowed.full_name 
            });
        }

        if (!password) {
            return res.render('login', { error: 'يرجى كتابة كلمة المرور.', needPasswordSetup: false, national_id: cleanId });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.render('login', { error: 'كلمة المرور غير صحيحة!', needPasswordSetup: false, national_id: cleanId });
        }

        req.session.user = user;
        res.redirect('/');
    } catch (err) {
        console.error('Login Error:', err);
        res.render('login', { error: 'حدث خطأ غير متوقع أثناء تسجيل الدخول.', needPasswordSetup: false, national_id: null });
    }
});

app.post('/set-password', async (req, res) => {
    try {
        const { national_id, password, confirm_password } = req.body;

        if (!password || password.length < 6) {
            return res.render('login', { error: 'كلمة المرور يجب أن تكون 6 أحرف/أرقام على الأقل.', needPasswordSetup: true, national_id, studentName: '' });
        }

        if (password !== confirm_password) {
            return res.render('login', { error: 'كلمتا المرور غير متطابقتين!', needPasswordSetup: true, national_id, studentName: '' });
        }

        const allowedRes = await pool.query('SELECT * FROM allowed_students WHERE national_id = $1', [national_id]);
        const allowed = allowedRes.rows[0];
        if (!allowed) return res.redirect('/login');

        const hashedPassword = await bcrypt.hash(password, 10);
        const userRes = await pool.query('SELECT * FROM users WHERE national_id = $1', [national_id]);
        let user = userRes.rows[0];

        if (user) {
            await pool.query('UPDATE users SET password = $1 WHERE national_id = $2', [hashedPassword, national_id]);
            user.password = hashedPassword;
        } else {
            const insertRes = await pool.query('INSERT INTO users (national_id, display_name, password) VALUES ($1, $2, $3) RETURNING id', [national_id, allowed.full_name, hashedPassword]);
            user = { id: insertRes.rows[0].id, national_id, display_name: allowed.full_name, role: 'student', is_banned: 0 };
        }

        req.session.user = user;
        res.redirect('/');
    } catch (err) {
        console.error('Set Password Error:', err);
        res.redirect('/login');
    }
});

// --- Main Feed Routes ---

app.get('/', isAuthenticated, async (req, res) => {
    try {
        const searchQuery = req.query.search ? `%${req.query.search.trim()}%` : null;
        const currentUserId = req.session.user ? req.session.user.id : 0;

        let postsQuery = `
            SELECT posts.*, users.display_name, users.role 
            FROM posts 
            JOIN users ON posts.user_id = users.id 
            WHERE (posts.media_status = 'approved' OR posts.user_id = $1)
        `;
        let queryParams = [currentUserId];

        if (searchQuery) {
            postsQuery += ` AND (posts.content LIKE $2 OR users.display_name LIKE $2)`;
            queryParams.push(searchQuery);
        }

        postsQuery += ` ORDER BY posts.is_pinned DESC, posts.created_at DESC`;

        const postsRes = await pool.query(postsQuery, queryParams);
        const posts = postsRes.rows;

        for (let post of posts) {
            const commentsRes = await pool.query(`
                SELECT comments.*, users.display_name 
                FROM comments 
                JOIN users ON comments.user_id = users.id 
                WHERE comments.post_id = $1 AND (comments.is_hidden IS NULL OR comments.is_hidden = 0)
                ORDER BY comments.created_at ASC
            `, [post.id]);
            post.comments = commentsRes.rows;

            const postLikesCount = await pool.query('SELECT COUNT(*) FROM likes WHERE target_type = $1 AND target_id = $2', ['post', post.id]);
            const postUserLiked = await pool.query('SELECT id FROM likes WHERE target_type = $1 AND target_id = $2 AND user_id = $3', ['post', post.id, currentUserId]);
            
            post.likes_count = parseInt(postLikesCount.rows[0].count);
            post.is_liked = postUserLiked.rows.length > 0;

            for (let comment of post.comments) {
                const commentLikesCount = await pool.query('SELECT COUNT(*) FROM likes WHERE target_type = $1 AND target_id = $2', ['comment', comment.id]);
                const commentUserLiked = await pool.query('SELECT id FROM likes WHERE target_type = $1 AND target_id = $2 AND user_id = $3', ['comment', comment.id, currentUserId]);
                
                comment.likes_count = parseInt(commentLikesCount.rows[0].count);
                comment.is_liked = commentUserLiked.rows.length > 0;
            }
        }

        res.render('index', { user: req.session.user, posts, search: req.query.search || '' });
    } catch (err) {
        console.error('Home Route Error:', err);
        res.status(500).send('حدث خطأ أثناء تحميل الساحة الرئيسية.');
    }
});

// API المزامنة اللحظية الشاملة (للإشعارات، المنشورات، التثبيت، والتعليقات واللايكات)
app.get('/api/live-sync', isAuthenticated, async (req, res) => {
    try {
        const lastPostId = parseInt(req.query.lastPostId) || 0;
        const currentUserId = req.session.user.id;

        // جلب المنشورات الجديدة
        const newPostsRes = await pool.query(`
            SELECT posts.*, users.display_name, users.role 
            FROM posts 
            JOIN users ON posts.user_id = users.id 
            WHERE posts.id > $1 AND (posts.media_status = 'approved' OR posts.user_id = $2)
            ORDER BY posts.id ASC
        `, [lastPostId, currentUserId]);

        const newPosts = newPostsRes.rows;

        for (let post of newPosts) {
            const commentsRes = await pool.query(`
                SELECT comments.*, users.display_name 
                FROM comments 
                JOIN users ON comments.user_id = users.id 
                WHERE comments.post_id = $1 AND (comments.is_hidden IS NULL OR comments.is_hidden = 0)
                ORDER BY comments.created_at ASC
            `, [post.id]);
            post.comments = commentsRes.rows;

            const postLikesCount = await pool.query('SELECT COUNT(*) FROM likes WHERE target_type = $1 AND target_id = $2', ['post', post.id]);
            const postUserLiked = await pool.query('SELECT id FROM likes WHERE target_type = $1 AND target_id = $2 AND user_id = $3', ['post', post.id, currentUserId]);
            
            post.likes_count = parseInt(postLikesCount.rows[0].count);
            post.is_liked = postUserLiked.rows.length > 0;
        }

        // جلب أحدث أعداد الإعجابات لجميع العناصر
        const allLikesRes = await pool.query(`
            SELECT target_type, target_id, COUNT(*) as count 
            FROM likes 
            GROUP BY target_type, target_id
        `);

        // جلب أحدث التعليقات التي أضيفت على منشورات المستخدم أو تعليقات عامة لتوليد الإشعارات الفورية
        const recentActivityRes = await pool.query(`
            SELECT comments.id, comments.post_id, comments.content, comments.created_at, 
                   users.display_name as commenter_name, posts.user_id as post_owner_id, posts.is_pinned
            FROM comments
            JOIN users ON comments.user_id = users.id
            JOIN posts ON comments.post_id = posts.id
            WHERE comments.user_id != $1 AND comments.created_at >= (NOW() - INTERVAL '10 seconds')
        `, [currentUserId]);

        // جلب إشعارات الإعجابات الحديثة على منشورات أو تعليقات المستخدم
        const recentLikesRes = await pool.query(`
            SELECT likes.target_type, likes.target_id, users.display_name as liker_name, posts.user_id as post_owner_id
            FROM likes
            JOIN users ON likes.user_id = users.id
            LEFT JOIN posts ON likes.target_type = 'post' AND likes.target_id = posts.id
            WHERE likes.user_id != $1 
            ORDER BY likes.id DESC LIMIT 5
        `, [currentUserId]);

        res.json({
            success: true,
            newPosts: newPosts,
            likesData: allLikesRes.rows,
            recentComments: recentActivityRes.rows,
            recentLikes: recentLikesRes.rows
        });
    } catch (err) {
        console.error('Live Sync Error:', err);
        res.status(500).json({ success: false });
    }
});

// إنشاء منشور جديد
app.post('/posts', isAuthenticated, upload.single('attachment'), async (req, res) => {
    try {
        const { content } = req.body;
        let filePath = null;
        let fileType = null;
        let mediaStatus = 'approved';

        if (req.file) {
            filePath = '/uploads/' + req.file.filename;
            if (req.file.mimetype.startsWith('image/')) {
                fileType = 'image';
                mediaStatus = (req.session.user.role === 'admin') ? 'approved' : 'pending';
            } else if (req.file.mimetype === 'application/pdf') {
                fileType = 'pdf';
                mediaStatus = 'approved';
            }
        }

        if (content || filePath) {
            const newPostRes = await pool.query(
                'INSERT INTO posts (user_id, content, file_path, file_type, media_status) VALUES ($1, $2, $3, $4, $5) RETURNING *',
                [req.session.user.id, content, filePath, fileType, mediaStatus]
            );
            
            const post = newPostRes.rows[0];
            
            return res.json({
                success: true,
                message: mediaStatus === 'pending' ? 'تم نشر المنشور وسوف تظهر الصورة فور مراجعتها.' : 'تم نشر الموضوع بنجاح!',
                post: {
                    id: post.id,
                    content: post.content,
                    file_path: post.file_path,
                    file_type: post.file_type,
                    media_status: post.media_status,
                    is_pinned: 0,
                    created_at: post.created_at,
                    display_name: req.session.user.display_name,
                    role: req.session.user.role,
                    likes_count: 0,
                    is_liked: false,
                    comments: []
                }
            });
        }
        res.status(400).json({ success: false, error: 'يرجى كتابة نص أو إرفاق ملف.' });
    } catch (err) {
        console.error('Create Post Error:', err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء النشر.' });
    }
});

// إضافة تعليق
app.post('/posts/:id/comments', isAuthenticated, async (req, res) => {
    try {
        const { content } = req.body;
        if (content && content.trim()) {
            const commentRes = await pool.query(
                'INSERT INTO comments (post_id, user_id, content) VALUES ($1, $2, $3) RETURNING *',
                [req.params.id, req.session.user.id, content.trim()]
            );
            
            const comment = commentRes.rows[0];

            return res.json({
                success: true,
                message: 'تم إضافة تعليقك بنجاح!',
                comment: {
                    id: comment.id,
                    post_id: comment.post_id,
                    content: comment.content,
                    created_at: comment.created_at,
                    display_name: req.session.user.display_name,
                    likes_count: 0,
                    is_liked: false
                }
            });
        }
        res.status(400).json({ success: false, error: 'التعليق لا يمكن أن يكون فارغاً.' });
    } catch (err) {
        console.error('Comment Error:', err);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء إضافة التعليق.' });
    }
});

// الإعجابات
app.post('/like', isAuthenticated, async (req, res) => {
    try {
        const { target_type, target_id } = req.body;
        const userId = req.session.user.id;

        if (!['post', 'comment'].includes(target_type) || !target_id) {
            return res.status(400).json({ success: false, error: 'بيانات غير صالحة.' });
        }

        const existingLike = await pool.query(
            'SELECT id FROM likes WHERE user_id = $1 AND target_type = $2 AND target_id = $3',
            [userId, target_type, target_id]
        );

        let liked = false;
        if (existingLike.rows.length > 0) {
            await pool.query('DELETE FROM likes WHERE id = $1', [existingLike.rows[0].id]);
            liked = false;
        } else {
            await pool.query('INSERT INTO likes (user_id, target_type, target_id) VALUES ($1, $2, $3)', [userId, target_type, target_id]);
            liked = true;
        }

        const countRes = await pool.query('SELECT COUNT(*) FROM likes WHERE target_type = $1 AND target_id = $2', [target_type, target_id]);
        const likesCount = parseInt(countRes.rows[0].count);

        return res.json({ 
            success: true, 
            liked, 
            likesCount, 
            message: liked ? 'تم إبداء الإعجاب ❤️' : 'تم إزالة الإعجاب' 
        });
    } catch (err) {
        console.error('Like Error:', err);
        return res.status(500).json({ success: false, error: 'حدث خطأ في الإعجاب.' });
    }
});

app.post('/report', isAuthenticated, async (req, res) => {
    try {
        const { target_type, target_id, reason } = req.body;
        if (!reason || !reason.trim()) return res.status(400).json({ error: 'يرجى توضيح السبب.' });

        await pool.query('INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES ($1, $2, $3, $4)', [req.session.user.id, target_type, target_id, reason.trim()]);

        if (target_type === 'post') {
            await pool.query("UPDATE posts SET media_status = 'flagged' WHERE id = $1", [target_id]);
        } else if (target_type === 'comment') {
            await pool.query("UPDATE comments SET is_hidden = 1 WHERE id = $1", [target_id]);
        }

        res.json({ success: true, message: 'تم إرسال البلاغ بنجاح.' });
    } catch (err) {
        res.status(500).json({ error: 'خطأ في معالجة البلاغ.' });
    }
});

// --- Admin Routes ---

app.get('/admin', isAdmin, async (req, res) => {
    try {
        const pendingPosts = (await pool.query(`SELECT posts.*, users.display_name, users.national_id FROM posts JOIN users ON posts.user_id = users.id WHERE posts.media_status = 'pending'`)).rows;
        const reports = (await pool.query(`SELECT reports.*, reporter.display_name as reporter_name, posts.content as post_content, comments.content as comment_content FROM reports JOIN users reporter ON reports.reporter_id = reporter.id LEFT JOIN posts ON reports.target_type = 'post' AND reports.target_id = posts.id LEFT JOIN comments ON reports.target_type = 'comment' AND reports.target_id = comments.id ORDER BY reports.created_at DESC`)).rows;
        const allPosts = (await pool.query(`SELECT posts.*, users.display_name, users.national_id FROM posts JOIN users ON posts.user_id = users.id ORDER BY posts.is_pinned DESC, posts.created_at DESC`)).rows;
        const studentsCount = (await pool.query('SELECT COUNT(*) as count FROM allowed_students')).rows[0].count;

        res.render('admin', { user: req.session.user, pendingPosts, reports, allPosts, studentsCount });
    } catch (err) {
        res.status(500).send('حدث خطأ في لوحة التحكم.');
    }
});

app.get('/admin/students', isAdmin, async (req, res) => {
    try {
        const searchQuery = req.query.search ? `%${req.query.search.trim()}%` : null;
        let sql = `SELECT allowed_students.national_id, allowed_students.full_name, users.password, users.is_banned, users.ban_reason FROM allowed_students LEFT JOIN users ON allowed_students.national_id = users.national_id`;
        let params = [];
        if (searchQuery) {
            sql += ` WHERE allowed_students.national_id LIKE $1 OR allowed_students.full_name LIKE $1`;
            params.push(searchQuery);
        }
        const students = (await pool.query(sql, params)).rows;
        const bannedUsers = (await pool.query('SELECT * FROM users WHERE is_banned = 1')).rows;

        res.render('admin-students', { user: req.session.user, students, bannedUsers, search: req.query.search || '' });
    } catch (err) {
        res.status(500).send('حدث خطأ أثناء تحميل إدارة الحسابات.');
    }
});

app.post('/admin/reset-password/:national_id', isAdmin, async (req, res) => {
    await pool.query('UPDATE users SET password = NULL WHERE national_id = $1', [req.params.national_id]);
    res.redirect('/admin/students');
});

app.post('/admin/toggle-ban/:national_id', isAdmin, async (req, res) => {
    const userRes = await pool.query('SELECT is_banned FROM users WHERE national_id = $1', [req.params.national_id]);
    if (userRes.rows[0]) {
        const newStatus = userRes.rows[0].is_banned ? 0 : 1;
        await pool.query('UPDATE users SET is_banned = $1, ban_reason = $2 WHERE national_id = $3', [newStatus, newStatus === 1 ? (req.body.ban_reason || 'حظر يدوي') : null, req.params.national_id]);
    }
    res.redirect('/admin/students');
});

app.post('/admin/add-student', isAdmin, async (req, res) => {
    if (req.body.national_id && req.body.full_name) {
        await pool.query('INSERT INTO allowed_students (national_id, full_name) VALUES ($1, $2) ON CONFLICT (national_id) DO NOTHING', [req.body.national_id.trim(), req.body.full_name.trim()]);
    }
    res.redirect('/admin');
});

app.post('/admin/import-excel', isAdmin, upload.single('excelFile'), async (req, res) => {
    if (!req.file) return res.status(400).send('يرجى اختيار ملف الإكسيل.');
    try {
        const workbook = XLSX.readFile(req.file.path);
        const sheetData = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        for (let row of sheetData) {
            const nationalId = row['national_id'] || row['الرقم القومي'] || row['الرقم_القومي'];
            const fullName = row['full_name'] || row['الاسم'] || row['اسم الطالب'];
            if (nationalId && fullName) {
                await pool.query('INSERT INTO allowed_students (national_id, full_name) VALUES ($1, $2) ON CONFLICT (national_id) DO NOTHING', [String(nationalId).trim(), String(fullName).trim()]);
            }
        }
        fs.unlinkSync(req.file.path);
        res.redirect('/admin');
    } catch (err) {
        res.status(500).send('خطأ أثناء معالجة ملف الإكسيل.');
    }
});

app.post('/admin/approve-post/:id', isAdmin, async (req, res) => {
    await pool.query("UPDATE posts SET media_status = 'approved' WHERE id = $1", [req.params.id]);
    res.redirect('/admin');
});

app.post('/admin/delete-post/:id', isAdmin, async (req, res) => {
    const postRes = await pool.query('SELECT file_path FROM posts WHERE id = $1', [req.params.id]);
    if (postRes.rows[0]) deleteFileIfExists(postRes.rows[0].file_path);
    await pool.query("DELETE FROM posts WHERE id = $1", [req.params.id]);
    res.redirect('/admin');
});

app.post('/admin/delete-comment/:id', isAdmin, async (req, res) => {
    await pool.query("DELETE FROM comments WHERE id = $1", [req.params.id]);
    res.redirect('/admin');
});

app.post('/admin/toggle-pin/:id', isAdmin, async (req, res) => {
    const postRes = await pool.query('SELECT is_pinned FROM posts WHERE id = $1', [req.params.id]);
    if (postRes.rows[0]) {
        await pool.query('UPDATE posts SET is_pinned = $1 WHERE id = $2', [postRes.rows[0].is_pinned ? 0 : 1, req.params.id]);
    }
    res.redirect('/admin');
});

app.post('/admin/reports/:id/dismiss', isAdmin, async (req, res) => {
    const reportRes = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (reportRes.rows[0]) {
        const report = reportRes.rows[0];
        if (report.target_type === 'post') await pool.query("UPDATE posts SET media_status = 'approved' WHERE id = $1", [report.target_id]);
        if (report.target_type === 'comment') await pool.query("UPDATE comments SET is_hidden = 0 WHERE id = $1", [report.target_id]);
        await pool.query('DELETE FROM reports WHERE id = $1', [req.params.id]);
    }
    res.redirect('/admin');
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

initDB().then(() => {
    app.listen(PORT, () => console.log(`🚀 السيرفر يعمل بكفاءة على المنفذ: ${PORT}`));
}).catch(err => console.error('DB Init Error:', err));
