#!/usr/bin/env node
'use strict';

// Одноразовый код приглашения.
//   node bin/invite.js                → новый участник
//   node bin/invite.js --user 2       → ещё одно устройство для участника id 2
//   node bin/invite.js --user Маша    → то же самое, по имени
//   node bin/invite.js --ttl 2        → срок жизни 2 часа (по умолчанию 48)
//   node bin/invite.js --ttl 0        → без срока (не рекомендуется)

const crypto = require('crypto');
const store = require('../db');

// Без похожих символов: 0/O, 1/I/L — код диктуют голосом и вводят с телефона
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function block(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

function generate() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = 'KUZ-' + block(4) + '-' + block(4);
    if (!store.getInvite(code)) return code;
  }
  throw new Error('Не смог подобрать свободный код');
}

function resolveUser(value) {
  const byId = /^\d+$/.test(value) ? store.getUser(Number(value)) : null;
  const user = byId || store.findUserByName(value);
  if (!user) {
    console.error(`Нет такого участника: ${value}`);
    process.exit(1);
  }
  return user;
}

const DEFAULT_TTL_HOURS = 48;

function option(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1];
}

const args = process.argv.slice(2);

let user = null;
if (args.includes('--user')) {
  const value = option(args, '--user');
  if (!value) {
    console.error('Укажи, кому: --user <id|имя>');
    process.exit(1);
  }
  user = resolveUser(value);
}

let ttlHours = DEFAULT_TTL_HOURS;
if (args.includes('--ttl')) {
  const raw = Number(option(args, '--ttl'));
  if (!Number.isFinite(raw) || raw < 0) {
    console.error('--ttl <часы>, 0 — без срока');
    process.exit(1);
  }
  ttlHours = raw;
}

const expiresAt = ttlHours > 0 ? Date.now() + ttlHours * 3600 * 1000 : null;

const code = generate();
store.createInvite(code, user ? user.id : null, expiresAt);

console.log(code);
if (user) console.log(`(ещё одно устройство для «${user.name}», id ${user.id})`);
console.log(expiresAt
  ? `(действует до ${new Date(expiresAt).toLocaleString('ru-RU')})`
  : '(без срока действия)');
