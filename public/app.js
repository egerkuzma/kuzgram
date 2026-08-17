'use strict';

var TOKEN_KEY = 'kuzgram.token';
var STICK_PX = 80; // насколько близко к низу считаем «человек смотрит новые»

var el = {
  login: document.getElementById('login'),
  loginForm: document.getElementById('login-form'),
  code: document.getElementById('login-code'),
  name: document.getElementById('login-name'),
  submit: document.getElementById('login-submit'),
  loginError: document.getElementById('login-error'),
  chat: document.getElementById('chat'),
  who: document.getElementById('who'),
  pushBtn: document.getElementById('enable-push'),
  feed: document.getElementById('feed'),
  feedEmpty: document.getElementById('feed-empty'),
  jump: document.getElementById('jump'),
  composer: document.getElementById('composer'),
  input: document.getElementById('composer-input'),
  send: document.getElementById('composer-send'),
  pageError: document.getElementById('page-error'),
};

var state = {
  token: localStorage.getItem(TOKEN_KEY),
  user: null,
  seen: new Set(), // id уже показанных сообщений — чтобы опрос не задваивал
  started: false,
};

var ERRORS = {
  unknown_code: 'Такого кода нет',
  code_used: 'Код уже использован',
  code_expired: 'Срок действия кода истёк, попроси новый',
  too_many_attempts: 'Слишком много попыток. Подожди 10 минут',
  no_code: 'Введи код',
  no_name: 'Введи имя',
  long_name: 'Имя слишком длинное',
  no_token: 'Нужно войти заново',
  bad_token: 'Токен больше не действует, войди заново',
  empty_text: 'Пустое сообщение',
  long_text: 'Сообщение слишком длинное',
};

// На айфоне консоли нет, поэтому любая неожиданная ошибка — на страницу
function showPageError(message) {
  el.pageError.textContent = message;
  el.pageError.hidden = false;
}

function clearPageError() {
  el.pageError.hidden = true;
}

function showLoginError(message) {
  el.loginError.textContent = message;
  el.loginError.hidden = !message;
}

function describe(err) {
  if (err && err.code && ERRORS[err.code]) return ERRORS[err.code];
  if (err && err.offline) return 'Нет связи с сервером';
  if (err && err.message) return err.message;
  return String(err);
}

