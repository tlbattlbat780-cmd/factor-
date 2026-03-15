// FITCORE PRO — server.js
// Node.js + Express + MongoDB — Gemini Edition
require('dotenv').config();
const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const path       = require('path');
const multer     = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Gemini Client (reads from env — NO hardcoded key) ───────────────
const genAI  = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || '');
const gemini = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// ── Middleware ──────────────────────────────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── JWT Helper ──────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'fitcore-jwt-secret-2025';
const signToken  = id => jwt.sign({ id }, JWT_SECRET, { expiresIn: '30d' });
const protect    = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    req.user = await User.findById(id).select('-password');
    if (!req.user) return res.status(401).json({ error: 'مستخدم غير موجود' });
    next();
  } catch { res.status(401).json({ error: 'توكن غير صالح' }); }
};
const adminOnly = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'للمديرين فقط' });

// ── Metabolic Engine ────────────────────────────────────────────────
const ACTIVITY = { sedentary:1.2, light:1.375, moderate:1.55, active:1.725, very_active:1.9 };
const MACROS   = { cut:{p:.40,c:.35,f:.25}, bulk:{p:.30,c:.50,f:.20}, recomp:{p:.35,c:.40,f:.25} };
function calcMifflin({ weight=78, height=170, age=24, gender='male', activityLevel='moderate', goal='recomp' }) {
  const bmr  = gender==='male' ? 10*weight + 6.25*height - 5*age + 5 : 10*weight + 6.25*height - 5*age - 161;
  const tdee = bmr * (ACTIVITY[activityLevel]||1.55);
  const tk   = goal==='cut' ? tdee*.80 : goal==='bulk' ? tdee*1.10 : tdee*.97;
  const r    = MACROS[goal]||MACROS.recomp;
  return { bmr:+bmr.toFixed(0), tdee:+tdee.toFixed(0), targetKcal:+tk.toFixed(0), proteinG:+(tk*r.p/4).toFixed(0), carbG:+(tk*r.c/4).toFixed(0), fatG:+(tk*r.f/9).toFixed(0) };
}
function autoReg({ deficit=0, baseSets=4, baseRest=120, deficitDays=0 }) {
  const high = deficit>=600||deficitDays>=3, med = deficit>=300&&!high;
  return {
    restSeconds:      high?baseRest+90:med?baseRest+45:baseRest,
    setsAdjusted:     high?Math.max(2,Math.round(baseSets*.85)):med?Math.max(2,Math.round(baseSets*.92)):baseSets,
    volumeMultiplier: high?.85:med?.92:1.0,
    warningLevel:     high?'high':med?'medium':'none',
    message: high ? `عجز حراري عالٍ — تم تقليل الحجم 15% وإضافة 90ث راحة` : med ? `عجز متوسط — تعديل خفيف` : 'الحالة الأيضية مثالية',
  };
}
function bloodTypeProtocol(bt) {
  if (bt !== 'AB-') return [];
  return ['فصيلة AB- تستجيب للتمارين المختلطة (هوائي + مقاومة)','استشفاء: 48 ساعة بين جلسات نفس العضلة','بروتين مفضل: بيض، أسماك، دجاج','تجنب الإفراط بالكارديو الشديد'];
}

// ── Mongoose Models ─────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  name:     { type:String, required:true },
  email:    { type:String, required:true, unique:true, lowercase:true },
  password: { type:String, required:true, select:false },
  role:     { type:String, enum:['user','admin'], default:'user' },
  plan:     { type:String, default:'free' },
  avatar:   String,
  biometrics: {
    height:Number, weight:Number, age:Number, gender:String,
    bloodType:String, bodyFat:Number, goal:String, activityLevel:String,
  },
  metabolic: { bmr:Number, tdee:Number, targetKcal:Number, proteinG:Number, carbG:Number, fatG:Number },
  favorites: [{ type:mongoose.Schema.Types.ObjectId, ref:'Exercise' }],
}, { timestamps:true });
UserSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12); next();
});
UserSchema.methods.comparePassword = function(p) { return bcrypt.compare(p, this.password); };
const User = mongoose.model('User', UserSchema);

