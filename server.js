const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = __dirname;
const uploadDir = path.join(DATA_DIR, 'uploads');
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

let db;

async function initDB() {
    db = await open({
        filename: path.join(DATA_DIR, 'database.sqlite'),
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS allowed_students (
            national_id TEXT PRIMARY KEY,
            full_name TEXT NOT NULL
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            national_id TEXT UNIQUE,
            display_name TEXT,
            password TEXT,
            role TEXT DEFAULT 'student',
            is_banned INTEGER DEFAULT 0
        );
    `);

    try { await db.exec(`ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0;`); } catch(e){}

    await db.exec(`
        CREATE TABLE IF NOT EXISTS posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            content TEXT,
            file_path TEXT,
            file_type TEXT,
            media_status TEXT DEFAULT 'approved',
            is_pinned INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id INTEGER,
            user_id INTEGER,
            content TEXT NOT NULL,
            is_hidden INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (post_id) REFERENCES posts(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
    `);

    try { await db.exec(`ALTER TABLE comments ADD COLUMN is_hidden INTEGER DEFAULT 0;`); } catch(e){}

    await db.exec(`
        CREATE TABLE IF NOT EXISTS reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reporter_id INTEGER NOT NULL,
            target_type TEXT NOT NULL,
            target_id INTEGER NOT NULL,
            reason TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (reporter_id) REFERENCES users(id)
        );
    `);

    let adminUser = await db.get('SELECT * FROM users WHERE national_id = "admin123"');
    const hashedAdminPass = await bcrypt.hash('admin2026Pass', 10);
    
    if (!adminUser) {
        await db.run('INSERT INTO users (national_id, display_name, password, role) VALUES (?, ?, ?, ?)', ['admin123', 'إدارة المعهد', hashedAdminPass, 'admin']);
    } else {
        await db.run('UPDATE users SET password = ? WHERE national_id = "admin123"', [hashedAdminPass]);
    }

    console.log(`⚡ تم تهيئة قاعدة البيانات بنجاح.`);
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

// --- Routes ---

app.get('/login', (req, res) => {
    res.render('login', { error: null, needPasswordSetup: false, national_id: null });
});

app.post('/login', async (req, res) => {
    try {
        const { national_id, password } = req.body;
        const cleanId = national_id ? national_id.trim() : '';

        const user = await db.get('SELECT * FROM users WHERE national_id = ?', [cleanId]);

        if (user && user.is_banned) {
            return res.render('login', { error: 'تم حظر هذا الحساب من قِبل الإدارة.', needPasswordSetup: false, national_id: null });
        }

        if (cleanId === 'admin123') {
            if (!password) return res.render('login', { error: 'يرجى كتابة كلمة مرور الأدمن.', needPasswordSetup: false, national_id: cleanId });
            
            const isMatch = user && user.password ? await bcrypt.compare(password, user.password) : (password === 'admin2026Pass');
            if (isMatch) {
                req.session.user = user || { id: 1, national_id: 'admin123', display_name: 'إدارة المعهد', role: 'admin' };
                return res.redirect('/admin');
            } else {
                return res.render('login', { error: 'كلمة مرور الأدمن غير صحيحة!', needPasswordSetup: false, national_id: cleanId });
            }
        }

        const allowed = await db.get('SELECT * FROM allowed_students WHERE national_id = ?', [cleanId]);
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

        const allowed = await db.get('SELECT * FROM allowed_students WHERE national_id = ?', [national_id]);
        if (!allowed) return res.redirect('/login');

        const hashedPassword = await bcrypt.hash(password, 10);
        let user = await db.get('SELECT * FROM users WHERE national_id = ?', [national_id]);

        if (user) {
            await db.run('UPDATE users SET password = ? WHERE national_id = ?', [hashedPassword, national_id]);
            user.password = hashedPassword;
        } else {
            const result = await db.run('INSERT INTO users (national_id, display_name, password) VALUES (?, ?, ?)', [national_id, allowed.full_name, hashedPassword]);
            user = { id: result.lastID, national_id, display_name: allowed.full_name, role: 'student', is_banned: 0 };
        }

        req.session.user = user;
        res.redirect('/');
    } catch (err) {
        console.error('Set Password Error:', err);
        res.redirect('/login');
    }
});

// الساحة الرئيسية مع حماية كاملة ضد الأخطاء
app.get('/', isAuthenticated, async (req, res) => {
    try {
        const searchQuery = req.query.search ? `%${req.query.search.trim()}%` : null;
        const currentUserId = req.session.user ? req.session.user.id : 0;

        let postsQuery = `
            SELECT posts.*, users.display_name, users.role 
            FROM posts 
            JOIN users ON posts.user_id = users.id 
            WHERE (posts.media_status = 'approved' OR posts.user_id = ?)
        `;
        let queryParams = [currentUserId];

        if (searchQuery) {
            postsQuery += ` AND (posts.content LIKE ? OR users.display_name LIKE ?)`;
            queryParams.push(searchQuery, searchQuery);
        }

        postsQuery += ` ORDER BY posts.is_pinned DESC, posts.created_at DESC`;

        const posts = await db.all(postsQuery, queryParams) || [];

        for (let post of posts) {
            post.comments = await db.all(`
                SELECT comments.*, users.display_name 
                FROM comments 
                JOIN users ON comments.user_id = users.id 
                WHERE comments.post_id = ? AND (comments.is_hidden IS NULL OR comments.is_hidden = 0)
                ORDER BY comments.created_at ASC
            `, [post.id]) || [];
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
            const now = new Date().toISOString();
            await db.run(
                'INSERT INTO posts (user_id, content, file_path, file_type, media_status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                [req.session.user.id, content, filePath, fileType, mediaStatus, now]
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
            const now = new Date().toISOString();
            await db.run(
                'INSERT INTO comments (post_id, user_id, content, created_at) VALUES (?, ?, ?, ?)',
                [req.params.id, req.session.user.id, content, now]
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

        await db.run(
            'INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES (?, ?, ?, ?)',
            [req.session.user.id, target_type, target_id, reason.trim()]
        );

        if (target_type === 'post') {
            await db.run("UPDATE posts SET media_status = 'flagged' WHERE id = ?", [target_id]);
        } else if (target_type === 'comment') {
            await db.run("UPDATE comments SET is_hidden = 1 WHERE id = ?", [target_id]);
        }

        res.json({ success: true, message: 'تم إرسال البلاغ وإخفاء المحتوى لحين مراجعة الإدارة.' });
    } catch (err) {
        console.error('Report Error:', err);
        res.status(500).json({ error: 'حدث خطأ أثناء معالجة البلاغ.' });
    }
});

app.get('/admin', isAdmin, async (req, res) => {
    try {
        const pendingPosts = await db.all(`
            SELECT posts.*, users.display_name, users.national_id 
            FROM posts 
            JOIN users ON posts.user_id = users.id 
            WHERE posts.media_status = 'pending'
        `) || [];

        const reports = await db.all(`
            SELECT reports.*, 
                   reporter.display_name as reporter_name, reporter.national_id as reporter_nid,
                   posts.content as post_content, comments.content as comment_content
            FROM reports
            JOIN users reporter ON reports.reporter_id = reporter.id
            LEFT JOIN posts ON reports.target_type = 'post' AND reports.target_id = posts.id
            LEFT JOIN comments ON reports.target_type = 'comment' AND reports.target_id = comments.id
            ORDER BY reports.created_at DESC
        `) || [];

        const allPosts = await db.all(`
            SELECT posts.*, users.display_name, users.national_id 
            FROM posts 
            JOIN users ON posts.user_id = users.id 
            ORDER BY posts.is_pinned DESC, posts.created_at DESC
        `) || [];

        const studentsCount = await db.get('SELECT COUNT(*) as count FROM allowed_students');

        res.render('admin', { user: req.session.user, pendingPosts, reports, allPosts, studentsCount: studentsCount ? studentsCount.count : 0 });
    } catch (err) {
        console.error('Admin Route Error:', err);
        res.status(500).send('حدث خطأ في لوحة التحكم.');
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
