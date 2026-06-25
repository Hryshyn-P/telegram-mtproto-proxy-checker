node batch-check.mjs https://raw.githubusercontent.com/SoliSpirit/mtproto/master/all_proxies.txt alive.txt

Или

echo 'alias mtproto-check="node /Users/pavlohryshyn/dev/telegram-mtproto-proxy-checker/batch-check.mjs https://raw.githubusercontent.com/SoliSpirit/mtproto/master/all_proxies.txt ~/Desktop/alive_proxies.txt"' >> ~/.zshrc && source ~/.zshrc

Тогда достаточно просто:
bashmtproto-check

--------


# Batch Proxy Checker

Проверяет список MTProto-прокси параллельно, отдаёт живые отсортированные по скорости.

## Быстрый старт

```bash
node batch-check.mjs input.txt output.txt
```

## Установка скрипта

Скопируй `batch-check.mjs` в корень проекта (он уже там лежит).

## Формат входного файла

Один прокси-линк на строку, пустые строки игнорируются:

```
https://t.me/proxy?server=example.com&port=443&secret=abc123
tg://proxy?server=1.2.3.4&port=8443&secret=xyz
```

## Использование

### Из локального файла → файл

```bash
node batch-check.mjs proxies.txt alive.txt
```

### Из URL → файл

```bash
node batch-check.mjs https://raw.githubusercontent.com/SoliSpirit/mtproto/refs/heads/master/all_proxies.txt alive.txt
```

### Из stdin → файл

```bash
cat proxies.txt | node batch-check.mjs - alive.txt
```

### Только вывод в терминал (без сохранения)

```bash
node batch-check.mjs proxies.txt
```

## Параметры

| Флаг | По умолчанию | Описание |
|------|-------------|----------|
| `--concurrency=N` | `15` | Сколько проксей проверять одновременно |
| `--timeout=N` | `30000` | Таймаут на одну проксю (мс) |

```bash
node batch-check.mjs proxies.txt alive.txt --concurrency=20 --timeout=20000
```

## Формат выходного файла

Одна живая прокси на строку, сортировка от быстрых к медленным:

```
https://t.me/proxy?server=sv2.just-money.co.uk&port=443&secret=...
https://t.me/proxy?server=moon.talebi.co.uk&port=443&secret=...
```

## Патч index.js

> **Важно:** В оригинальном `index.js` есть баг — `new TDLib()` не передаёт путь к dylib.
> Строка 186 уже исправлена:
> ```js
> // было:
> const tdlib = new TDLib();
> // стало:
> const tdlib = new TDLib(tdlibPath || undefined);
> ```
> Без этого патча все проверки возвращают `NO` на macOS с prebuilt-tdlib.