const ExerciseSchema = new mongoose.Schema({
  name:        { type:String, required:true },
  nameAr:      String,
  category:    { type:String, required:true },
  equipment:   String,
  difficulty:  String,
  muscleGroup: String,
  description: String,
  instructions:[String],
  images:      [String],
  videoUrl:    String,
  fileSizeMb:  { type:Number, default:35 },
  idealAngles: mongoose.Schema.Types.Mixed,
  tags:        [String],
  isPublic:    { type:Boolean, default:true },
  views:       { type:Number, default:0 },
}, { timestamps:true });
const Exercise = mongoose.model('Exercise', ExerciseSchema);

const ProgramSchema = new mongoose.Schema({
  title:         { type:String, required:true },
  titleAr:       String,
  description:   String,
  goal:          String,
  level:         String,
  durationWeeks: Number,
  daysPerWeek:   Number,
  createdBy:     { type:mongoose.Schema.Types.ObjectId, ref:'User' },
  isPublic:      { type:Boolean, default:true },
  isFeatured:    { type:Boolean, default:false },
  weeks:         [mongoose.Schema.Types.Mixed],
  enrolledCount: { type:Number, default:0 },
  coverImage:    String,
}, { timestamps:true });
const WorkoutProgram = mongoose.model('WorkoutProgram', ProgramSchema);

const DietPlanSchema = new mongoose.Schema({
  title:String, goal:String, targetKcal:Number, proteinG:Number, carbG:Number, fatG:Number,
  meals:[mongoose.Schema.Types.Mixed], isPublic:{type:Boolean,default:true}, createdBy:{ type:mongoose.Schema.Types.ObjectId, ref:'User' },
}, { timestamps:true });
const DietPlan = mongoose.model('DietPlan', DietPlanSchema);

const ProgressSchema = new mongoose.Schema({
  user:  { type:mongoose.Schema.Types.ObjectId, ref:'User', required:true },
  date:  { type:String, required:true },
  type:  { type:String, required:true },
  data:  mongoose.Schema.Types.Mixed,
  notes: String,
}, { timestamps:true });
const ProgressLog = mongoose.model('ProgressLog', ProgressSchema);

const NotificationSchema = new mongoose.Schema({
  title:String, message:String, type:{type:String,default:'info'},
  targetAll:{type:Boolean,default:true}, readBy:[{type:mongoose.Schema.Types.ObjectId,ref:'User'}],
}, { timestamps:true });
const Notification = mongoose.model('Notification', NotificationSchema);

const SiteSettingsSchema = new mongoose.Schema({
  key:{ type:String, unique:true }, value:mongoose.Schema.Types.Mixed, group:String,
}, { timestamps:true });
const SiteSettings = mongoose.model('SiteSettings', SiteSettingsSchema);

const ScannedCourseSchema = new mongoose.Schema({
  user:{type:mongoose.Schema.Types.ObjectId,ref:'User'},
  programName:String, rawOcr:mongoose.Schema.Types.Mixed,
  exercises:[mongoose.Schema.Types.Mixed], isReviewed:{type:Boolean,default:false}, confidence:Number,
}, { timestamps:true });
const ScannedCourse = mongoose.model('ScannedCourse', ScannedCourseSchema);

