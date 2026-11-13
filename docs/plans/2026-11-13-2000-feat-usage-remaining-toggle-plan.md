---
title: Галочка «показывать остаток» на кнопках лимитов - Plan
type: feat
date: 2026-11-13
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Галочка «показывать остаток» на кнопках лимитов - Plan

## Goal Capsule

- **Objective:** владелец видит на кнопках лимитов, сколько квоты осталось, а не сколько израсходовано, если так выбрал.
- **Means:** галочка «Show remaining» в настройках кнопок «Usage Limit» и «Usage Overview» переворачивает число и заполнение (KTD1).
- **Authority:** явные решения пользователя > `AGENTS.md`, `CONTRIBUTING.md` > этот план.
- **Execution profile:** локальные коммиты в `main`, по коммиту на пункт. Без push и релиза.
- **Stop conditions:** вернуть вопрос владельцу, если галочка потребовала бы менять источники лимитов или отрисовку кнопок агентов.
- **Finish and ship:** `ce-work` доводит работу до локальных коммитов, приёмки и установки в живой плагин без кликов.

---

## Product Contract

### Problem Frame

Кнопки лимитов показывают израсходованный процент: например, 19% у Claude. Владельцу удобнее видеть остаток, то есть 81%.

### Key Decisions

- **Галочка своя у каждой кнопки, по умолчанию выключена.** Governs R1, R3. (session-settled: user-approved)
- **Переворачиваются и число, и заполнение кольца или полосок.** Цвет по-прежнему считается от остатка: при остатке не больше 20% красный. Governs R2. (session-settled: user-directed — выбрано вместо переворота только числа: число и картинка не противоречат друг другу)

### Requirements

- R1. В настройках «Usage Limit» и «Usage Overview» есть галочка «Show remaining», она сохраняется в настройках этой кнопки.
- R2. С включённой галочкой кнопка показывает остаток: число равно `remainingPercent`, кольцо или полоска заполнены на остаток. У «Usage Overview» переворачиваются обе полоски. Прочерк при отсутствии данных и цвета не меняются.
- R3. Кнопки без сохранённой галочки показывают расход, как раньше.

### Scope Boundaries

- Источники, окна, логотипы и кнопка кредитов сброса не меняются.
- Подпись окна (`5H`, `WK`) не меняется. Отдельного обозначения «остаток» на кнопке нет.

## Planning Contract

### Key Technical Decisions

- **KTD1. Настройка `showRemaining: boolean`** в `UsageKeySettings` (`src/usage/usage.ts`). `parseUsageSettings` принимает только `true`, всё остальное считает `false`. Контроллер передаёт флаг в `renderUsageLimitKey` и `renderUsageOverviewKey` (`src/stream-deck/render.ts`). Там вместо `used` берётся показываемое значение: остаток или расход. `usageSignal` по-прежнему получает остаток.
- **KTD2. Сохранение настроек как у соседних полей.** В инспекторах галочка отправляет `setSettings` с `context = uuid`, как уже делают список источника и окна (`77463ca`). Перерисовка при смене настроек использует существующий путь `onDidReceiveSettings`.

## Implementation Units

### U1. Флаг и отрисовка

- **Goal:** R2, R3.
- **Files:** `src/usage/usage.ts`, `src/stream-deck/render.ts`, `src/stream-deck/controller.ts`; тесты: `test/usage.test.ts`, при необходимости `test/controller.test.ts`.
- **Test scenarios:**
  - `parseUsageSettings` даёт `showRemaining: false` без поля и при значении не `true`; `true` при `true`;
  - при расходе 19% и выключенном флаге «Usage Limit» показывает `19`, с флагом — `81`, а заполнение кольца соответствует показанному числу;
  - «Usage Overview» с флагом показывает `81%` и ширину полоски на 81% в обеих полосках;
  - цвет при остатке 15% красный и с флагом, и без;
  - без данных прочерк с флагом и без;
  - контроллер передаёт флаг из настроек кнопки до отрисовки.
- **Verification:** `npm test`, `npm run check`, `npm run lint`, `npm run check:boundaries`.

### U2. Галочка в инспекторах и документация

- **Goal:** R1.
- **Files:** `static/property-inspector/usage-limit.html`, `static/property-inspector/usage-overview.html`, `test/usage-settings.test.ts`, `README.md`, `README.ru.md`.
- **Test scenarios:**
  - галочка отражает сохранённое `showRemaining`;
  - переключение отправляет `setSettings` с контекстом инспектора, `showRemaining` и сохранением остальных полей;
  - отсутствие поля показывает снятую галочку и не записывает настройки само по себе.
- **Verification:** `npx tsx --test test/usage-settings.test.ts`, `npx tsx --test test/release-docs.test.ts`, `npm test`.

## Verification Contract

| Строка | Команда | Тип |
|---|---|---|
| Приёмка этапа | `npm run acceptance`, JSON-отчёт из `scripts/stage-acceptance.mjs` на чистом дереве | blocking |
| Живая установка и отрисовка кнопок без ошибок в журнале плагина | сборка в живой плагин, `npx streamdeck restart com.xonika9.codex-deck` | hardening |

## Definition of Done

- Все строки `blocking` прошли. Коммиты U1 и U2 есть в `main`.
- Владельцу сообщено: автоматическая проверка, живое приложение и физическое устройство отдельно.
