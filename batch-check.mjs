#!/usr/bin/env node
/**
 * batch-check.mjs — быстрая параллельная проверка MTProto прокси через один TDLib клиент
 */
import { createReadStream, writeFileSync, existsSync, readFileSync } from 'fs';
import { createInterface } from 'readline';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dir = dirname(fileURLToPath(import.meta.url));

// --- Args ---
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => a.slice(2).split('='))
);

const [inputArg, outputArg] = positional;
const CONCURRENCY = parseInt(flags.concurrency ?? '40');
const TIMEOUT_MS  = parseInt(flags.timeout ?? '15000');

if (!inputArg) {
  console.error('Usage: node batch-check.mjs <input-file|url|-> [output-file] [--concurrency=40] [--timeout=15000]');
  process.exit(1);
}

// --- Парсим прокси-ссылку ---
function parseProxy(raw) {
  try {
    const url = new URL(raw.replace(/^tg:\/\/proxy/, 'https://proxy').replace(/^https:\/\/t\.me\/proxy/, 'https://proxy'));
    const server = url.searchParams.get('server');
    const port   = parseInt(url.searchParams.get('port'));
    const secret = url.searchParams.get('secret');
    if (!server || !port || !secret) return null;

    // конвертируем secret в hex если base64
    let hexSecret = secret;
    if (!/^[0-9a-fA-F]+$/.test(secret)) {
      // base64 → hex
      hexSecret = Buffer.from(secret, 'base64').toString('hex');
    }
    return { raw, server, port, hexSecret };
  } catch { return null; }
}

// --- Читаем строки ---
async function readLines(src) {
  if (src === '-') {
    const rl = createInterface({ input: process.stdin, terminal: false });
    const lines = [];
    for await (const line of rl) if (line.trim()) lines.push(line.trim());
    return lines;
  }
  if (/^https?:\/\//.test(src)) {
    const text = await new Promise((res, rej) => {
      function get(url) {
        const mod = url.startsWith('https') ? https : http;
        mod.get(url, r => {
          if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return get(r.headers.location);
          let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
        }).on('error', rej);
      }
      get(src);
    });
    return text.split('\n').map(l => l.trim()).filter(Boolean);
  }
  const rl = createInterface({ input: createReadStream(resolve(process.cwd(), src)), terminal: false });
  const lines = [];
  for await (const line of rl) if (line.trim()) lines.push(line.trim());
  return lines;
}

// --- TDLib клиент ---
function createTdlClient() {
  const { getTdjson } = require('prebuilt-tdlib');
  const tdl = require('tdl');
  tdl.configure({ tdjson: getTdjson(), verbosityLevel: 0 });
  const client = tdl.createClient({
    apiId: 12345,
    apiHash: '0123456789abcdef0123456789abcdef',
    databaseDirectory: '/tmp/tdlib-batch',
    filesDirectory: '/tmp/tdlib-batch-files',
  });
  client.on('error', () => {});
  return client;
}

// --- Проверяем батч прокси через один клиент ---
async function checkAll(proxies, client) {
  const results = new Map(); // raw -> { ok, ms }
  let done = 0;
  const total = proxies.length;

  // Семафор для ограничения параллельных invoke
  let active = 0;
  const queue = [];
  function schedule(fn) {
    return new Promise((res, rej) => {
      queue.push({ fn, res, rej });
      drain();
    });
  }
  function drain() {
    while (active < CONCURRENCY && queue.length > 0) {
      const { fn, res, rej } = queue.shift();
      active++;
      fn().then(r => { active--; res(r); drain(); }).catch(e => { active--; rej(e); drain(); });
    }
  }

  await Promise.all(proxies.map(p => schedule(async () => {
    const start = Date.now();
    try {
      const added = await client.invoke({
        _: 'addProxy',
        server: p.server,
        port: p.port,
        enable: false,
        type: { _: 'proxyTypeMtproto', secret: p.hexSecret }
      });

      const ping = await Promise.race([
        client.invoke({ _: 'pingProxy', proxy_id: added.id }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS))
      ]);

      const ms = Math.round((ping.seconds ?? 0) * 1000) || (Date.now() - start);
      results.set(p.raw, { ok: true, ms });
      process.stderr.write(`  ✓ ${ms}ms ${p.server}\n`);
    } catch {
      results.set(p.raw, { ok: false });
    }

    done++;
    process.stderr.write(`\r  [${done}/${total}]`.padEnd(20));
  })));

  process.stderr.write('\n');
  return results;
}

// --- Main ---

// 1. Читаем существующий output
let existing = new Set();
if (outputArg && existsSync(outputArg)) {
  const saved = readFileSync(outputArg, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  existing = new Set(saved);
  process.stderr.write(`Существующий файл: ${existing.size} прокси\n`);
}

// 2. Загружаем новый список
const incoming = await readLines(inputArg);
process.stderr.write(`Новый список: ${incoming.length} прокси\n`);

// 3. Объединяем всё что нужно проверить (новые + существующие которых нет в новом)
const incomingSet = new Set(incoming);
const onlyInExisting = [...existing].filter(p => !incomingSet.has(p));
const allToCheck = [...incoming, ...onlyInExisting];

process.stderr.write(`Всего к проверке: ${allToCheck.length} (новых: ${incoming.length}, только в файле: ${onlyInExisting.length})\n\n`);

// 4. Парсим
const parsed = allToCheck.map(parseProxy).filter(Boolean);
const skipped = allToCheck.length - parsed.length;
if (skipped > 0) process.stderr.write(`Пропущено (не распарсились): ${skipped}\n`);

// 5. Создаём клиент и подключаемся
process.stderr.write(`Подключаюсь к TDLib...\n`);
const client = createTdlClient();
await client.connect();
process.stderr.write(`Подключено. Проверяю (параллельность: ${CONCURRENCY}, таймаут: ${TIMEOUT_MS}ms)...\n\n`);

// 6. Проверяем
const results = await checkAll(parsed, client);
client.close();

// 7. Фильтруем и сортируем
const alive = parsed
  .map(p => ({ ...p, ...results.get(p.raw) }))
  .filter(p => p.ok)
  .sort((a, b) => a.ms - b.ms);

process.stderr.write(`\n`);

if (alive.length === 0) {
  process.stderr.write('Живых прокси не найдено.\n');
  if (outputArg) writeFileSync(outputArg, '');
  process.exit(0);
}

const output = alive.map(p => p.raw).join('\n') + '\n';

if (outputArg) {
  writeFileSync(outputArg, output);
  process.stderr.write(`Сохранено ${alive.length} живых → ${outputArg}\n`);
} else {
  process.stdout.write(output);
}

process.stderr.write(`Итого: ${alive.length} живых из ${allToCheck.length}\n`);
