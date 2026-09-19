# Resursplanering

Webbapplikation för projekt, uppdrag, aktiviteter, bemanning, beläggning, personliga planeringar, Gantt-scheman samt import och export.

Den rekommenderade egna driftsättningen använder Docker på en Debian- eller Ubuntu-server. Applikationen publiceras endast på serverns loopback-adress och nås via Tailscale Serve. Inga inkommande portar behöver öppnas i internetbrandväggen.

## Arkitektur

- Vinext/React för webbgränssnitt och API.
- Lokal Cloudflare Worker-körning via Wrangler/Miniflare.
- Lokal beständig SQLite/D1-databas i Docker-volymen `resursplanering-data`.
- Docker Compose för start, uppdatering och automatisk omstart.
- Tailscale Serve som privat HTTPS-proxy inom ditt tailnet.
- GitHub Actions bygger automatiskt en containerbild till GitHub Container Registry.

## Förutsättningar

- En Linuxserver med Debian eller Ubuntu och 64-bitars x86 eller ARM.
- Docker Engine med Docker Compose-plugin.
- Tailscale installerat på servern och på de datorer/mobiler som ska använda applikationen.
- Git för att klona och uppdatera källkoden.

Officiella instruktioner:

- [Installera Docker Engine](https://docs.docker.com/engine/install/)
- [Installera Tailscale på Linux](https://tailscale.com/download/linux)
- [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)

## Installation på servern

### 1. Klona projektet

```bash
sudo mkdir -p /opt/resursplanering
sudo chown "$USER":"$USER" /opt/resursplanering
git clone https://github.com/prinzhen/resursplanering.git /opt/resursplanering
cd /opt/resursplanering
```

### 2. Bygg och starta

```bash
docker compose up -d --build
docker compose ps
```

Applikationen binds medvetet endast till `127.0.0.1:3000` på servern. Den exponeras alltså inte på serverns LAN- eller internetadress.

Kontrollera vid behov loggen:

```bash
docker compose logs --tail=100 -f resursplanering
```

### 3. Anslut servern till Tailscale

```bash
sudo tailscale up
tailscale status
```

Följ inloggningslänken som visas första gången. Aktivera gärna MagicDNS i Tailscales administrationsgränssnitt.

### 4. Publicera tjänsten privat i ditt tailnet

```bash
sudo tailscale serve --bg http://127.0.0.1:3000
sudo tailscale serve status
```

Statuskommandot visar den privata HTTPS-adressen, normalt i formatet:

```text
https://servernamn.ditt-tailnet.ts.net
```

Adressen fungerar endast för användare och enheter som har åtkomst i ditt Tailscale-nät. Använd **inte** `tailscale funnel`; Funnel skulle göra tjänsten publik på internet.

## Flytta befintliga data

1. Öppna den befintliga applikationen.
2. Exportera **Hela databasen – säkerhetskopia**.
3. Starta den nya installationen på servern.
4. Importera JSON-säkerhetskopian i den nya installationen.
5. Kontrollera projekt, personer, aktiviteter och bemanning innan den gamla installationen tas ur bruk.

Data från den nuvarande molninstallationen följer inte automatiskt med GitHub-källkoden.

## Säkerhetskopiering

Applikationens databas ligger i Docker-volymen `resursplanering-data`. Gör både regelbundna JSON-exporter i applikationen och volymbaserade säkerhetskopior.

Skapa en komprimerad volymbackup:

```bash
cd /opt/resursplanering
mkdir -p backups
docker run --rm \
  -v resursplanering-data:/data:ro \
  -v "$PWD/backups:/backup" \
  alpine:3.22 \
  tar -czf /backup/resursplanering-data.tar.gz -C /data .
```

Återställning ska göras när applikationen är stoppad:

```bash
cd /opt/resursplanering
docker compose down
docker run --rm \
  -v resursplanering-data:/data \
  -v "$PWD/backups:/backup:ro" \
  alpine:3.22 \
  sh -c 'rm -rf /data/* && tar -xzf /backup/resursplanering-data.tar.gz -C /data'
docker compose up -d
```

Spara alltid en kopia av aktuell volym innan en återställning.

## Uppdatering

```bash
cd /opt/resursplanering
git pull --ff-only
docker compose up -d --build
docker image prune -f
```

Databasen ligger kvar i volymen. Eventuella nya databasmigreringar körs automatiskt innan applikationen startas.

## GitHub Container Registry

Workflow-filen `.github/workflows/container.yml` bygger projektet vid pull requests och publicerar bilder vid push till `main` eller en tagg som börjar med `v`.

Publicerad bild får normalt namnet:

```text
ghcr.io/prinzhen/resursplanering:latest
```

Repositoryts Actions-inställningar måste tillåta arbetsflöden att skriva paket. För privata containerbilder behöver servern logga in i GHCR med en GitHub-token som har `read:packages`.

## Driftkommandon

```bash
# Status
docker compose ps

# Loggar
docker compose logs --tail=100 resursplanering

# Omstart
docker compose restart resursplanering

# Stoppa
docker compose down

# Starta igen
docker compose up -d

# Kontrollera Tailscale-publiceringen
sudo tailscale serve status
```

## Säkerhetsprinciper

- Docker publicerar bara port 3000 på `127.0.0.1`.
- Tailscale hanterar privat åtkomst och HTTPS.
- Inga routerportar eller publika brandväggsregler behövs.
- Compose tar bort Linux capabilities från applikationscontainern och använder `no-new-privileges`.
- Ge bara betrodda användare åtkomst via Tailscales ACL/grants.
- Säkerhetskopiera innan uppdateringar och testa regelbundet att backupen går att återställa.

## Lokal utveckling

Kräver Node.js 22.13 eller senare och pnpm.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
DATA_DIR="$PWD/.wrangler/selfhost" HOST=127.0.0.1 PORT=3000 pnpm start:selfhosted
```

Öppna därefter `http://127.0.0.1:3000`.
