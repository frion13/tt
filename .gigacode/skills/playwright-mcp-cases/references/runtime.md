# Подключение к текущему проекту

Скилл работает в любом проекте. Сначала прочитай инструкции репозитория и найди его корень, package.json, конфигурацию Playwright и существующие тесты. Не используй абсолютные пути и имена папок из предыдущих сессий.

Скилл содержит исполняемые модули в `scripts/`, собственный `package.json`, шаблоны конфигурации и правил агента. Архив или публикация нашего runtime в npm не нужны. Для готовой интеграции установи локальную папку этого скилла в целевой проект; нужны Node.js 22+ и npm.

Определи абсолютный путь к каталогу прочитанного SKILL.md — он может находиться в проекте или в личном каталоге клиента. В командах ниже замени `/absolute/path/to/skill` именно этим путём. Выполняй команды из корня целевого проекта:

```bash
npm install --save-dev --install-links /absolute/path/to/skill @playwright/test
```

Путь с пробелами заключай в кавычки. `--install-links` устанавливает копию локального пакета в node_modules: импорты runner и reporter разрешаются через зависимости целевого проекта даже для скилла из личного каталога. Если @playwright/test уже установлен в совместимой версии, убери его из команды, сохрани существующую версию и lock-файл. Если package.json отсутствует, сначала создай его через `npm init -y`. Не устанавливай один и тот же runtime из обоих скиллов: они содержат одинаковый пакет `playwright-qa-skills`. После обновления скилла повтори установку из его папки.

Затем:

```bash
npx --no-install playwright-qa init
npx --no-install playwright install chromium
npx --no-install playwright-qa plan test-cases/ID.md
npx --no-install playwright-qa register test-cases/ID.md e2e/ID.spec.mjs
npx --no-install playwright-qa run test-cases/ID.md
```

`init` сохраняет существующие файлы и конфигурацию. В поставке из одного скилла он создаёт конфигурации и правила агента, но не копирует отсутствующие соседние скиллы. MCP подключи отдельно в клиенте с аргументом `--ignore-https-errors`; официальный playwright-cli установи отдельно, если он нужен для исследования UI. Если Playwright уже настроен, добавь reporter `playwright-qa-skills/reporter` в существующий список, сохранив остальные reporters/projects/fixtures, и `use.ignoreHTTPSErrors: true`. Новые spec используют `import {caseTest, expect} from 'playwright-qa-skills/test'`; доступ к источникам — `playwright-qa-skills/access`. В проект не нужно копировать папку runtime.

Кейс хранится в Markdown с одним JSON-блоком `ttt-case` (это идентификатор формата, не название папки). Поля: id, title, state ready/draft, profile, data (env-привязки), steps с id/action/expected. Пример:

```ttt-case
{"id":"TC-1","title":"Вход","state":"ready","profile":"stage-editor","steps":[{"id":1,"action":"Открыть вход","expected":"Форма видима"}]}
```

`plan` выдаёт create/update/run/blocked по реестру и SHA256 Markdown. Для create исследуй UI и напиши spec, для update сопоставь изменения с кодом, для run используй существующий. Не перерегистрируй изменённый кейс без проверки соответствия. В spec каждый шаг выполняй через `await step(id, async () => { ...assertions; return фактическое_наблюдение; })`.

Данные текущего проекта: config/profiles.json, config/sources.json, config/registry.json, локальный .env/окружение CI. Профили, креды и кейсы из пакета-разработки не переносятся. Jira/Wiki описываются отдельно; `playwright-qa source jira <URL>` только проверяет профиль/адрес, без печати пароля. Форму авторизации исследует агент. Ошибки TLS игнорируются для всех сайтов в тестовых браузерах.

Для MCP-журнала: `playwright-qa report evidence/journal.json`. Для классификации бага: `playwright-qa bug reports/automation/<run-id>/summary.json evidence/assessment.json`. Выполняй через `npx --no-install` либо локальный npm script проекта. Результаты сохраняются внутри целевого проекта в reports/. Его имя произвольно. Для запуска из другой папки передай `--project /path/to/project`; все относительные пути тогда считаются от этого корня.

Коды run: 0 — успешный runner (отдельно проверь flaky), 1 — падение, 2 — блокер, 3 — нужна работа над кейсом/spec. Подробный формат журнала и assessment описан в [runtime-api.md](runtime-api.md), который входит в этот скилл. Сохранение файлов/регистрация не означает успешный прогон. Маски скриншотов дополняй для интерфейса; cleanup бизнес-данных выполняй в fixtures/finally.

Для команд без Playwright Test (init/plan/register/source/report/bug) можно вызвать встроенный код напрямую: `node /absolute/path/to/skill/scripts/cli.mjs --project /absolute/path/to/project <command> <args>`. Для автотестов используй установку выше: spec и reporter импортируют пакет из node_modules проекта.
