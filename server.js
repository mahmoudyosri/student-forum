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

// الاتصال بقاعدة بيانات PostgreSQL المجانية
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

    // تهيئة حساب الأدمن
    const ADMIN_NID = "29000000000000";
    const adminCheck = await pool.query('SELECT * FROM users WHERE role = $1 OR national_id = $2', ['admin', ADMIN_NID]);
    const hashedAdminPass = await bcrypt.hash('admin2026Pass', 10);

    if (adminCheck.rows.length === 0) {
        await pool.query('INSERT INTO users (national_id, display_name, password, role) VALUES ($1, $2, $3, $4)', [ADMIN_NID, 'إدارة المعهد', hashedAdminPass, 'admin']);
    } else {
        await pool.query('UPDATE users SET national_id = $1, password = $2 WHERE role = $3', [ADMIN_NID, hashedAdminPass, 'admin']);
    }

    console.log(`⚡ تم تهيئة قاعدة بيانات PostgreSQL بنجاح.`);
}

function isAuthenticated(req, res, next) {
    if (req.session && req.session.user) {
        if (req.session.user.is_banned) {
            req.session.destroy();
            return res.status(403).send('تم حظر حسابك من استخدام المنصة.');
        }
        return next();
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
        }

        res.render('index', { user: req.session.user, posts, search: req.query.search || '' });
    } catch (err) {
        console.error('Home Route Error:', err);
        res.status(500).send('حدث خطأ أثناء تحميل الساحة الرئيسية.');
    }
});

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
            await pool.query(
                'INSERT INTO posts (user_id, content, file_path, file_type, media_status) VALUES ($1, $2, $3, $4, $5)',
                [req.session.user.id, content, filePath, fileType, mediaStatus]
            );
        }

        res.redirect(req.session.user.role === 'admin' ? '/admin' : '/');
    } catch (err) {
        console.error('Create Post Error:', err);
        res.redirect('/');
    }
});

app.post('/posts/:id/comments', isAuthenticated, async (req, res) => {
    try {
        const { content } = req.body;
        if (content && content.trim()) {
            await pool.query(
                'INSERT INTO comments (post_id, user_id, content) VALUES ($1, $2, $3)',
                [req.params.id, req.session.user.id, content]
            );
        }
        res.redirect('/');
    } catch (err) {
        console.error('Comment Error:', err);
        res.redirect('/');
    }
});

app.post('/report', isAuthenticated, async (req, res) => {
    try {
        const { target_type, target_id, reason } = req.body;
        
        if (!reason || !reason.trim()) {
            return res.status(400).json({ error: 'يرجى توضيح سبب الإبلاغ.' });
        }

        await pool.query(
            'INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES ($1, $2, $3, $4)',
            [req.session.user.id, target_type, target_id, reason.trim()]
        );

        if (target_type === 'post') {
            await pool.query("UPDATE posts SET media_status = 'flagged' WHERE id = $1", [target_id]);
        } else if (target_type === 'comment') {
            await pool.query("UPDATE comments SET is_hidden = 1 WHERE id = $1", [target_id]);
        }

        res.json({ success: true, message: 'تم إرسال البلاغ وإخفاء المحتوى لحين مراجعة الإدارة.' });
    } catch (err) {
        console.error('Report Error:', err);
        res.status(500).json({ error: 'حدث خطأ أثناء معالجة البلاغ.' });
    }
});

// --- Admin Routes ---

