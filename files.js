'use strict';

// Вложения: приём на диск, подписанные ссылки на скачивание, заголовки отдачи.
//
// Токен ездит в заголовке Authorization, а <img src> и <a download> заголовков
// не шлют. Поэтому файл отдаётся по ссылке с HMAC-подписью и сроком жизни:
// её выдаёт только авторизованный API, подделать или продлить её нельзя.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { DB_PATH } = require('./db');

const MB = 1024 * 1024;
const FILE_MAX_BYTES = Math.round(Number(process.env.FILE_MAX_MB || 200) * MB);
const LINK_TTL = 30 * 60; // секунд

// Файлы лежат рядом с базой: в контейнере это том /data, и пересборка их не трогает
const FILES_DIR = path.resolve(process.env.FILES_DIR || path.join(path.dirname(DB_PATH), 'files'));
fs.mkdirSync(FILES_DIR, { recursive: true, mode: 0o700 });

// Ключ подписи выводится из VAPID_PRIVATE: секрет уже есть на сервере, а ссылки
// переживают перезапуск контейнера. Без него — случайный ключ на время жизни процесса
const LINK_KEY = process.env.VAPID_PRIVATE
  ? crypto.createHmac('sha256', process.env.VAPID_PRIVATE).update('kuzgram:file-links').digest()
  : crypto.randomBytes(32);

// Прямо в браузере показываем только растровые картинки. SVG умеет исполнять
// скрипты, HTML — тем более: всё, кроме этого списка, только скачивается
const PREVIEW_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Типы, которые браузер способен исполнить или отрисовать как документ.
// Даже при скачивании отдаём их нейтральным octet-stream
const ACTIVE_TYPE = /^(text\/|application\/(xhtml\+xml|xml|javascript|x-javascript|ecmascript)|image\/svg\+xml)/;

// Если браузер не сообщил тип (десктопный Chrome так делает с .apk), угадываем
// по расширению. Иначе Android не предложит установить скачанный APK
const EXT_TYPES = {
  apk: 'application/vnd.android.package-archive',
  pdf: 'application/pdf',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
};

const ID_PATTERN = /^[a-f0-9]{32}$/;

function codeError(code, cause) {
  const err = new Error(code);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

const newId = () => crypto.randomBytes(16).toString('hex');
const isValidId = (id) => typeof id === 'string' && ID_PATTERN.test(id);
const pathFor = (id) => path.join(FILES_DIR, id);

// Исходное имя живёт только в базе и в Content-Disposition — на диск файл ложится
// под случайным id. Но и в заголовок имя попадает вычищенным: без путей,
// управляющих символов и bidi-разворотов, которыми «setup.exe» маскируют под «exe.txt»
function sanitizeName(raw) {
  let name = '';
  try {
    name = decodeURIComponent(String(raw || ''));
  } catch (err) {
    name = '';
  }

  name = name
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim();

  if (!name || /^\.+$/.test(name)) name = 'file';

  if (name.length > 180) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, 180 - ext.length) + ext;
  }
  return name;
}

function normalizeMime(raw, name) {
  const value = String(raw || '').trim().toLowerCase();
  if (value.length <= 100 && /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(value)) {
    return value;
  }
  const ext = path.extname(name).slice(1).toLowerCase();
  return EXT_TYPES[ext] || 'application/octet-stream';
}

const isPreviewable = (mime) => PREVIEW_TYPES.has(mime);

/* ---------- приём ---------- */

// Поток запроса пишется прямо на диск: большой APK не должен оседать в памяти.
// Сначала во временный .part, в итоговое имя — только после успешного приёма
function receive(req) {
  return new Promise((resolve, reject) => {
    const id = newId();
    const tmp = pathFor(id) + '.part';
    const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });

    let size = 0;
    let settled = false;

    function fail(code, cause) {
      if (settled) return;
      settled = true;
      req.unpipe(out);
      out.destroy();
      fs.rm(tmp, { force: true }, () => {});
      reject(codeError(code, cause));
    }

    // Слушатель data вешается раньше pipe: при переполнении запись обрывается,
    // а остаток тела просто вычитывается в никуда
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > FILE_MAX_BYTES) fail('file_too_large');
    });
    req.on('error', (err) => fail('upload_failed', err));
    req.on('close', () => {
      if (!req.complete) fail('upload_aborted');
    });
    out.on('error', (err) => fail('upload_failed', err));

    out.on('finish', () => {
      if (settled) return;
      if (size === 0) return fail('empty_file');

      fs.rename(tmp, pathFor(id), (err) => {
        if (err) return fail('upload_failed', err);
        settled = true;
        resolve({ id, size });
      });
    });

    req.pipe(out);
  });
}

function remove(id) {
  if (!isValidId(id)) return;
  fs.rm(pathFor(id), { force: true }, () => {});
}

/* ---------- ссылки ---------- */

function sign(id, exp) {
  return crypto.createHmac('sha256', LINK_KEY).update(`${id}.${exp}`).digest('base64url');
}

// Отдаём не момент истечения, а сколько секунд осталось: часы на телефоне
// могут расходиться с серверными, и клиент считает срок от своего «сейчас»
function linkFor(id, now) {
  const exp = Math.floor((now || Date.now()) / 1000) + LINK_TTL;
  return { url: `/files/${id}?exp=${exp}&sig=${sign(id, exp)}`, expires_in: LINK_TTL };
}

// 'ok' | 'expired' | 'bad'
function verifyLink(id, exp, sig, now) {
  if (!isValidId(id) || typeof exp !== 'string' || typeof sig !== 'string') return 'bad';
  if (!/^\d{1,12}$/.test(exp) || !sig) return 'bad';

  const expected = Buffer.from(sign(id, exp));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return 'bad';

  // Срок проверяется после подписи: иначе по ответу можно было бы гадать о чужих id
  if (Number(exp) * 1000 < (now || Date.now())) return 'expired';
  return 'ok';
}

/* ---------- отдача ---------- */

function encodeRfc5987(value) {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function downloadHeaders(file, forceDownload) {
  const inline = !forceDownload && isPreviewable(file.mime);
  const type = inline || !ACTIVE_TYPE.test(file.mime) ? file.mime : 'application/octet-stream';
  const asciiName = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

  return {
    'Content-Type': type,
    'Content-Disposition':
      `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; ` +
      `filename*=UTF-8''${encodeRfc5987(file.name)}`,
    // Даже если браузер решит отрисовать файл, ни скрипта, ни формы в нём не будет
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': 'private, max-age=3600',
  };
}

const pushText = (file) => (isPreviewable(file.mime) ? '📷 ' : '📎 ') + file.name;

module.exports = {
  FILE_MAX_BYTES,
  FILES_DIR,
  LINK_TTL,
  isValidId,
  pathFor,
  sanitizeName,
  normalizeMime,
  isPreviewable,
  receive,
  remove,
  sign,
  linkFor,
  verifyLink,
  downloadHeaders,
  pushText,
};
