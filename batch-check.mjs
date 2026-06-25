#!/usr/bin/env node
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createReadStream, writeFileSync, existsSync, readFileSync } from 'fs';
import { createInterface } from 'readline';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const execFileAsync = promisify(execFile);
const __dir = dirname(fileURLToPath(import.meta.url));
const CHECKER = resolve(__dir, 'index.js');

// --- Args ---
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => a.slice(2).split('='))
);

const [inputArg, outputArg] = positional;
const CONCURRENCY = parseInt(flags.concurrency ?? '15');
const TIMEOUT_MS  = parseInt(flags.timeout ?? '30000');

if (!inputArg) {
  console.error('Usage: node batch-check.mjs <input-file|url|-> [output-file] [--concurrency=15] [--timeout=30000]');
  process.exit(1);
}

// --- Read lines from file/url/stdin ---
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

// --- Check one proxy ---
async function checkProxy(proxy) {
  const start = Date.now();
  try {
    const { stdout } = await execFileAsync('node', [CHECKER, proxy], { timeout: TIMEOUT_MS });
    if (stdout.trim() === 'OK') return { proxy, ms: Date.now() - start, ok: true };
  } catch {}
  return { proxy, ok: false };
}

// --- Concurrency pool ---
async function pool(items, fn, concurrency, label) {
  const results = [];
  let i = 0, done = 0;
  const total = items.length;
  async function worker() {
    while (i < items.length) {
      const item = items[i++];
      const r = await fn(item);
      results.push(r);
      done++;
      const suffix = r.ok ? `  ✓ ${r.ms}ms ${r.proxy}` : '';
      process.stderr.write(`\r  [${label}] ${done}/${total}${suffix.padEnd(60)}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  process.stderr.write('\n');
  return results;
}

// --- Main ---

// 1. Читаем существующий output файл
let existing = new Set();
if (outputArg && existsSync(outputArg)) {
  const saved = readFileSync(outputArg, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  existing = new Set(saved);
  process.stderr.write(`Существующий файл: ${existing.size} прокси\n`);
}

// 2. Загружаем новый список
const incoming = await readLines(inputArg);
process.stderr.write(`Новый список: ${incoming.length} прокси\n\n`);

// 3. Перепроверяем существующие (которых нет в новом списке — могли протухнуть)
const incomingSet = new Set(incoming);
const toRecheck = [...existing].filter(p => !incomingSet.has(p));

let stillAlive = new Set();
if (toRecheck.length > 0) {
  process.stderr.write(`Перепроверка существующих (не в новом списке): ${toRecheck.length}\n`);
  const recheckResults = await pool(toRecheck, checkProxy, CONCURRENCY, 'recheck');
  for (const r of recheckResults) {
    if (r.ok) stillAlive.add(r.proxy);
  }
  const dead = toRecheck.length - stillAlive.size;
  process.stderr.write(`  живые: ${stillAlive.size}, протухли: ${dead}\n\n`);
}

// Существующие которые есть и в новом списке — проверим вместе с новыми
// чтобы обновить время отклика; не добавляем их отдельно

// 4. Из нового списка фильтруем только те которых ещё нет среди живых
const toCheck = incoming.filter(p => !stillAlive.has(p));
process.stderr.write(`Проверка новых/обновлённых: ${toCheck.length}\n`);
const newResults = await pool(toCheck, checkProxy, CONCURRENCY, 'check');

// 5. Объединяем: живые из recheck (без времени) + живые из нового списка (с временем)
const freshAlive = newResults.filter(r => r.ok);

// Для stillAlive у нас нет нового времени — ставим Infinity чтобы шли в конец
const merged = [
  ...freshAlive,
  ...[...stillAlive].map(proxy => ({ proxy, ms: Infinity, ok: true }))
].sort((a, b) => a.ms - b.ms);

// Убираем дубли (на случай пересечений)
const seen = new Set();
const deduped = merged.filter(r => {
  if (seen.has(r.proxy)) return false;
  seen.add(r.proxy);
  return true;
});

process.stderr.write('\n');

if (deduped.length === 0) {
  process.stderr.write('Живых прокси не найдено.\n');
  if (outputArg) writeFileSync(outputArg, '');
  process.exit(0);
}

const output = deduped.map(r => r.proxy).join('\n') + '\n';

if (outputArg) {
  writeFileSync(outputArg, output);
  process.stderr.write(`Сохранено ${deduped.length} живых → ${outputArg}\n`);
} else {
  process.stdout.write(output);
}

const totalChecked = toRecheck.length + toCheck.length;
process.stderr.write(`Итого: ${deduped.length} живых | проверено: ${totalChecked} | новых источников: ${incoming.length}\n`);
