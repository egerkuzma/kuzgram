'use strict';

const crypto = require('crypto');
const store = require('./db');

// Токен бессрочный, отзыв — удалением строки из tokens
const newToken = () => crypto.randomBytes(32).toString('hex');

// last_seen_at обновляем не чаще раза в минуту: опрос ходит каждые 2.5 секунды,
// писать в базу на каждый запрос незачем
const TOUCH_INTERVAL = 60 * 1000;

function requireAuth(req, res, next) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  if (!match) return res.status(401).json({ error: 'no_token' });

  const row = store.userByToken(match[1]);
  if (!row) return res.status(401).json({ error: 'bad_token' });

  if (!row.last_seen_at || Date.now() - row.last_seen_at > TOUCH_INTERVAL) {
    store.touchToken(match[1]);
  }

  req.user = { id: row.id, name: row.name };
  req.token = match[1];
  next();
}

module.exports = { newToken, requireAuth };
