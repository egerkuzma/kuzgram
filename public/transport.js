'use strict';

// Доставка сообщений. Сейчас — опрос раз в 2.5 секунды, но наружу торчит
// только start/stop/onMessages/onError: чтобы заменить опрос на WebSocket,
// достаточно переписать этот файл, остальной фронт трогать не придётся.

window.Transport = (function () {
  var POLL_MS = 2500;
  var LIMIT = 100;

  var getToken = function () { return null; };
  var messageHandlers = [];
  var errorHandlers = [];

  var running = false;
  var inFlight = false;
  var timer = null;
  var lastId = 0;

  function emit(handlers, arg) {
    for (var i = 0; i < handlers.length; i++) {
      try {
        handlers[i](arg);
      } catch (err) {
        console.error('transport handler', err);
      }
    }
  }

  async function fetchBatch() {
    var res = await fetch('/api/messages?after=' + lastId, {
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + getToken() },
    });

    if (!res.ok) {
      var err = new Error('HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }

    var data = await res.json();
    var messages = (data && data.messages) || [];

    if (messages.length) {
      lastId = messages[messages.length - 1].id;
      emit(messageHandlers, messages);
    }
    return messages.length;
  }

  async function poll() {
    if (!running || inFlight) return;
    inFlight = true;
    try {
      var got;
      // Полная пачка — значит есть ещё, дочитываем не дожидаясь следующего тика
      do {
        got = await fetchBatch();
      } while (running && got >= LIMIT);

      emit(errorHandlers, null); // связь есть
    } catch (err) {
      emit(errorHandlers, { status: err.status || 0, message: err.message || String(err) });
      if (err.status === 401) stop();
    } finally {
      inFlight = false;
    }
  }

  function startTimer() {
    if (!timer) timer = setInterval(poll, POLL_MS);
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  // Вкладка в фоне — не долбим сервер. Вернулись — сразу один запрос,
  // не дожидаясь следующего тика
  function onVisibilityChange() {
    if (!running) return;
    if (document.hidden) {
      stopTimer();
    } else {
      poll();
      startTimer();
    }
  }

  function start(afterId) {
    if (running) return;
    running = true;
    lastId = Number(afterId) || 0;
    document.addEventListener('visibilitychange', onVisibilityChange);
    poll();
    startTimer();
  }

  function stop() {
    running = false;
    stopTimer();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  return {
    configure: function (options) {
      if (options && typeof options.getToken === 'function') getToken = options.getToken;
    },
    onMessages: function (fn) { messageHandlers.push(fn); },
    onError: function (fn) { errorHandlers.push(fn); },
    start: start,
    stop: stop,
    poke: poll, // «проверь прямо сейчас» — например, после своей отправки
    lastId: function () { return lastId; },
  };
})();
