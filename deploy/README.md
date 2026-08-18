# Déploiement EC2 (PM2)

Prod actuelle : Ubuntu, user `ubuntu`, app dans `/home/ubuntu/apps/trading-bot`.
Superviseurs : **PM2 uniquement**. Pas de units systemd applicatives.

Deux process, même `cwd` : `trading-bot` (écrit `data/heartbeat.json`) et `trading-watchdog` (le lit). Un `cwd` différent = le watchdog surveille un fichier que personne n'écrit.

## Première mise en service (déjà faite)

```bash
cd /home/ubuntu/apps/trading-bot
npm ci
npx tsc --noEmit
mkdir -p data logs
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # une fois, suit les instructions affichées
```

Ne rejoue `pm2 startup` que si le daemon n'est plus enregistré au boot.

## Déploiement d'un nouveau code (bot déjà en cours)

Ne pas `pm2 kill`. Ça tue le daemon, pas seulement l'app.

Ne pas `pm2 restart trading-bot` tout seul. Ça relance l'existant **sans** enregistrer `trading-watchdog`, et **sans** relire `max_restarts` / `kill_timeout`.

```bash
cd /home/ubuntu/apps/trading-bot
# déployer le code, puis :
npm ci
npx tsc --noEmit
pm2 startOrRestart ecosystem.config.js
pm2 save
pm2 status
```

`startOrRestart` :

| Process | Effet |
|---------|--------|
| `trading-bot` déjà listé | restart (quelques secondes d'arrêt, SIGTERM → graceful shutdown) |
| `trading-watchdog` absent | start |
| les deux déjà listés | restart des deux, config relue |

`pm2 save` est obligatoire : sans ça, un reboot ressuscite l'ancienne liste (bot seul).

## Vérification

```bash
pm2 status
cat data/heartbeat.json
pm2 logs trading-watchdog --lines 50
```

Le heartbeat doit apparaître en moins d'une seconde après le start du bot. Les digests Telegram 09h35 / 16h10 EST rendent le silence vérifiable.

## Fuseau horaire

Laisser l'instance en **UTC**. Le bot raisonne en `America/New_York` via `toESTDate`. Une instance en heure Europe ajoute un second décalage, désynchronisé du DST US.

## Reste à faire (hors lot)

- Alarme CloudWatch `missing data = breaching` — seule couverture de la panne d'instance (bot + watchdog + PM2 meurent ensemble).
- Secrets SSM plutôt qu'un `.env` sur disque.
- Persistance de `data/journal.json` hors du disque d'instance (EBS dédié ou sync S3).
- Build compilé (`tsc` puis `node dist/index.js`) : `tsx` retire les types sans les vérifier.