async function api(path, options) {
  var opts = options || {};
  var headers = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = 'Bearer ' + state.token;

  var res;
  try {
    res = await fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (netErr) {
    var offline = new Error('Нет связи с сервером');
    offline.offline = true;
    throw offline;
  }

  var data = null;
  try {
    data = await res.json();
  } catch (parseErr) {
    data = null;
  }

  if (!res.ok) {
    var err = new Error((data && data.error) || 'HTTP ' + res.status);
    err.status = res.status;
    err.code = data && data.error;
    throw err;
  }
  return data;
}

/* ---------- лента ---------- */

function atBottom() {
  return el.feed.scrollHeight - el.feed.scrollTop - el.feed.clientHeight < STICK_PX;
}

function scrollToBottom() {
  el.feed.scrollTop = el.feed.scrollHeight;
}

function hhmm(ts) {
  var d = new Date(ts);
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

function bubble(text, own) {
  var wrap = document.createElement('div');
  wrap.className = 'msg ' + (own ? 'own' : 'other');

  var box = document.createElement('div');
  box.className = 'bubble';

  var body = document.createElement('span');
  body.className = 'text';
  body.textContent = text; // только textContent: чужой текст в разметку не пускаем
  box.appendChild(body);

  var meta = document.createElement('span');
  meta.className = 'meta';
  box.appendChild(meta);

  wrap.appendChild(box);
  wrap._meta = meta;
  wrap._box = box;
  return wrap;
}

function renderMessage(msg) {
  var own = msg.user_id === state.user.id;
  var node = bubble(msg.text, own);
  node.dataset.id = String(msg.id);
  node.dataset.uid = String(msg.user_id);

  if (!own) {
    var author = document.createElement('span');
    author.className = 'author';
    author.textContent = msg.user_name;
    node._box.insertBefore(author, node._box.firstChild);
  }
  node._meta.textContent = hhmm(msg.created_at);
  return node;
}

// Вставка по возрастанию id; неподтверждённые (без data-id) всегда в хвосте
function insertByOrder(node) {
  var id = Number(node.dataset.id);
  var children = el.feed.children;

  for (var i = 0; i < children.length; i++) {
    var child = children[i];
    if (child === el.feedEmpty) continue;
    var childId = child.dataset && child.dataset.id ? Number(child.dataset.id) : Infinity;
    if (childId > id) {
      el.feed.insertBefore(node, child);
      return;
    }
  }
  el.feed.appendChild(node);
}

// Подряд идущие сообщения одного автора: имя показываем только у первого
function refreshGrouping() {
  var prevUid = null;

  for (var i = 0; i < el.feed.children.length; i++) {
    var node = el.feed.children[i];
    if (!node.dataset || !node.dataset.uid) continue;
    node.classList.toggle('grouped', node.dataset.uid === prevUid);
    prevUid = node.dataset.uid;
  }
}

function addMessages(list) {
  var stick = atBottom();
  var added = 0;

  for (var i = 0; i < list.length; i++) {
    var msg = list[i];
    if (state.seen.has(msg.id)) continue;
    state.seen.add(msg.id);
    insertByOrder(renderMessage(msg));
    added++;
  }

  if (!added) return;

  el.feedEmpty.hidden = true;
  refreshGrouping();

  // Человек читает историю — не дёргаем ленту, а показываем кнопку
  if (stick) scrollToBottom();
  else el.jump.hidden = false;
}

// Клавиатура iOS не двигает layout, а накрывает его: без этого композер
// уезжает под неё. Держим высоту страницы по видимой части вьюпорта
function syncViewport() {
  var vv = window.visualViewport;
  if (!vv) return;

  var stick = atBottom();
  document.body.style.height = vv.height + 'px';
  window.scrollTo(0, 0); // страница сама не должна ползать под клавиатурой
  if (stick) scrollToBottom();
}

/* ---------- отправка ---------- */

function markPending(node, status, detail) {
  node.classList.toggle('pending', status === 'sending');
  node.classList.toggle('failed', status === 'failed');

  if (status === 'sending') node._meta.textContent = 'отправляется…';
  if (status === 'failed') node._meta.textContent = (detail || 'не отправлено') + ' · нажми, чтобы повторить';
}

async function deliver(text, node) {
  markPending(node, 'sending');
  try {
    var data = await api('/api/messages', { method: 'POST', body: { text: text } });
    node.remove();
    addMessages([data.message]);
    scrollToBottom();
    Transport.poke();
  } catch (err) {
    markPending(node, 'failed', describe(err));
    if (err.status === 401) return dropSession();
    node.onclick = function () {
      node.onclick = null;
      deliver(text, node);
    };
  }
}

function onSubmitMessage(event) {
  event.preventDefault();
  var text = el.input.value.trim();
  if (!text) return;

  el.input.value = '';
  el.feedEmpty.hidden = true;

  var node = bubble(text, true); // оптимистично: рисуем сразу, не дожидаясь сервера
  node.dataset.uid = String(state.user.id); // чтобы группировка видела автора
  el.feed.appendChild(node);
  scrollToBottom();

  deliver(text, node);
}

/* ---------- уведомления ---------- */

var push = { key: null };

function pushSupported() {
  return 'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof Notification !== 'undefined';
}

function updatePushButton() {
  el.pushBtn.hidden = !(pushSupported() && Notification.permission !== 'granted');
}

async function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    showPageError('Service worker не зарегистрировался: ' + describe(err));
  }
}

async function vapidKey() {
  if (!push.key) {
    var data = await api('/api/vapid-public-key');
    if (!data || !data.key) throw new Error('Сервер не отдал VAPID-ключ');
    push.key = data.key;
  }
  return push.key;
}

function urlBase64ToUint8Array(base64) {
  var padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  var raw = atob(padded);
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(sub, bytes) {
  var current = sub.options && sub.options.applicationServerKey;
  if (!current) return false; // не знаем, чем подписывались — переоформим
  var a = new Uint8Array(current);
  if (a.length !== bytes.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== bytes[i]) return false;
  return true;
}

async function ensureSubscription(bytes) {
  var reg = await navigator.serviceWorker.ready;
  var sub = await reg.pushManager.getSubscription();

  // На этом origin мог остаться прототип, подписанный другим VAPID-ключом.
  // subscribe() поверх такой подписки отвечает InvalidStateError, поэтому
  // сначала отписываемся
  if (sub && !sameKey(sub, bytes)) {
    await sub.unsubscribe();
    sub = null;
  }

  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    } catch (err) {
      if (err && err.name === 'InvalidStateError') {
        var stale = await reg.pushManager.getSubscription();
        if (stale) await stale.unsubscribe();
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
      } else {
        throw err;
      }
    }
  }

  await api('/api/subscribe', { method: 'POST', body: sub.toJSON() });
  return sub;
}

async function onEnablePush() {
  el.pushBtn.disabled = true;
  try {
    if (!pushSupported()) {
      throw new Error('Браузер не умеет push. На iPhone нужен iOS 16.4+ и запуск с экрана «Домой»');
    }

    // Первым делом, без единого await перед этой строкой: на iOS диалог
    // не появится, если он не вызван прямо из обработчика клика
    var permission = await Notification.requestPermission();
    updatePushButton();

    if (permission !== 'granted') {
      throw new Error(permission === 'denied'
        ? 'Разрешение отклонено. iOS второй раз не спросит: удали иконку с «Домой» и добавь заново'
        : 'Разрешение не выдано');
    }

    await ensureSubscription(urlBase64ToUint8Array(await vapidKey()));
    clearPageError();
    updatePushButton();
  } catch (err) {
    showPageError('Уведомления: ' + describe(err));
  } finally {
    el.pushBtn.disabled = false;
  }
}

