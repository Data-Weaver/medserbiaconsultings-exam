const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Run seed on startup if questions table is empty
const qCount = db.prepare('SELECT COUNT(*) as c FROM questions').get().c;
if (qCount === 0) {
  console.log('No questions found, running seed...');
  require('child_process').execSync('node seed.js', { cwd: __dirname, stdio: 'inherit' });
  console.log('Seed complete on startup');
}

// Trust proxy (required for Render)
app.set('trust proxy', 1);

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
// Serve static files — check both 'public' subfolder and root (for Render deploy)
const fs = require('fs');
const publicDir = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public')
  : __dirname;
app.use(express.static(publicDir));

// Serve English version
app.get('/en', (req, res) => {
  res.sendFile(path.join(publicDir, 'index-en.html'));
});

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

// Helper: get client IP
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
}

// ============ PUBLIC API ============

// Verify access code (one-time codes for exam)
app.post('/api/verify-code', (req, res) => {
  const { code } = req.body;
  // Check one-time exam codes
  const examCode = db.prepare('SELECT * FROM exam_codes WHERE code = ? AND used = 0').get(code);
  if (examCode) {
    return res.json({ valid: true, codeId: examCode.id });
  }
  // Fallback: check global access code (for study mode)
  const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get('access_code');
  if (setting && setting.value === code) {
    return res.json({ valid: true, codeId: null });
  }
  res.json({ valid: false });
});

// Check if user already registered (by email)
app.get('/api/check-ip', (req, res) => {
  res.json({ registered: false });
});

// Start exam session (new test or first test)
app.post('/api/start-exam', (req, res) => {
  const { fullName, email, phone, codeId } = req.body;
  const ip = getClientIP(req);
  const timeLimit = 90;

  // Mark one-time code as used
  if (codeId) {
    const code = db.prepare('SELECT * FROM exam_codes WHERE id = ? AND used = 0').get(codeId);
    if (!code) {
      return res.status(403).json({ error: 'Ο κωδικός έχει ήδη χρησιμοποιηθεί.' });
    }
    db.prepare('UPDATE exam_codes SET used = 1, used_by = ?, used_at = CURRENT_TIMESTAMP WHERE id = ?').run(fullName, codeId);
  }

  // Get random questions (no IP-based exclusion)
  const biologyQs = db.prepare(`SELECT id FROM questions WHERE category = 'biology' ORDER BY RANDOM() LIMIT 40`).all();
  const chemistryQs = db.prepare(`SELECT id FROM questions WHERE category = 'chemistry' ORDER BY RANDOM() LIMIT 40`).all();

  if (biologyQs.length < 40 || chemistryQs.length < 40) {
    return res.status(400).json({ error: 'Δεν υπάρχουν αρκετές νέες ερωτήσεις. Έχετε ολοκληρώσει όλα τα διαθέσιμα τεστ!' });
  }

  // Create session
  const session = db.prepare(
    'INSERT INTO exam_sessions (full_name, email, phone, ip_address, time_limit_minutes) VALUES (?, ?, ?, ?, ?)'
  ).run(fullName, email, phone, ip, timeLimit);

  const sessionId = session.lastInsertRowid;
  const questionIds = [...biologyQs, ...chemistryQs].map(q => q.id);

  // Shuffle questions
  for (let i = questionIds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [questionIds[i], questionIds[j]] = [questionIds[j], questionIds[i]];
  }

  // Pre-create answer rows
  const insertAnswer = db.prepare('INSERT INTO exam_answers (session_id, question_id) VALUES (?, ?)');
  const insertMany = db.transaction((ids) => {
    for (const qId of ids) insertAnswer.run(sessionId, qId);
  });
  insertMany(questionIds);

  // Fetch full questions
  const placeholders = questionIds.map(() => '?').join(',');
  const questions = db.prepare(`SELECT id, category, question_text, option_a, option_b, option_c, option_d, correct_answer FROM questions WHERE id IN (${placeholders})`).all(...questionIds);

  // Sort by our shuffled order
  const orderMap = {};
  questionIds.forEach((id, idx) => orderMap[id] = idx);
  questions.sort((a, b) => orderMap[a.id] - orderMap[b.id]);

  res.json({ sessionId, questions, timeLimitMinutes: timeLimit });
});