app.get('/admin', isAdmin, async (req, res) => {
    try {
        const pendingPosts = (await pool.query(`
            SELECT posts.*, users.display_name, users.national_id 
            FROM posts 
            JOIN users ON posts.user_id = users.id 
            WHERE posts.media_status = 'pending'
        `)).rows;

        const reports = (await pool.query(`
            SELECT reports.*, 
                   reporter.id as reporter_user_id, reporter.display_name as reporter_name, reporter.national_id as reporter_nid,
                   posts.content as post_content, comments.content as comment_content
            FROM reports
            JOIN users reporter ON reports.reporter_id = reporter.id
            LEFT JOIN posts ON reports.target_type = 'post' AND reports.target_id = posts.id
            LEFT JOIN comments ON reports.target_type = 'comment' AND reports.target_id = comments.id
            ORDER BY reports.created_at DESC
        `)).rows;

        const allPosts = (await pool.query(`
            SELECT posts.*, users.display_name, users.national_id 
            FROM posts 
            JOIN users ON posts.user_id = users.id 
            ORDER BY posts.is_pinned DESC, posts.created_at DESC
        `)).rows;

        const studentsCountRes = await pool.query('SELECT COUNT(*) as count FROM allowed_students');
        const studentsCount = studentsCountRes.rows[0].count;

        res.render('admin', { user: req.session.user, pendingPosts, reports, allPosts, studentsCount });
    } catch (err) {
        console.error('Admin Route Error:', err);
        res.status(500).send('حدث خطأ في لوحة التحكم.');
    }
});

app.get('/admin/students', isAdmin, async (req, res) => {
    try {
        const searchQuery = req.query.search ? `%${req.query.search.trim()}%` : null;
        let sql = `
            SELECT allowed_students.national_id, allowed_students.full_name, users.password, users.is_banned, users.ban_reason
            FROM allowed_students
            LEFT JOIN users ON allowed_students.national_id = users.national_id
        `;
        let params = [];
        if (searchQuery) {
            sql += ` WHERE allowed_students.national_id LIKE $1 OR allowed_students.full_name LIKE $1`;
            params.push(searchQuery);
        }
        const students = (await pool.query(sql, params)).rows;
        const bannedUsers = (await pool.query('SELECT * FROM users WHERE is_banned = 1')).rows;

        res.render('admin-students', { user: req.session.user, students, bannedUsers, search: req.query.search || '' });
    } catch (err) {
        console.error('Admin Students Route Error:', err);
        res.status(500).send('حدث خطأ أثناء تحميل إدارة الحسابات.');
    }
});

app.post('/admin/reset-password/:national_id', isAdmin, async (req, res) => {
    try {
        const { national_id } = req.params;
        await pool.query('UPDATE users SET password = NULL WHERE national_id = $1', [national_id]);
        res.redirect('/admin/students');
    } catch (err) {
        res.redirect('/admin/students');
    }
});

app.post('/admin/toggle-ban/:national_id', isAdmin, async (req, res) => {
    try {
        const { ban_reason } = req.body;
        const userRes = await pool.query('SELECT is_banned FROM users WHERE national_id = $1', [req.params.national_id]);
        const user = userRes.rows[0];
        if (user) {
            const newStatus = user.is_banned ? 0 : 1;
            const reason = newStatus === 1 ? (ban_reason || 'حظر يدوي من الإدارة') : null;
            await pool.query('UPDATE users SET is_banned = $1, ban_reason = $2 WHERE national_id = $3', [newStatus, reason, req.params.national_id]);
        }
        res.redirect('/admin/students');
    } catch (err) {
        res.redirect('/admin/students');
    }
});

app.post('/admin/add-student', isAdmin, async (req, res) => {
    try {
        const { national_id, full_name } = req.body;
        if (national_id && full_name) {
            await pool.query('INSERT INTO allowed_students (national_id, full_name) VALUES ($1, $2) ON CONFLICT (national_id) DO NOTHING', [national_id.trim(), full_name.trim()]);
        }
        res.redirect('/admin');
    } catch (err) {
        res.redirect('/admin');
    }
});

app.post('/admin/import-excel', isAdmin, upload.single('excelFile'), async (req, res) => {
    if (!req.file) return res.status(400).send('يرجى اختيار ملف الإكسيل.');

    try {
        const workbook = XLSX.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const sheetData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

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
        console.error('Import Excel Error:', err);
        res.status(500).send('خطأ أثناء معالجة ملف الإكسيل.');
    }
});

app.post('/admin/approve-post/:id', isAdmin, async (req, res) => {
    try {
        await pool.query("UPDATE posts SET media_status = 'approved' WHERE id = $1", [req.params.id]);
        res.redirect('/admin');
    } catch (err) {
        res.redirect('/admin');
    }
});

