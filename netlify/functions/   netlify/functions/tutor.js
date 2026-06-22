// netlify/functions/tutor.js — серверний Vector на базі Gemini (Netlify Functions)
// Перевіряє Firebase-токен → лише авторизовані → викликає Gemini API

const rateMap = new Map(); // uid → {count, resetAt}
const MAX_RPH = 30;        // 30 запитів / годину / учень

/* ── Перевірка Firebase ID-токена через Google Identity Toolkit ── */
async function verifyFirebaseToken(idToken) {
  const apiKey = process.env.FIREBASE_WEB_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      }
    );
    const data = await res.json();
    if (data.error) return null;
    return data.users?.[0] || null;
  } catch {
    return null;
  }
}

// ── Netlify Functions (Lambda-сумісний формат) ──
// event.headers, event.body — рядки; відповідь — { statusCode, headers, body }
exports.handler = async function (event) {

  // ── CORS ──
  const corsHeaders = {
    'Access-Control-Allow-Origin':  event.headers.origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const respond = (statusCode, obj) => ({
    statusCode,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  });

  // ── Крок 1: перевірка Firebase-токена ──
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return respond(401, { error: 'Потрібна авторизація. Увійди через Google.' });
  }
  const idToken = authHeader.slice(7);
  const user    = await verifyFirebaseToken(idToken);
  if (!user) {
    return respond(401, { error: 'Сесія закінчилась. Оновіть сторінку та увійди знову.' });
  }

  // ── Крок 2: контроль доступу (необов'язково) ──
  const allowedEmails = process.env.ALLOWED_EMAILS
    ? process.env.ALLOWED_EMAILS.split(',').map(e => e.trim().toLowerCase())
    : null;
  if (allowedEmails && !allowedEmails.includes(user.email?.toLowerCase())) {
    return respond(403, { error: `Акаунт ${user.email} не в списку учнів. Зверніться до вчителя.` });
  }

  const allowedDomain = process.env.ALLOWED_DOMAIN || null;
  if (allowedDomain && !user.email?.toLowerCase().endsWith(allowedDomain.toLowerCase())) {
    return respond(403, { error: `Дозволені лише акаунти ${allowedDomain}.` });
  }

  // ── Крок 3: обмеження запитів по UID учня ──
  const uid = user.localId;
  const now = Date.now();
  let rl = rateMap.get(uid);
  if (!rl || now > rl.resetAt) rl = { count: 0, resetAt: now + 3_600_000 };
  rl.count++;
  rateMap.set(uid, rl);
  if (rl.count > MAX_RPH) {
    return respond(429, { error: `Ліміт запитів (${MAX_RPH}/год) вичерпано. Зачекай годину.` });
  }

  // ── Крок 4: валідація тіла запиту ──
  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return respond(400, { error: 'Некоректний JSON.' }); }

  const { messages, sectionIdx, sections, lessonTitle } = payload;
  if (!Array.isArray(messages) || messages.length === 0) {
    return respond(400, { error: 'Некоректний запит.' });
  }

  // ── Крок 5: системний промпт (формується на сервері) ──
  const sIdx      = Math.max(0, Math.min(Number(sectionIdx) || 0, (sections?.length || 1) - 1));
  const curSec    = Array.isArray(sections) && sections[sIdx] ? sections[sIdx] : 'Математика';
  const secList   = Array.isArray(sections) ? sections.map((s, i) => `${i + 1}. ${s}`).join('\n') : '';
  const title     = lessonTitle || 'Степінь числа';
  const isLesson2 = title.toLowerCase().includes('дроб');

  const keyFacts = isLesson2
    ? `([a/b])^n = a^n/b^n; правильний дріб <1 у степені зменшується; неправильний >1 росте; мішане число → спочатку в неправильний дріб; десятковий → звичайний дріб; рахуй знаки як для цілих; 0^0 невизначений.`
    : `a^n: a — основа, n — показник; −2³=−(2³)=−8 (мінус без дужок не в основі); (−2)³=−8, (−2)²=4 (парний знищує мінус); a¹=a; a⁰=1; 1^n=1; 0^n=0 (n>0); 0^0 невизначений.`;

  const systemInstruction =
    `Роль: Ти — експертний, терплячий ШІ-репетитор з математики. Твоя мета — навчити учня мислити, а не просто давати правильні відповіді.\n\n` +
    `Твій алгоритм дій, коли учень робить помилку:\n\n` +
    `КРОК 1. Внутрішня діагностика (невидима для учня):\n` +
    `- Зрозумій ГЛОБАЛЬНУ ТЕМУ (зараз це «${title}», розділ «${curSec}»).\n` +
    `Проаналізуй помилку. Визнач її корінь: це нерозуміння поточної теми (наприклад, властивості степенів) чи прогалина в базових/попередніх темах (наприклад, невміння додавати від'ємні числа чи працювати з дробами)?\n\n` +
    `КРОК 2. Зворотний зв'язок та Коротка теорія:\n` +
    `Дружелюбно вкажи, що є помилка, але НІКОЛИ не пиши правильну фінальну відповідь. Надай 1-2 речення цільової теорії, яка стосується саме тієї "сліпої зони", яку ти діагностував.\n\n` +
    `КРОК 3. Декомпозиція та Інтерактив (Сократичний діалог):\n` +
    `Розбий проблемне завдання на 2-3 логічні мікрокроки. Задай учню ТІЛЬКИ ОДНЕ запитання для першого кроку. Використовуй формати:\n` +
    `Вибір правильної відповіді (А, Б, В, Г)\n` +
    `Вірно / Невірно\n` +
    `Відновлення правильної послідовності кроків.\n` +
    `Розбір похожих помилок\n` +
    `Чекай на відповідь учня, перш ніж переходити до наступного кроку.\n\n` +
    `КРОК 4. Перевірка засвоєння (після успішного розв'язання):\n` +
    `Коли учень за твоєю допомогою правильно розв'язав своє завдання, згенеруй 2-4 аналогічні, але короткі завдання на перевірку закріплення цього конкретного навику але в системному вигляді.\n\n` +
    `Тон: Професійний, підтримуючий, академічний, але зрозумілий. Форматування математики виключно в LaTeX (inline у $...$, вирази у $$...$$).\n` +
    `ВАЖЛИВО: чат учня не має LaTeX-рендерера, тому замість $...$ використовуй прості символи: степені як x^2 або x², дроби як a/b. Не використовуй символи $ у відповіді.\n\n` +
    `Контекст уроку «${title}»:\n${secList}\n` +
    `Ключові факти теми: ${keyFacts}\n` +
    `Відповідай українською мовою.`;

  // ── Крок 6: санітизація + конвертація історії у формат Gemini ──
  const safeHistory = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: String(m.content).slice(0, 2000) }))
    .slice(-10);

  const geminiContents = safeHistory.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  // ── Крок 7: виклик Gemini (ключ лише на сервері) ──
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    return respond(500, { error: 'Сервер не налаштований. Зверніться до адміністратора.' });
  }

  const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  try {
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': geminiKey
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemInstruction }] },
          contents: geminiContents,
          generationConfig: { maxOutputTokens: 600, temperature: 0.7 },
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
          ]
        })
      }
    );

    const data = await upstream.json();

    if (data.error) {
      console.error('Gemini error:', data.error);
      return respond(502, { error: data.error.message || 'Помилка Gemini API.' });
    }

    const candidate = data.candidates?.[0];
    if (!candidate || candidate.finishReason === 'SAFETY') {
      return respond(200, { text: 'Перефразуй питання, будь ласка 🙂' });
    }

    const text = (candidate.content?.parts || [])
      .map(p => p.text || '')
      .join('\n')
      .trim() || 'Спробуй ще раз сформулювати 🙂';

    return respond(200, { text });

  } catch (err) {
    console.error('Vector proxy error:', err);
    return respond(500, { error: 'Сервер тимчасово недоступний.' });
  }
};