// ── AUTH ROUTES ─────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (await User.findOne({ email })) return res.status(400).json({ error: 'البريد مسجل مسبقاً' });
    const user = await User.create({ name, email, password });
    res.status(201).json({ token: signToken(user._id), user: { id:user._id, name, email, role:user.role, plan:user.plan } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password)))
      return res.status(401).json({ error: 'بيانات خاطئة' });
    user.updatedAt = new Date(); await user.save();
    res.json({ token: signToken(user._id), user: { id:user._id, name:user.name, email, role:user.role, plan:user.plan, avatar:user.avatar } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', protect, (req, res) => res.json({ user: req.user }));

app.put('/api/auth/biometrics', protect, async (req, res) => {
  try {
    const metabolic = calcMifflin(req.body);
    const user = await User.findByIdAndUpdate(req.user._id, { biometrics:req.body, metabolic }, { new:true });
    const bt = bloodTypeProtocol(req.body.bloodType);
    res.json({ biometrics:user.biometrics, metabolic, bloodTypeProtocol:bt });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user/metabolic', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const bio  = user.biometrics || {};
    const actualKcal = +req.query.actual_kcal || null;
    const deficit = actualKcal && user.metabolic?.tdee ? user.metabolic.tdee - actualKcal : 0;
    const autoreg = autoReg({ deficit, baseSets:4, baseRest:120 });
    const bt = bloodTypeProtocol(bio.bloodType);
    res.json({ metabolic:user.metabolic, autoreg, bloodTypeProtocol:bt, deficit });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── EXERCISES ROUTES ────────────────────────────────────────────────
app.get('/api/exercises', async (req, res) => {
  try {
    const { category, difficulty, search } = req.query;
    const filter = { isPublic:true };
    if (category) filter.category = category;
    if (difficulty) filter.difficulty = difficulty;
    if (search) filter.$or = [{ name:{$regex:search,$options:'i'} }, { nameAr:{$regex:search,$options:'i'} }];
    res.json(await Exercise.find(filter).sort({ createdAt:-1 }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/exercises/:id', async (req, res) => {
  try { const ex = await Exercise.findById(req.params.id); if(!ex) return res.status(404).json({error:'غير موجود'}); ex.views+=1; await ex.save(); res.json(ex); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/exercises', protect, adminOnly, async (req, res) => {
  try { res.status(201).json(await Exercise.create(req.body)); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/exercises/:id', protect, adminOnly, async (req, res) => {
  try { res.json(await Exercise.findByIdAndUpdate(req.params.id, req.body, {new:true})); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/exercises/:id', protect, adminOnly, async (req, res) => {
  try { await Exercise.findByIdAndDelete(req.params.id); res.json({message:'حذف ناجح'}); } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PROGRAMS ROUTES ─────────────────────────────────────────────────
app.get('/api/programs', async (req, res) => {
  try {
    const filter = { isPublic:true };
    if (req.query.goal)     filter.goal = req.query.goal;
    if (req.query.level)    filter.level = req.query.level;
    if (req.query.featured) filter.isFeatured = true;
    res.json(await WorkoutProgram.find(filter).sort({isFeatured:-1,createdAt:-1}));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/programs/:id', async (req, res) => {
  try { const p = await WorkoutProgram.findById(req.params.id).populate('weeks.days.exercises.exercise'); res.json(p); } catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/programs', protect, adminOnly, async (req, res) => {
  try { res.status(201).json(await WorkoutProgram.create({...req.body, createdBy:req.user._id})); } catch(e) { res.status(500).json({error:e.message}); }
});
app.put('/api/programs/:id', protect, adminOnly, async (req, res) => {
  try { res.json(await WorkoutProgram.findByIdAndUpdate(req.params.id, req.body, {new:true})); } catch(e) { res.status(500).json({error:e.message}); }
});
app.delete('/api/programs/:id', protect, adminOnly, async (req, res) => {
  try { await WorkoutProgram.findByIdAndDelete(req.params.id); res.json({message:'ok'}); } catch(e) { res.status(500).json({error:e.message}); }
});

// ── NUTRITION ROUTES ────────────────────────────────────────────────
app.get('/api/nutrition', async (req, res) => {
  try { res.json(await DietPlan.find({isPublic:true})); } catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/nutrition', protect, adminOnly, async (req, res) => {
  try { res.status(201).json(await DietPlan.create({...req.body, createdBy:req.user._id})); } catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/nutrition/log', protect, async (req, res) => {
  try { res.status(201).json(await ProgressLog.create({user:req.user._id, type:'nutrition', date:req.body.date||new Date().toISOString().slice(0,10), data:req.body})); } catch(e) { res.status(500).json({error:e.message}); }
});

// ── PROGRESS ROUTES ─────────────────────────────────────────────────
app.get('/api/progress', protect, async (req, res) => {
  try {
    const since = new Date(); since.setDate(since.getDate() - +(req.query.days||30));
    const filter = { user:req.user._id, createdAt:{$gte:since} };
    if (req.query.type) filter.type = req.query.type;
    res.json(await ProgressLog.find(filter).sort({date:-1}));
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/progress', protect, async (req, res) => {
  try { res.status(201).json(await ProgressLog.create({user:req.user._id,...req.body})); } catch(e) { res.status(500).json({error:e.message}); }
});

// ── AI SCAN ROUTE (Gemini 1.5 Flash) ────────────────────────────────
const EXERCISE_MATCHER = {
  'bench press':    { id:'bench_press',    nameAr:'بنش برس بالبار',   videoUrl:'https://storage.fitcore.app/videos/bench_press.mp4',    fileSizeMb:44 },
  'squat':          { id:'squat',          nameAr:'سكوات خلفي',        videoUrl:'https://storage.fitcore.app/videos/squat.mp4',          fileSizeMb:48 },
  'deadlift':       { id:'deadlift',       nameAr:'ديدليفت تقليدي',   videoUrl:'https://storage.fitcore.app/videos/deadlift.mp4',       fileSizeMb:52 },
  'overhead press': { id:'ohp',           nameAr:'أوفرهيد برس',       videoUrl:'https://storage.fitcore.app/videos/ohp.mp4',            fileSizeMb:38 },
  'bent over row':  { id:'bent_row',       nameAr:'بنت أوفر رو',       videoUrl:'https://storage.fitcore.app/videos/row.mp4',            fileSizeMb:40 },
  'بنش':            { id:'bench_press',    nameAr:'بنش برس بالبار',   videoUrl:'https://storage.fitcore.app/videos/bench_press.mp4',    fileSizeMb:44 },
  'سكوات':          { id:'squat',          nameAr:'سكوات خلفي',        videoUrl:'https://storage.fitcore.app/videos/squat.mp4',          fileSizeMb:48 },
  'ديدليفت':        { id:'deadlift',       nameAr:'ديدليفت تقليدي',   videoUrl:'https://storage.fitcore.app/videos/deadlift.mp4',       fileSizeMb:52 },
  'تراي':           { id:'triceps',        nameAr:'تريسبس بوش داون',  videoUrl:'https://storage.fitcore.app/videos/pushdown.mp4',       fileSizeMb:26 },
  'باي':            { id:'curl',           nameAr:'بايسبس كيرل',       videoUrl:'https://storage.fitcore.app/videos/curl.mp4',           fileSizeMb:28 },
  'ديبس':           { id:'dips',           nameAr:'ديبس',               videoUrl:'https://storage.fitcore.app/videos/dips.mp4',           fileSizeMb:30 },
  'انكلاين':        { id:'incline',        nameAr:'انكلاين دمبل',      videoUrl:'https://storage.fitcore.app/videos/incline.mp4',        fileSizeMb:38 },
  'كيبل':           { id:'cable',          nameAr:'كيبل كروس أوفر',   videoUrl:'https://storage.fitcore.app/videos/cable.mp4',          fileSizeMb:32 },
};

function matchExercise(name) {
  const lower = name.toLowerCase().trim();
  for (const [key, val] of Object.entries(EXERCISE_MATCHER)) {
    if (lower.includes(key) || name.includes(key)) return val;
  }
  return null;
}

// Main AI scan endpoint — POST /analyze (also aliased as /api/ai/scan-course)
async function handleScan(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'لا توجد صورة' });
    const b64  = req.file.buffer.toString('base64');
    const mime = req.file.mimetype;

    let ocrData;
    try {
      // ── Gemini Vision Call ──────────────────────────────────────────
      const prompt = `حلّل صورة الكورس التدريبي. أجب ONLY بـ JSON صالح بدون أي نص إضافي:
{"program_name":"اسم الكورس","confidence":0.9,"ocr_issues":[],"exercises":[{"name":"اسم التمرين","muscle":"العضلة المستهدفة","sets":4,"fileSizeMb":35}]}
- ٣ إلى ٧ تمارين
- confidence بين 0 و 1
- muscle: اسم العضلة بالعربي (مثل: صدر، ظهر، رجل، كتف، بايسبس، تريسبس)
- fileSizeMb: حجم الفيديو التقريبي بين 25 و 55`;

      const result = await gemini.generateContent([
        { inlineData: { mimeType: mime, data: b64 } },
        { text: prompt }
      ]);

      const raw = result.response.text().replace(/```json|```/g, '').trim();
      ocrData = JSON.parse(raw);
    } catch(e) {
      console.error('Gemini error:', e.message);
      ocrData = {
        program_name: 'كورس مستخرج',
        confidence: 0.7,
        ocr_issues: ['خطأ في التعرف على الصورة'],
        exercises: [
          { name:'بنش برس', muscle:'صدر', sets:4, fileSizeMb:44 },
          { name:'سكوات',   muscle:'رجل', sets:4, fileSizeMb:48 },
          { name:'ديدليفت', muscle:'ظهر', sets:3, fileSizeMb:52 },
        ]
      };
    }

    // Enrich with exercise library
    const enriched = (ocrData.exercises||[]).map(ex => {
      const match = matchExercise(ex.name || ex.name_detected || '');
      return {
        name_detected: ex.name || ex.name_detected || 'تمرين',
        muscle:        ex.muscle || '',
        sets:          ex.sets   || 3,
        fileSizeMb:    ex.fileSizeMb || match?.fileSizeMb || 35,
        exerciseId:    match?.id   || null,
        nameAr:        match?.nameAr || ex.name || ex.name_detected,
        videoUrl:      match?.videoUrl || null,
        needsReview:   !match,
      };
    });

    // Save to DB (only if user is authenticated)
    let courseId = null;
    if (req.user) {
      const course = await ScannedCourse.create({
        user: req.user._id,
        programName: ocrData.program_name,
        rawOcr: ocrData,
        exercises: enriched,
        confidence: ocrData.confidence,
      });
      courseId = course._id;
    }

    res.json({
      courseId,
      programName:     ocrData.program_name,
      confidence:      ocrData.confidence,
      ocr_issues:      ocrData.ocr_issues || [],
      exercises:       enriched,
      needsUserReview: (ocrData.confidence||1) < 0.85 || (ocrData.ocr_issues?.length > 0),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
}

// Route: /analyze  (public — used directly by the frontend button)
app.post('/analyze', upload.single('file'), handleScan);

// Route: /api/ai/scan-course  (protected — for authenticated users)
app.post('/api/ai/scan-course', protect, upload.single('file'), handleScan);

app.post('/api/ai/confirm-course/:id', protect, async (req, res) => {
  try {
    const course = await ScannedCourse.findOneAndUpdate(
      { _id:req.params.id, user:req.user._id },
      { exercises:req.body.exercises, isReviewed:true },
      { new:true }
    );
    if (!course) return res.status(404).json({ error: 'غير موجود' });
    res.json({ message:'تم تأكيد الكورس', courseId:course._id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── NOTIFICATIONS ────────────────────────────────────────────────────
app.get('/api/notifications', protect, async (req, res) => {
  try { res.json(await Notification.find({ $or:[{targetAll:true},{targetUsers:req.user._id}] }).sort({createdAt:-1}).limit(20)); } catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/notifications', protect, adminOnly, async (req, res) => {
  try { res.status(201).json(await Notification.create(req.body)); } catch(e) { res.status(500).json({error:e.message}); }
});

// ── SITE SETTINGS ────────────────────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await SiteSettings.find();
    const obj = {};
    settings.forEach(s => { obj[s.key] = s.value; });
    res.json(obj);
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.put('/api/settings', protect, adminOnly, async (req, res) => {
  try {
    const ops = Object.entries(req.body).map(([key,value]) => ({
      updateOne: { filter:{key}, update:{$set:{key,value,group:req.body.group||'general'}}, upsert:true }
    }));
    await SiteSettings.bulkWrite(ops);
    res.json({ message:'تم الحفظ' });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── ADMIN ROUTES ─────────────────────────────────────────────────────
app.get('/api/admin/stats', protect, adminOnly, async (req, res) => {
  try {
    const [users,exercises,programs,diets,logs] = await Promise.all([User.countDocuments(),Exercise.countDocuments(),WorkoutProgram.countDocuments(),DietPlan.countDocuments(),ProgressLog.countDocuments()]);
    const newUsers7d = await User.countDocuments({ createdAt:{ $gte:new Date(Date.now()-7*86400000) } });
    res.json({ users, exercises, programs, diets, logs, newUsers7d });
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.get('/api/admin/users', protect, adminOnly, async (req, res) => {
  try {
    const filter = {};
    if (req.query.search) filter.$or=[{name:{$regex:req.query.search,$options:'i'}},{email:{$regex:req.query.search,$options:'i'}}];
    if (req.query.role) filter.role=req.query.role;
    res.json(await User.find(filter).select('-password').sort({createdAt:-1}));
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.patch('/api/admin/users/:id', protect, adminOnly, async (req, res) => {
  try { res.json(await User.findByIdAndUpdate(req.params.id, req.body, {new:true}).select('-password')); } catch(e) { res.status(500).json({error:e.message}); }
});
app.delete('/api/admin/users/:id', protect, adminOnly, async (req, res) => {
  try { await User.findByIdAndDelete(req.params.id); res.json({message:'ok'}); } catch(e) { res.status(500).json({error:e.message}); }
});

// ── FAVORITES ────────────────────────────────────────────────────────
app.post('/api/users/favorites/:exId', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const id   = req.params.exId;
    const idx  = user.favorites.indexOf(id);
    if (idx > -1) user.favorites.splice(idx,1); else user.favorites.push(id);
    await user.save(); res.json({ favorites:user.favorites });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── ANALYTICS ───────────────────────────────────────────────────────
app.get('/api/analytics/dashboard', protect, async (req, res) => {
  try {
    const since = new Date(); since.setDate(since.getDate()-30);
    const logs  = await ProgressLog.find({ user:req.user._id, createdAt:{$gte:since} });
    const user  = await User.findById(req.user._id);
    const uniqueDays = new Set(logs.map(l=>l.date)).size;
    res.json({ commitmentDays:uniqueDays, totalLogs:logs.length, goal:user.biometrics?.goal, metabolic:user.metabolic, bloodTypeProtocol:bloodTypeProtocol(user.biometrics?.bloodType) });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── HEALTH ───────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ status:'FITCORE PRO running — Gemini Edition', version:'3.0.0', time:new Date() }));

// ── CATCH-ALL (serve SPA) ────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── START ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fitcore')
  .then(() => {
    console.log('✅ MongoDB connected');
    app.listen(PORT, () => console.log(`🚀 FITCORE PRO (Gemini) on port ${PORT}`));
  })
  .catch(err => { console.error('MongoDB error:', err); process.exit(1); });
