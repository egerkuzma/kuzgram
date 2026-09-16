'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');

const store = require('./db');
const push = require('./push');
const files = require('./files');
const { newToken, requireAuth } = require('./auth');

const NAME_MAX = 32;
const TEXT_MAX = 4000;
const PAGE_LIMIT = 100;

// Перебор кодов. Настоящий IP клиента до нас не доходит (роутер терминирует TLS
// и не проставляет X-Forwarded-For), различать источники нечем — поэтому счётчик
// общий. Легальных входов тут единицы в месяц, так что лимит можно держать низким
const JOIN_MAX_FAILS = Number(process.env.JOIN_MAX_FAILS || 15);
const JOIN_WINDOW_MS = Number(process.env.JOIN_WINDOW_MS || 10 * 60 * 1000);

let joinFailures = [];

function joinLocked() {
  const since = Date.now() - JOIN_WINDOW_MS;
  joinFailures = joinFailures.filter((ts) => ts > since);
  return joinFailures.length >= JOIN_MAX_FAILS;
}

const PORT = 3000;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Клиенту лимит нужен заранее: проверить размер до того, как гнать
// двести мегабайт по мобильному интернету
const clientLimits = () => ({ file_max_bytes: files.FILE_MAX_BYTES });

// К вложению в выдаче прикладывается свежая ссылка на скачивание
function withLink(message) {
  if (!message || !message.file) return message;
  return { ...message, file: { ...message.file, ...files.linkFor(message.file.id) } };
}

const app = express();
app.use(express.json({ limit: '64kb' }));

// Если прокси перед приложением терминирует TLS и не проставляет
// X-Forwarded-Proto, отличить http-запрос от https в коде нельзя: соединения
// на 80-м порту режутся только там же, на прокси. Здесь доступен лишь HSTS —
// браузер, увидевший его хоть раз по https, дальше сам переписывает http://
// на https:// ещё до выхода в сеть.
app.use((req, res, next) => {
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  // Весь фронт свой и без инлайн-скриптов, так что политику можно затянуть
  // до упора: чужой скрипт не выполнится, в чужой фрейм страницу не вставят
  res.set(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

// sw.js — всегда свежий, иначе браузер держит старую версию воркера
app.get('/sw.js', (req, res, next) => {
  const file = path.join(PUBLIC_DIR, 'sw.js');
  if (!fs.existsSync(file)) return next();
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.type('application/javascript');
  res.sendFile(file);
});

// Скачивание по подписанной ссылке. Токена тут нет и быть не может: <img>
// и <a download> заголовков не шлют. Доступ даёт только свежая подпись,
// а её выдаёт авторизованный /api/files/:id/link
app.get('/files/:id', (req, res) => {
  const { id } = req.params;
  const verdict = files.verifyLink(id, req.query.exp, req.query.sig);

  if (verdict !== 'ok') {
    return res
      .status(403)
      .type('text/plain; charset=utf-8')
      .send(verdict === 'expired' ? 'Ссылка устарела, открой файл из чата ещё раз' : 'Нет доступа');
  }

  const file = store.getAttachment(id);
  if (!file) return res.status(404).type('text/plain; charset=utf-8').send('Файл не найден');

  res.set(files.downloadHeaders(file, req.query.dl === '1'));
  // dotfiles: 'allow' — имя файла шестнадцатеричное, а точка может встретиться
  // выше по пути каталога, и без этого send молча отвечал бы 404
  res.sendFile(files.pathFor(id), { cacheControl: false, lastModified: false, dotfiles: 'allow' }, (err) => {
    if (!err || res.headersSent) return;
    res.removeHeader('Content-Disposition');
    res.status(404).type('text/plain; charset=utf-8').send('Файл не найден');
  });
});

app.use(express.static(PUBLIC_DIR));

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC || null });
});

app.post('/api/join', (req, res) => {
  const body = req.body || {};
  const code = String(body.code || '').trim().toUpperCase();
  const name = String(body.name || '').trim().replace(/\s+/g, ' ');

  if (joinLocked()) {
    console.warn('[join] заблокирован: слишком много неудачных попыток');
    return res.status(429).json({ error: 'too_many_attempts' });
  }

  if (!code) return res.status(400).json({ error: 'no_code' });
  if (name.length > NAME_MAX) return res.status(400).json({ error: 'long_name' });

  // Имя нужно только новому участнику: код на второе устройство берёт
  // человека из invites.for_user, и это решается внутри транзакции
  const result = store.redeemInvite(code, name);
  if (result.error) {
    // В счётчик идут только выстрелы мимо: код, которого нет, и протухший.
    // «Уже использован» и «забыл имя» — это свои промахи, из-за них нельзя
    // приближать общую блокировку
    if (result.error === 'unknown_code' || result.error === 'code_expired') {
      joinFailures.push(Date.now());
      console.warn(`[join] отказ (${result.error}), неудач за окно: ${joinFailures.length}`);
    }
    return res.status(400).json({ error: result.error });
  }

  const token = newToken();
  store.createToken(token, result.user.id);

  console.log(`[join] ${result.user.name} (id=${result.user.id}) по коду ${code}`);
  res.json({ token, user: { id: result.user.id, name: result.user.name }, limits: clientLimits() });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.user, limits: clientLimits() });
});