app.post('/admin/delete-post/:id', isAdmin, async (req, res) => {
    try {
        const postRes = await pool.query('SELECT file_path FROM posts WHERE id = $1', [req.params.id]);
        if (postRes.rows[0]) deleteFileIfExists(postRes.rows[0].file_path);
        
        await pool.query("DELETE FROM posts WHERE id = $1", [req.params.id]);
        res.redirect('/admin');
    } catch (err) {
        res.redirect('/admin');
    }
});

app.post('/admin/delete-comment/:id', isAdmin, async (req, res) => {
    try {
        await pool.query("DELETE FROM comments WHERE id = $1", [req.params.id]);
        res.redirect('/admin');
    } catch (err) {
        res.redirect('/admin');
    }
});

app.post('/admin/toggle-pin/:id', isAdmin, async (req, res) => {
    try {
        const postRes = await pool.query('SELECT is_pinned FROM posts WHERE id = $1', [req.params.id]);
        if (postRes.rows[0]) {
            await pool.query('UPDATE posts SET is_pinned = $1 WHERE id = $2', [postRes.rows[0].is_pinned ? 0 : 1, req.params.id]);
        }
        res.redirect('/admin');
    } catch (err) {
        res.redirect('/admin');
    }
});

app.post('/admin/reports/:id/dismiss', isAdmin, async (req, res) => {
    try {
        const reportRes = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
        const report = reportRes.rows[0];
        if (report) {
            if (report.target_type === 'post') {
                await pool.query("UPDATE posts SET media_status = 'approved' WHERE id = $1", [report.target_id]);
            } else if (report.target_type === 'comment') {
                await pool.query("UPDATE comments SET is_hidden = 0 WHERE id = $1", [report.target_id]);
            }
            await pool.query('DELETE FROM reports WHERE id = $1', [req.params.id]);
        }
        res.redirect('/admin');
    } catch (err) {
        res.redirect('/admin');
    }
});

app.post('/admin/reports/:id/ban-user', isAdmin, async (req, res) => {
    try {
        const reportRes = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
        const report = reportRes.rows[0];
        if (report) {
            let userIdToBan = null;
            if (report.target_type === 'post') {
                const postRes = await pool.query('SELECT * FROM posts WHERE id = $1', [report.target_id]);
                const post = postRes.rows[0];
                if (post) {
                    userIdToBan = post.user_id;
                    deleteFileIfExists(post.file_path);
                    await pool.query('DELETE FROM posts WHERE id = $1', [post.id]);
                }
            } else if (report.target_type === 'comment') {
                const commentRes = await pool.query('SELECT * FROM comments WHERE id = $1', [report.target_id]);
                const comment = commentRes.rows[0];
                if (comment) {
                    userIdToBan = comment.user_id;
                    await pool.query('DELETE FROM comments WHERE id = $1', [comment.id]);
                }
            }

            if (userIdToBan) {
                await pool.query('UPDATE users SET is_banned = 1, ban_reason = $1 WHERE id = $2', ['نشر محتوى مخالف بناءً على بلاغ معتمد', userIdToBan]);
            }
            await pool.query('DELETE FROM reports WHERE id = $1', [req.params.id]);
        }
        res.redirect('/admin');
    } catch (err) {
        res.redirect('/admin');
    }
});

app.post('/admin/reports/:id/ban-reporter', isAdmin, async (req, res) => {
    try {
        const reportRes = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
        const report = reportRes.rows[0];
        if (report) {
            await pool.query('UPDATE users SET is_banned = 1, ban_reason = $1 WHERE id = $2', ['تقديم بلاغ كاذب ومضلل', report.reporter_id]);
            
            if (report.target_type === 'post') {
                await pool.query("UPDATE posts SET media_status = 'approved' WHERE id = $1", [report.target_id]);
            } else if (report.target_type === 'comment') {
                await pool.query("UPDATE comments SET is_hidden = 0 WHERE id = $1", [report.target_id]);
            }

            await pool.query('DELETE FROM reports WHERE id = $1', [req.params.id]);
        }
        res.redirect('/admin');
    } catch (err) {
        res.redirect('/admin');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

initDB().then(() => {
    app.listen(PORT, () => console.log(`🚀 السيرفر يعمل بكفاءة على المنفذ: ${PORT}`));
}).catch(err => {
    console.error('Database Initialization Failed:', err);
});
