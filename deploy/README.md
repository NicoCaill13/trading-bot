# Déploiement EC2

Deux units systemd indépendantes : le bot, et le watchdog qui le surveille.

## Pourquoi systemd et pas pm2

- `Restart=always` avec `StartLimitIntervalSec=0` supprime la falaise de redémarrages. La configuration pm2 précédente (`max_restarts: 5`) abandonnait après cinq crashs **et n'en notifiait personne** — c'est le mode de défaillance que ce déploiement existe pour éliminer.
- Le démarrage au boot est garanti par `WantedBy=multi-user.target`, sans avoir à superviser un `pm2 resurrect`.
- Une couche de process en moins entre systemd et le bot, donc une propagation de `SIGTERM` fiable — indispensable pour que `gracefulShutdown` persiste l'état de session.

## Prérequis sur l'instance

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin trading
sudo mkdir -p /opt/trading-bot
sudo chown -R trading:trading /opt/trading-bot
```

Déployer le code dans `/opt/trading-bot`, puis :

```bash
cd /opt/trading-bot
sudo -u trading npm ci
sudo -u trading npx tsc --noEmit   # aucune erreur de type ne doit atteindre le marché
sudo -u trading cp .env.example .env  # puis renseigner les clés
sudo -u trading mkdir -p data logs
```

## Installation des units

```bash
sudo cp deploy/systemd/trading-bot.service /etc/systemd/system/
sudo cp deploy/systemd/trading-watchdog.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now trading-watchdog.service
sudo systemctl enable --now trading-bot.service
```

Démarrer le **watchdog d'abord** : il dispose d'une fenêtre de grâce (`WATCHDOG_STARTUP_GRACE_MS`, 120 s par défaut) pendant laquelle un heartbeat absent n'est pas signalé, ce qui couvre le boot du bot.

## Vérification

```bash
systemctl status trading-bot trading-watchdog
cat /opt/trading-bot/data/heartbeat.json      # doit apparaître en moins d'une seconde
journalctl -u trading-watchdog -f
```

Un heartbeat frais et un journal watchdog silencieux valent confirmation. Les digests de 09h35 et 16h10 EST arrivent sur Telegram et rendent ce silence vérifiable.

## Piège à connaître

`WorkingDirectory` doit être **identique** dans les deux units. Tous les chemins du code (`./data`, `./logs`, `./.env`) sont relatifs au répertoire courant : lancés depuis des répertoires différents, les deux process pointeraient sur des fichiers heartbeat distincts et le watchdog surveillerait un fichier que personne n'écrit.

## Fuseau horaire

Laisser l'instance en **UTC**. Tout le raisonnement horaire du bot passe par `America/New_York` via `toESTDate`, y compris les transitions DST. Une instance en heure locale européenne rajouterait un second décalage, désynchronisé du DST américain deux semaines par an.

## Reste à faire (hors lot)

- Alarme CloudWatch sur métrique custom en `missing data = breaching` — seule couverture de la panne au niveau instance, où bot et watchdog meurent ensemble.
- Secrets via SSM Parameter Store plutôt qu'un `.env` sur disque.
- Persistance de `data/journal.json` hors du disque d'instance (EBS dédié ou sync S3).
- Build compilé (`tsc` puis `node dist/index.js`) : `tsx` retire les types sans les vérifier, donc `strict: true` n'est jamais appliqué au runtime.