// Submit exam
app.post('/api/submit-exam', (req, res) => {
  const { sessionId, answers } = req.body;

  const session = db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  if (session.status === 'completed') return res.status(400).json({ error: 'Exam already submitted.' });

  let totalCorrect = 0;
  let biologyCorrect = 0;
  let chemistryCorrect = 0;

  const updateAnswer = db.prepare('UPDATE exam_answers SET selected_answer = ?, is_correct = ? WHERE session_id = ? AND question_id = ?');

  const processAnswers = db.transaction(() => {
    for (const [questionId, selectedAnswer] of Object.entries(answers)) {
      const question = db.prepare('SELECT correct_answer, category FROM questions WHERE id = ?').get(parseInt(questionId));
      if (!question) continue;

      const isCorrect = question.correct_answer === selectedAnswer ? 1 : 0;
      updateAnswer.run(selectedAnswer || null, isCorrect, sessionId, parseInt(questionId));

      if (isCorrect) {
        totalCorrect++;
        if (question.category === 'biology') biologyCorrect++;
        else chemistryCorrect++;
      }
    }

    db.prepare(
      'UPDATE exam_sessions SET score = ?, biology_score = ?, chemistry_score = ?, completed_at = CURRENT_TIMESTAMP, status = ? WHERE id = ?'
    ).run(totalCorrect, biologyCorrect, chemistryCorrect, 'completed', sessionId);
  });

  processAnswers();

  // Get detailed results
  const examAnswers = db.prepare(`
    SELECT q.id, q.category, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_answer, ea.selected_answer, ea.is_correct
    FROM exam_answers ea
    JOIN questions q ON ea.question_id = q.id
    WHERE ea.session_id = ?
  `).all(sessionId);

  res.json({
    score: totalCorrect,
    total: 80,
    biologyScore: biologyCorrect,
    chemistryScore: chemistryCorrect,
    percentage: Math.round((totalCorrect / 80) * 100),
    details: examAnswers
  });
});

// ============ ADMIN API ============

// Verify study access code (general code only, not one-time)
app.post('/api/verify-study-code', (req, res) => {
  const { code } = req.body;
  const ip = getClientIP(req);

  // Block if there's an active exam from this IP
  const activeExam = db.prepare('SELECT id FROM exam_sessions WHERE ip_address = ? AND status = ?').get(ip, 'in_progress');
  if (activeExam) {
    return res.json({ valid: false, blocked: true, reason: 'Έχετε ενεργό τεστ. Η μελέτη δεν είναι διαθέσιμη κατά τη διάρκεια του τεστ.' });
  }

  const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get('access_code');
  if (setting && setting.value === code) {
    return res.json({ valid: true });
  }
  res.json({ valid: false });
});

// Check if study is accessible (no active exam)
app.get('/api/check-study-access', (req, res) => {
  const ip = getClientIP(req);
  const activeExam = db.prepare('SELECT id FROM exam_sessions WHERE ip_address = ? AND status = ?').get(ip, 'in_progress');
  if (activeExam) {
    return res.json({ blocked: true, reason: 'Έχετε ενεργό τεστ. Η μελέτη δεν είναι διαθέσιμη κατά τη διάρκεια του τεστ.' });
  }
  res.json({ blocked: false });
});

// Study mode - get all questions
app.get('/api/study-questions', (req, res) => {
  const ip = getClientIP(req);
  const activeExam = db.prepare('SELECT id FROM exam_sessions WHERE ip_address = ? AND status = ?').get(ip, 'in_progress');
  if (activeExam) {
    return res.status(403).json({ error: 'Η μελέτη δεν είναι διαθέσιμη κατά τη διάρκεια του τεστ.' });
  }
  const questions = db.prepare('SELECT * FROM questions ORDER BY category, id').all();
  const biologyCount = questions.filter(q => q.category === 'biology').length;
  const chemistryCount = questions.filter(q => q.category === 'chemistry').length;
  res.json({ questions, biologyCount, chemistryCount });
});