app.get('/api/messages', requireAuth, (req, res) => {
  const raw = Number.parseInt(req.query.after, 10);
  const after = Number.isFinite(raw) && raw > 0 ? raw : 0;
  res.json({ messages: store.messagesAfter(after).map(withLink), limit: PAGE_LIMIT });
});

app.post('/api/messages', requireAuth, (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();

  if (!text) return res.status(400).json({ error: 'empty_text' });
  if (text.length > TEXT_MAX) return res.status(400).json({ error: 'long_text' });

  const message = store.addMessage(req.user.id, text);
  console.log(`[msg] #${message.id} от ${req.user.name}: ${text.slice(0, 40)}`);

  // Ответ не ждёт рассылки: отправитель не должен смотреть на спиннер,
  // пока Apple принимает пуши для остальных
  push
    .broadcast(req.user.id, { title: message.user_name, body: message.text, id: message.id })
    .catch((err) => console.error('[push] рассылка упала:', err.message));

  res.json({ message });
});

// Файл идёт телом запроса как есть, без multipart: имя и тип — в заголовках.
// Так не нужна библиотека для разбора форм, и поток сразу пишется на диск
app.post('/api/files', requireAuth, async (req, res) => {
  const tooLarge = () =>
    res.status(413).set('Connection', 'close').json({ error: 'file_too_large', limit: files.FILE_MAX_BYTES });

  const declared = Number(req.get('content-length'));
  if (Number.isFinite(declared) && declared > files.FILE_MAX_BYTES) return tooLarge();

  const name = files.sanitizeName(req.get('x-file-name'));
  const mime = files.normalizeMime(req.get('x-file-type'), name);

  let stored;
  try {
    stored = await files.receive(req);
  } catch (err) {
    if (res.headersSent || err.code === 'upload_aborted') return;
    if (err.code === 'file_too_large') return tooLarge();
    if (err.code === 'empty_file') return res.status(400).json({ error: 'empty_file' });
    console.error('[file] приём упал:', (err.cause && err.cause.message) || err.message);
    return res.status(400).json({ error: 'upload_failed' });
  }

  let message;
  try {
    message = store.addFileMessage(req.user.id, { id: stored.id, name, mime, size: stored.size });
  } catch (err) {
    files.remove(stored.id);
    console.error('[file] запись в базу упала:', err.message);
    return res.status(500).json({ error: 'upload_failed' });
  }

  console.log(`[file] #${message.id} от ${req.user.name}: ${name}, ${stored.size} байт`);

  push
    .broadcast(req.user.id, { title: message.user_name, body: files.pushText(message.file), id: message.id })
    .catch((err) => console.error('[push] рассылка упала:', err.message));

  res.json({ message: withLink(message) });
});

app.get('/api/files/:id/link', requireAuth, (req, res) => {
  const file = files.isValidId(req.params.id) && store.getAttachment(req.params.id);
  if (!file) return res.status(404).json({ error: 'no_file' });
  res.json(files.linkFor(file.id));
});

app.post('/api/subscribe', requireAuth, (req, res) => {
  const sub = req.body || {};
  const keys = sub.keys || {};

  if (typeof sub.endpoint !== 'string' || !sub.endpoint || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'bad_subscription' });
  }

  store.saveSubscription(req.user.id, sub.endpoint, { p256dh: keys.p256dh, auth: keys.auth });
  console.log(`[sub] ${req.user.name}: ${sub.endpoint.slice(0, 50)}… (всего ${store.countSubscriptions()})`);

  res.json({ ok: true });
});

// При запуске из тестов слушать не надо: там поднимают app на своём порту
if (require.main === module) {
  const server = app.listen(PORT, HOST, () => {
    console.log(`kuzgram слушает http://${HOST}:${PORT}`);
    console.log(`база: ${store.db.name}, файлы: ${files.FILES_DIR}`);
  });

  // По умолчанию Node обрывает запрос через пять минут. Большой APK
  // по мобильному интернету в это легко не укладывается
  server.requestTimeout = 60 * 60 * 1000;
}

module.exports = app;
