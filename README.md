# Telegram AI Bot (Telegram Serverless + NVIDIA Nemotron 3.5 Super VL)

Телеграм-бот, развёрнутый на **Telegram Serverless** (https://core.telegram.org/bots/serverless) — код läuft прямо на инфраструктуре Telegram, без своих серверов. Ответы даёт нейросетевая модель **NVIDIA Nemotron 3.5 Super VL 120B** (https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b/apireference).

## Что умеет бот

- Отвечает на текстовые сообщения через модель NVIDIA Nemotron 3.5 Super VL 120B
- Смотрит на фото (vision) и отвечает на вопросы о них — пришлите фото с подписью
- Команды: `/start`, `/help`, `/stats`, `/reset`
- Хранит статистику пользователей и сообщений в встроенной базе данных Telegram (SQLite)
- Длинные ответы автоматически разбиваются на части (лимит Telegram 4096 символов)

## Структура проекта

```
tgcloud-nemotron-bot/
├── README.md                   # эта инструкция
├── package.json                # скрипты и dev-зависимость CLI
├── tgcloud.jsonc               # конфигурация проекта
├── AGENTS.md                   # подсказки для ИИ-ассистентов
├── .tgcloud.env.example        # пример переменных окружения (копируйте в .tgcloud/env)
├── .gitignore                  # игнорируемые файлы Git
├── tgcloud/                    # всё, что разворачивается в облаке Telegram
│   ├── schema.js               # схема базы данных (users, messages)
│   ├── handlers/
│   │   └── message.js          # обработчик входящих сообщений
│   └── lib/
│       └── nemotron.js         # клиент модели NVIDIA Nemotron (текст + фото)
└── .tgcloud/                   # локальное состояние CLI (не коммитить)
```

---

## Как развернуть проект

### 1. Подготовка

Убедитесь, что установлен **Node.js 18+**.

```bash
cd tgcloud-nemotron-bot
npm install
```

### 2. Создайте бота и включите Serverless

1. Напишите [@BotFather](https://t.me/BotFather) и создайте бота командой `/newbot`.
2. В @BotFather откройте своего бота → **Serverless** → включите Serverless.
3. Там же получите **CLI Access Token** (формата `app<id>:<secret>`) — он понадобится для `tgcloud login`.

### 3. Подключите проект к боту

```bash
npx tgcloud login
```

Введите CLI Access Token из BotFather. CLI сохранит его в `.tgcloud/` (эта папка игнорируется Git).

### 4. Укажите ключ модели NVIDIA Nemotron

> **Где указать ключ от модели?**  
> Ключ API NVIDIA Nemotron (`NVIDIA_API_KEY`, начинается с `nvapi-`) указывается в файле **`.tgcloud/env`** в корне проекта. Скопируйте пример и впишите свой ключ:

```bash
cp .tgcloud.env.example .tgcloud/env
```

Отредактируйте `.tgcloud/env`:

```
NVIDIA_API_KEY=nvapi-ваш_ключ_здесь
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_MODEL=nvidia/nemotron-3.5-super-vl-120b-a12b
```

Файл `.tgcloud/env` уже добавлен в `.gitignore` — он никогда не попадёт в репозиторий.

Ключ можно получить на https://build.nvidia.com/ (раздел API Keys).

> Также можно задать переменную через системное окружение перед командами:
> ```bash
> export NVIDIA_API_KEY="nvapi-ваш_ключ"
> npx tgcloud push
> ```

### 5. Разверните бота

```bash
npx tgcloud push       # загрузить модули в облако Telegram
```

Бот уже жив: напишите ему в Telegram — обработчик ответит.

### 6. Примените базу данных (опционально, но рекомендуется)

Если вы хотите, чтобы бот remembers статистику (`/stats`, `/reset`), примените схему:

```bash
npx tgcloud migrate    # создать таблицы users и messages
```

### 7. Проверьте

```bash
npx tgcloud status     # увидеть, что развернуто
npx tgcloud diff       # увидеть отличия локальной копии от облака
```

---

## Разработка локально

Протестировать обработчик без деплоя:

```bash
# Текстовое сообщение
npx tgcloud run handlers/message '{ chat: { id: 123 }, text: "Привет!", from: { id: 1, first_name: "Иван" } }'

# Команда /stats
npx tgcloud run handlers/message '{ chat: { id: 123 }, text: "/stats", from: { id: 1, first_name: "Иван" } }'
```

Посмотреть изменения перед деплоем:

```bash
npx tgcloud status
npx tgcloud diff
```

Применить изменения в облаке:

```bash
npx tgcloud push
```

Откатить локальные изменения:

```bash
npx tgcloud reset
```

---

## Переменные окружения

| Переменная | Обязательная | Описание |
|------------|--------------|----------|
| `NVIDIA_API_KEY` | Да | Ключ API NVIDIA Build (начинается с `nvapi-`). Указать в `.tgcloud/env` |
| `NVIDIA_BASE_URL` | Нет | Базовый URL API (по умолчанию `https://integrate.api.nvidia.com/v1`) |
| `NVIDIA_MODEL` | Нет | Имя модели (по умолчанию `nvidia/nemotron-3.5-super-vl-120b-a12b`) |

---

## Безопасность

- Никогда не коммитьте `.tgcloud/env` и `.tgcloud/` в Git.
- Ключ `NVIDIA_API_KEY` храните в секретном менеджере при продакшене.
- В коде ключ используется только в заголовке `Authorization: Bearer <ключ>` при вызове NVIDIA API.