// Study mode - save answer
app.post('/api/study-answer', (req, res) => {
  const { fullName, email, questionId, selectedAnswer, isCorrect, category } = req.body;
  db.prepare('INSERT INTO study_answers (full_name, email, question_id, selected_answer, is_correct, category) VALUES (?, ?, ?, ?, ?, ?)')
    .run(fullName, email || '', questionId, selectedAnswer, isCorrect ? 1 : 0, category);
  res.json({ ok: true });
});

// Study mode - get stats for admin
app.get('/api/admin/study-stats', adminAuth, (req, res) => {
  const users = db.prepare(`
    SELECT full_name, email, category,
      COUNT(*) as total,
      SUM(is_correct) as correct
    FROM study_answers
    GROUP BY full_name, email, category
    ORDER BY full_name, category
  `).all();
  const totalBio = db.prepare("SELECT COUNT(*) as c FROM questions WHERE category = 'biology'").get().c;
  const totalChem = db.prepare("SELECT COUNT(*) as c FROM questions WHERE category = 'chemistry'").get().c;
  res.json({ users, totalBio, totalChem });
});

// Admin - get exam codes
app.get('/api/admin/codes', adminAuth, (req, res) => {
  const codes = db.prepare('SELECT * FROM exam_codes ORDER BY used, id').all();
  const available = codes.filter(c => !c.used).length;
  const used = codes.filter(c => c.used).length;
  res.json({ codes, available, used, total: codes.length });
});

// Admin - generate more codes
app.post('/api/admin/codes/generate', adminAuth, (req, res) => {
  const { count } = req.body;
  const num = Math.min(parseInt(count) || 50, 500);
  const insertCode = db.prepare('INSERT INTO exam_codes (code) VALUES (?)');
  const crypto = require('crypto');
  const gen = db.transaction(() => {
    for (let i = 0; i < num; i++) {
      const code = 'MED-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      insertCode.run(code);
    }
  });
  gen();
  res.json({ generated: num });
});

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  const admin = db.prepare('SELECT * FROM admin_users WHERE username = ? AND password = ?').get(username, password);
  if (admin) {
    res.json({ success: true, token: Buffer.from(`${username}:${password}`).toString('base64') });
  } else {
    res.status(401).json({ error: 'Invalid credentials.' });
  }
});

// Admin middleware
function adminAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = Buffer.from(auth.split(' ')[1], 'base64').toString();
    const [username, password] = decoded.split(':');
    const admin = db.prepare('SELECT * FROM admin_users WHERE username = ? AND password = ?').get(username, password);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// Get all sessions (admin)
app.get('/api/admin/sessions', adminAuth, (req, res) => {
  const sessions = db.prepare('SELECT * FROM exam_sessions ORDER BY started_at DESC').all();
  // Add unanswered count and test number per user
  const enriched = sessions.map(s => {
    const unanswered = db.prepare('SELECT COUNT(*) as c FROM exam_answers WHERE session_id = ? AND selected_answer IS NULL').get(s.id).c;
    const testNum = db.prepare('SELECT COUNT(*) as c FROM exam_sessions WHERE ip_address = ? AND id <= ?').get(s.ip_address, s.id).c;
    return { ...s, unanswered, testNumber: testNum };
  });
  res.json(enriched);
});

// Get session details (admin)
app.get('/api/admin/sessions/:id', adminAuth, (req, res) => {
  const session = db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });
  const answers = db.prepare(`
    SELECT q.category, q.question_text, q.correct_answer, ea.selected_answer, ea.is_correct
    FROM exam_answers ea JOIN questions q ON ea.question_id = q.id
    WHERE ea.session_id = ?
  `).all(req.params.id);
  res.json({ session, answers });
});

