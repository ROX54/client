# CyberGarden AI Client

Статический frontend Dashboard с редактором workflow, просмотром запусков, находок, отчётов, AI-анализа и статуса webhook. Сборка и npm не требуются.

## Запуск

Склонируйте [client](https://github.com/ROX54/client) и [server](https://github.com/ROX54/server) рядом. Запустите `START-DASHBOARD.bat` или `./START-DASHBOARD.sh` из каталога `server` и откройте [127.0.0.1:8765](http://127.0.0.1:8765). Для отдельного расположения клиента задайте `CYBERGARDEN_CLIENT_DIR` на сервере.

Клиент отправляет относительные запросы на `/api/` и `/reports/`. При раздельном размещении настройте обратный прокси того же origin для этих путей на Python backend. Страница открывается через HTTP вместе с подключённым API. Настройки провайдеров и ключи хранятся на стороне сервера.
