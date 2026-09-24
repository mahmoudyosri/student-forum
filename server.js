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

// 1. تحديد مسار التخزين (دائم على Render أو محلي على جهازك)
// الكود الجديد الصحيح:
const DATA_DIR = __dirname;
// 2. إنشاء مجلد المرفقات داخل مسار التخزين
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

// ربط مجلد المرفقات والملفات الاستاتيكية
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

// 3. تهيئة قاعدة البيانات SQLite (في المسار الدائم)
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
            role TEXT DEFAULT 'student'
        );
    `);

    try { await db.exec(`ALTER TABLE users ADD COLUMN password TEXT;`); } catch(e){}

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

    try { await db.exec(`ALTER TABLE posts ADD COLUMN is_pinned INTEGER DEFAULT 0;`); } catch(e){}

    await db.exec(`
        CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id INTEGER,
            user_id INTEGER,
            content TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (post_id) REFERENCES posts(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
    `);

    // حساب الأدمن التلقائي
    let adminUser = await db.get('SELECT * FROM users WHERE national_id = "admin123"');
    if (!adminUser) {
        await db.run('INSERT INTO users (national_id, display_name, role) VALUES (?, ?, ?)', ['admin123', 'إدارة المعهد', 'admin']);
    }

    console.log(`⚡ تم تهيئة قاعدة البيانات بنجاح في المسار: ${path.join(DATA_DIR, 'database.sqlite')}`);
}

// Middlewares للتحقق من الصلاحيات
function isAuthenticated(req, res, next) {
    if (req.session.user) return next();
    res.redirect('/login');
}

function isAdmin(req, res, next) {
    if (req.session.user && req.session.user.role === 'admin') return next();
    res.status(403).send('غير مصرح لك بالوصول لهذه الصفحة.');
}

// --- المسارات (Routes) ---

// 1. تسجيل الدخول
app.get('/login', (req, res) => {
    res.render('login', { error: null, needPasswordSetup: false, national_id: null });
});

app.post('/login', async (req, res) => {
    const { national_id, password } = req.body;
    const cleanId = national_id ? national_id.trim() : '';

    if (cleanId === 'admin123') {
        let adminUser = await db.get('SELECT * FROM users WHERE national_id = "admin123"');
        req.session.user = adminUser;
        return res.redirect('/admin');
    }

    const allowed = await db.get('SELECT * FROM allowed_students WHERE national_id = ?', [cleanId]);
    if (!allowed) {
        return res.render('login', { error: 'الرقم القومي غير مسجل في القائمة المعتمدة للطلاب.', needPasswordSetup: false, national_id: null });
    }

    let user = await db.get('SELECT * FROM users WHERE national_id = ?', [cleanId]);

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
});

// 2. تعيين كلمة المرور أول مرة (من قِبل الطالب)
app.post('/set-password', async (req, res) => {
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
    } else {
        const result = await db.run('INSERT INTO users (national_id, display_name, password) VALUES (?, ?, ?)', [national_id, allowed.full_name, hashedPassword]);
        user = { id: result.lastID, national_id, display_name: allowed.full_name, role: 'student' };
    }

    req.session.user = user;
    res.redirect('/');
});

// 3. الساحة الرئيسية
app.get('/', isAuthenticated, async (req, res) => {
    const searchQuery = req.query.search ? `%${req.query.search.trim()}%` : null;

    let postsQuery = `
        SELECT posts.*, users.display_name, users.role 
        FROM posts 
        JOIN users ON posts.user_id = users.id 
        WHERE (posts.media_status = 'approved' OR posts.user_id = ?)
    `;
    let queryParams = [req.session.user.id];

    if (searchQuery) {
        postsQuery += ` AND (posts.content LIKE ? OR users.display_name LIKE ?)`;
        queryParams.push(searchQuery, searchQuery);
    }

    postsQuery += ` ORDER BY posts.is_pinned DESC, posts.created_at DESC`;

    const posts = await db.all(postsQuery, queryParams);

    for (let post of posts) {
        post.comments = await db.all(`
            SELECT comments.*, users.display_name 
            FROM comments 
            JOIN users ON comments.user_id = users.id 
            WHERE comments.post_id = ? 
            ORDER BY comments.created_at ASC
        `, [post.id]);
    }

    res.render('index', { user: req.session.user, posts, search: req.query.search || '' });
});

// 4. إضافة منشور
app.post('/posts', isAuthenticated, upload.single('attachment'), async (req, res) => {
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
});

// 5. إضافة تعليق
app.post('/posts/:id/comments', isAuthenticated, async (req, res) => {
    const { content } = req.body;
    if (content.trim()) {
        const now = new Date().toISOString();
        await db.run(
            'INSERT INTO comments (post_id, user_id, content, created_at) VALUES (?, ?, ?, ?)',
            [req.params.id, req.session.user.id, content, now]
        );
    }
    res.redirect('/');
});

// --- مسارات لوحة التحكم للأدمن ---

// 6. الصفحة الرئيسية للوحة التحكم
app.get('/admin', isAdmin, async (req, res) => {
    const pendingPosts = await db.all(`
        SELECT posts.*, users.display_name, users.national_id 
        FROM posts 
        JOIN users ON posts.user_id = users.id 
        WHERE posts.media_status = 'pending'
    `);

    const allPosts = await db.all(`
        SELECT posts.*, users.display_name, users.national_id 
        FROM posts 
        JOIN users ON posts.user_id = users.id 
        ORDER BY posts.is_pinned DESC, posts.created_at DESC
    `);

    for (let post of allPosts) {
        post.comments = await db.all(`
            SELECT comments.*, users.display_name, users.national_id 
            FROM comments 
            JOIN users ON comments.user_id = users.id 
            WHERE comments.post_id = ? 
            ORDER BY comments.created_at ASC
        `, [post.id]);
    }

    const studentsCount = await db.get('SELECT COUNT(*) as count FROM allowed_students');

    res.render('admin', { user: req.session.user, pendingPosts, allPosts, studentsCount: studentsCount.count });
});

// 7. صفحة إدارة حسابات الطلاب مع البحث (بالاسم أو الرقم القومي)
app.get('/admin/students', isAdmin, async (req, res) => {
    const searchQuery = req.query.search ? `%${req.query.search.trim()}%` : null;

    let sql = `
        SELECT 
            allowed_students.national_id, 
            allowed_students.full_name,
            users.password
        FROM allowed_students
        LEFT JOIN users ON allowed_students.national_id = users.national_id
    `;
    let params = [];

    if (searchQuery) {
        sql += ` WHERE allowed_students.national_id LIKE ? OR allowed_students.full_name LIKE ?`;
        params.push(searchQuery, searchQuery);
    }

    const students = await db.all(sql, params);

    res.render('admin-students', { 
        user: req.session.user, 
        students, 
        search: req.query.search || '' 
    });
});

// 8. تعيين أو تصفير كلمة مرور طالب
app.post('/admin/reset-password/:national_id', isAdmin, async (req, res) => {
    const { new_password } = req.body;
    const nationalId = req.params.national_id;

    if (new_password && new_password.trim().length >= 6) {
        const hashedPassword = await bcrypt.hash(new_password.trim(), 10);
        const existing = await db.get('SELECT * FROM users WHERE national_id = ?', [nationalId]);
        
        if (existing) {
            await db.run('UPDATE users SET password = ? WHERE national_id = ?', [hashedPassword, nationalId]);
        } else {
            const allowed = await db.get('SELECT full_name FROM allowed_students WHERE national_id = ?', [nationalId]);
            await db.run('INSERT INTO users (national_id, display_name, password) VALUES (?, ?, ?)', [nationalId, allowed.full_name, hashedPassword]);
        }
    } else {
        // تصفير كلمة المرور ليُنشئها الطالب مجدداً
        await db.run('UPDATE users SET password = NULL WHERE national_id = ?', [nationalId]);
    }

    res.redirect('/admin/students');
});

// 9. تثبيت / إلغاء تثبيت منشور
app.post('/admin/toggle-pin/:id', isAdmin, async (req, res) => {
    const post = await db.get('SELECT is_pinned FROM posts WHERE id = ?', [req.params.id]);
    if (post) {
        const newStatus = post.is_pinned ? 0 : 1;
        await db.run('UPDATE posts SET is_pinned = ? WHERE id = ?', [newStatus, req.params.id]);
    }
    res.redirect('/admin');
});

// 10. قبول/حذف منشورات وتصريحات
app.post('/admin/approve/:id', isAdmin, async (req, res) => {
    await db.run("UPDATE posts SET media_status = 'approved' WHERE id = ?", [req.params.id]);
    res.redirect('/admin');
});

app.post('/admin/delete-post/:id', isAdmin, async (req, res) => {
    await db.run("DELETE FROM posts WHERE id = ?", [req.params.id]);
    await db.run("DELETE FROM comments WHERE post_id = ?", [req.params.id]);
    res.redirect('/admin');
});

app.post('/admin/delete-comment/:id', isAdmin, async (req, res) => {
    await db.run("DELETE FROM comments WHERE id = ?", [req.params.id]);
    res.redirect('/admin');
});

// 11. إضافة طالب يدوياً أو استيراد ملف إكسيل
app.post('/admin/add-student', isAdmin, async (req, res) => {
    const { national_id, full_name } = req.body;
    if (national_id && full_name) {
        await db.run('INSERT OR IGNORE INTO allowed_students (national_id, full_name) VALUES (?, ?)', [national_id.trim(), full_name.trim()]);
    }
    res.redirect('/admin');
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
                await db.run('INSERT OR IGNORE INTO allowed_students (national_id, full_name) VALUES (?, ?)', [String(nationalId).trim(), String(fullName).trim()]);
            }
        }

        fs.unlinkSync(req.file.path);
        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.status(500).send('خطأ أثناء معالجة ملف الإكسيل.');
    }
});

// 12. تسجيل الخروج
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// تشغيل السيرفر
initDB().then(() => {
    app.listen(PORT, () => console.log(`🚀 السيرفر يعمل بكفاءة على المنفذ: ${PORT}`));
});