// Export CSV (admin)
// Export Excel (admin)
app.get('/api/admin/export-csv', adminAuth, async (req, res) => {
  const ExcelJS = require('exceljs');
  const sessions = db.prepare('SELECT * FROM exam_sessions WHERE status = ? ORDER BY ip_address, id').all('completed');

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Αποτελέσματα');

  // Header row
  sheet.columns = [
    { header: 'Ονοματεπώνυμο', key: 'name', width: 25 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Τηλέφωνο', key: 'phone', width: 15 },
    { header: 'Τεστ #', key: 'testNum', width: 8 },
    { header: 'Βαθμός', key: 'score', width: 10 },
    { header: 'Βιολογία', key: 'bio', width: 10 },
    { header: 'Χημεία', key: 'chem', width: 10 },
    { header: 'Αναπάντητες', key: 'unanswered', width: 12 },
    { header: 'Ποσοστό', key: 'pct', width: 10 },
    { header: 'Ημερομηνία', key: 'date', width: 18 },
  ];

  // Style header
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  sheet.getRow(1).alignment = { horizontal: 'center' };

  const ipCount = {};
  for (const s of sessions) {
    ipCount[s.ip_address] = (ipCount[s.ip_address] || 0) + 1;
    const unanswered = db.prepare('SELECT COUNT(*) as c FROM exam_answers WHERE session_id = ? AND selected_answer IS NULL').get(s.id).c;
    const pct = Math.round((s.score / 80) * 100);

    const row = sheet.addRow({
      name: s.full_name,
      email: s.email,
      phone: s.phone,
      testNum: ipCount[s.ip_address],
      score: s.score + '/80',
      bio: s.biology_score + '/40',
      chem: s.chemistry_score + '/40',
      unanswered: unanswered,
      pct: pct + '%',
      date: s.completed_at ? new Date(s.completed_at).toLocaleDateString('el-GR') : ''
    });

    // Color the percentage
    const pctCell = row.getCell('pct');
    if (pct >= 70) pctCell.font = { bold: true, color: { argb: 'FF4CAF50' } };
    else if (pct >= 50) pctCell.font = { bold: true, color: { argb: 'FFFF9800' } };
    else pctCell.font = { bold: true, color: { argb: 'FFEF5350' } };

    if (unanswered > 0) row.getCell('unanswered').font = { bold: true, color: { argb: 'FFEF5350' } };
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=exam-results.xlsx');
  await workbook.xlsx.write(res);
  res.end();
});

// Update settings (admin)
app.put('/api/admin/settings', adminAuth, (req, res) => {
  const { accessCode, defaultTimeLimit } = req.body;
  if (accessCode) db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(accessCode, 'access_code');
  if (defaultTimeLimit) db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(defaultTimeLimit), 'default_time_limit');
  res.json({ success: true });
});

// Get settings (admin)
app.get('/api/admin/settings', adminAuth, (req, res) => {
  const settings = db.prepare('SELECT * FROM settings').all();
  const obj = {};
  settings.forEach(s => obj[s.key] = s.value);
  res.json(obj);
});

// Get stats (admin)
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as count FROM exam_sessions WHERE status = ?').get('completed');
  const avg = db.prepare('SELECT AVG(score) as avg_score FROM exam_sessions WHERE status = ?').get('completed');
  const avgBio = db.prepare('SELECT AVG(biology_score) as avg FROM exam_sessions WHERE status = ?').get('completed');
  const avgChem = db.prepare('SELECT AVG(chemistry_score) as avg FROM exam_sessions WHERE status = ?').get('completed');
  res.json({
    totalExams: total.count,
    averageScore: Math.round(((avg.avg_score || 0) / 80) * 100),
    averageBiology: Math.round(avgBio.avg || 0),
    averageChemistry: Math.round(avgChem.avg || 0)
  });
});

// Delete session (admin)
app.delete('/api/admin/sessions/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM exam_answers WHERE session_id = ?').run(req.params.id);
  db.prepare('DELETE FROM exam_sessions WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Exam platform running on http://localhost:${PORT}`);
});