// Разрешение уже есть, а подписки нет — например, PWA переустановили.
// Гестура тут не нужна, поэтому переоформляем молча
async function refreshSubscription() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  try {
    await ensureSubscription(urlBase64ToUint8Array(await vapidKey()));
  } catch (err) {
    console.error('push refresh', err);
  }
}

/* ---------- экраны ---------- */

function showLogin() {
  state.user = null;
  el.chat.classList.remove('active');
  el.chat.hidden = true;
  el.login.hidden = false;
  el.login.classList.add('active');
  el.code.focus();
}

function showChat(user) {
  state.user = user;
  el.who.textContent = user.name;
  el.login.classList.remove('active');
  el.login.hidden = true;
  el.chat.hidden = false;
  el.chat.classList.add('active');
  updatePushButton();
  startTransport();
  refreshSubscription();
}

function forgetToken() {
  state.token = null;
  localStorage.removeItem(TOKEN_KEY);
}

function dropSession() {
  Transport.stop();
  state.started = false;
  state.seen.clear();
  el.feed.innerHTML = '';
  el.feed.appendChild(el.feedEmpty);
  el.feedEmpty.hidden = false;
  forgetToken();
  showLogin();
  showLoginError(ERRORS.bad_token);
}

// Обработчики вешаются один раз за жизнь страницы: если регистрировать их
// при каждом входе, после разлогина и повторного входа они бы копились
function wireTransport() {
  Transport.configure({ getToken: function () { return state.token; } });
  Transport.onMessages(addMessages);
  Transport.onError(function (err) {
    if (!err) return clearPageError();
    if (err.status === 401) return dropSession();
    showPageError(err.status >= 500
      ? 'Сервер отвечает ошибкой ' + err.status + '. Пробую снова…'
      : 'Нет связи с сервером. Пробую снова…');
  });
}

function startTransport() {
  if (state.started) return;
  state.started = true;
  Transport.start(0);
}

/* ---------- вход ---------- */

async function onSubmitLogin(event) {
  event.preventDefault();
  showLoginError('');
  clearPageError();

  var code = el.code.value.trim().toUpperCase();
  var name = el.name.value.trim();
  if (!code) return showLoginError('Введи код');

  el.submit.disabled = true;
  try {
    var data = await api('/api/join', { method: 'POST', body: { code: code, name: name } });
    state.token = data.token;
    localStorage.setItem(TOKEN_KEY, data.token);
    el.code.value = '';
    el.name.value = '';
    showChat(data.user);
  } catch (err) {
    showLoginError(describe(err));
  } finally {
    el.submit.disabled = false;
  }
}

// Токен есть — восстанавливаем сессию. Токен снимаем только на 401:
// упавший сервер или пропавшая сеть не повод выкидывать человека на форму входа
async function resume() {
  try {
    var data = await api('/api/me');
    clearPageError();
    showChat(data.user);
  } catch (err) {
    if (err.status === 401) {
      forgetToken();
      showLogin();
      showLoginError(describe(err));
      return;
    }
    showPageError(describe(err) + '. Пробую снова…');
    setTimeout(resume, 3000);
  }
}

// По http приложение всё равно нерабочее: WebKit не даст ни service worker,
// ни push. Показываем заглушку вместо чата — но это только про UI, реальный
// запрет соединений на 80-м порту живёт на роутере, не здесь
function isInsecure() {
  if (location.protocol === 'https:') return false;
  var host = location.hostname;
  var local = host === 'localhost' || host === '127.0.0.1' ||
    /^192\.168\./.test(host) || /^10\./.test(host);
  return !local;
}

function showInsecure() {
  var screen = document.getElementById('insecure');
  screen.hidden = false;
  screen.classList.add('active');
}

function boot() {
  if (isInsecure()) return showInsecure();

  el.loginForm.addEventListener('submit', onSubmitLogin);
  el.composer.addEventListener('submit', onSubmitMessage);
  el.pushBtn.addEventListener('click', onEnablePush);

  el.jump.addEventListener('click', function () {
    scrollToBottom();
    el.jump.hidden = true;
  });
  el.feed.addEventListener('scroll', function () {
    if (atBottom()) el.jump.hidden = true;
  });
  el.input.addEventListener('focus', function () {
    setTimeout(scrollToBottom, 250); // ждём, пока клавиатура доедет
  });

  // Только resize: на scroll сюда прилетает ещё и пинч-зум, и принудительный
  // scrollTo(0,0) вырывал бы страницу из-под пальца
  if (window.visualViewport) window.visualViewport.addEventListener('resize', syncViewport);

  wireTransport();

  registerWorker();
  vapidKey().catch(function () { /* понадобится только при подписке */ });

  if (!state.token) return showLogin();
  resume();
}

boot();
