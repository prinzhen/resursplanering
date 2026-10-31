# Resursplanering

Webbapplikation för projekt, uppdrag, aktiviteter, bemanning, beläggning, personliga planeringar, Gantt-scheman samt import och export.

Den rekommenderade egna driftsättningen på Ubuntu 24.04 använder Node.js och en systemd-tjänst, helt utan Docker. Applikationen ligger på serverns loopback-adress, skyddas med Nginx Basic Authentication och publiceras med HTTPS via Tailscale Funnel. Inga inkommande portar behöver öppnas i internetbrandväggen.

## Snabbinstallation på Ubuntu 24.04

Kör följande kommando på servern:

```bash
curl -fsSL https://raw.githubusercontent.com/prinzhen/resursplanering/main/installera.sh | sudo bash
```

Installationsskriptet installerar Node.js, pnpm, Nginx och Tailscale, hämtar och bygger applikationen samt skapar systemd-tjänsterna. Första gången får du välja användarnamn och ett lösenord på minst 14 tecken. Endast lösenordets bcrypt-hash sparas. När Tailscale visar en inloggningslänk öppnar du den och godkänner servern.

Tailscale Funnel gör adressen publik på internet, men alla sidor och API-anrop skyddas av Nginx-inloggningen. Använd ett unikt och långt lösenord.

Applikationsdata sparas i `/var/lib/resursplanering/data` och påverkas inte när installationsskriptet körs igen.

```bash
# Status
sudo systemctl status resursplanering

# Logg
sudo journalctl -u resursplanering -f

# Byt lösenord för ett befintligt användarnamn
sudo htpasswd /etc/nginx/resursplanering.htpasswd DITT_ANVÄNDARNAMN

# Uppdatera till senaste versionen
curl -fsSL https://raw.githubusercontent.com/prinzhen/resursplanering/main/installera.sh | sudo bash
```

Docker-instruktionerna längre ned finns kvar som ett alternativ för miljöer där Docker redan fungerar.

## Arkitektur

- Vinext/React för webbgränssnitt och API.
- Lokal Cloudflare Worker-körning via Wrangler/Miniflare.
- Lokal beständig SQLite/D1-databas i `/var/lib/resursplanering/data`.
- systemd för start, övervakning och automatisk omstart.
- Nginx Basic Authentication på `127.0.0.1:3001`.
- Tailscale Funnel som publik HTTPS-proxy till Nginx.
- GitHub Actions bygger automatiskt en containerbild till GitHub Container Registry.

## Administratörer och medarbetarkonton (TEAM-test på port 3200)

**En administratör kan också vara medarbetare, gruppchef, projektledare och TEAM-leader.**
Kontot i `user_accounts` innehåller inloggning och behörigheter medan posten i
`employees` innehåller arbetstid, projektmedverkan och aktivitetsbemanning.
Koppla kontot till **den befintliga medarbetaren** för att behålla aktiviteter,
historik och organisatoriska relationer. Skapa inte en extra Tobias-post och
radera inte den befintliga personposten för att få administratörsbehörighet.

I **Konton och behörigheter**:

1. Under **Registrerade konton**: välj befintlig medarbetare vid administratörens
   e-postkonto och tryck **Koppla**. Kontot och personen blir en och samma
   användaridentitet, utan att aktiviteter eller beläggning flyttas/raderas.
2. **Ge adminbehörighet** kan användas för flera separata konton. Konton med
   adminbehörighet kan fortfarande ha egna aktiviteter och projekt.
3. **Ta bort adminbehörighet**, **Inaktivera** och **Ta bort konto** kan inte
   slå ut den **sista aktiva administratören**. Det egna inloggade kontot kan
   inte raderas eller inaktiveras via dessa knappar. **Ta bort konto** raderar
   endast inloggningen, inte medarbetaren eller planeringen. Om kontot\n   förekommer i revisionshistorik arkiveras det i stället (inaktiveras och\n   får sina behörigheter borttagna) för att behålla referenserna.
4. En medarbetare med kopplat konto skyddas från radering. Lossa/radera först
   kontokopplingen om du verkligen avser att radera medarbetarposten och dess
   historik (medarbetarradering tar bort personens bemanning).

### Skapa eller återställ administratör från Linux-konsolen

Det befintliga CLI-verktyget `scripts/provision-account.py` kan skapa en ny
administratör, återaktivera en spärrad administratör, återställa lösenordet
och koppla ett admin-konto till en befintlig medarbetare. **Det kräver inte
att någon annan administratör fortfarande kan logga in.** För säker
SQLite-hantering ska tjänsten vara **stoppad** och databasen
**säkerhetskopierad** innan du använder verktyget.

För isolerade TEAM-testet på port 3200 (inte produktionsinstansen på 3100):

```bash
sudo systemctl stop resursplanering-test-access
sudo install -d -m 700 /var/backups/resursplanering-test-access
sudo tar -C /var/lib/resursplanering-test-access -czf \
  "/var/backups/resursplanering-test-access/before-admin-$(date +%Y%m%d-%H%M%S).tar.gz" data config

# Använd en riktig, befintlig medarbetares e-postadress i båda argumenten.
# Lösenordet frågas efter utan att visas och hamnar inte i shell-historiken.
sudo -u prinzhen python3 /opt/resursplanering-test-access/scripts/provision-account.py \
  --data-dir /var/lib/resursplanering-test-access/data \
  --email "DIN_EPOST@EXEMPEL.SE" \
  --employee-email "DIN_EPOST@EXEMPEL.SE" --admin

sudo systemctl start resursplanering-test-access
sudo systemctl status resursplanering-test-access --no-pager
```

För en **separat reservadministratör** kan du välja en ny e-postadress
och utelämna `--employee-email` om personen ännu inte finns som medarbetare.
Om kontots e-postadress matchar en befintlig medarbetare kopplas personen
automatiskt. På befintliga konton bevaras medarbetarkopplingen vid en
lösenordsåterställning. Ett annat konto som redan är kopplat till samma
medarbetare ger ett tydligt fel i stället för att automatiskt slå ihop
olika identiteter.

För andra instanser: kontrollera **rätt tjänst, köranvändare och DATA_DIR**
med `systemctl cat TJÄNSTNAMN`. Byt ut alla sökvägar och tjänstnamn
ovan; kör aldrig testkommandona mot produktionsdatabasen av misstag.
Om administratörsåterställningen misslyckas: läs felmeddelandet och starta
tjänsten manuellt igen. Verktyget använder PBKDF2-SHA256 och lagrar
inte lösenordet i klartext.

## Alternativ installation med Docker

Följande avsnitt beskriver den äldre Docker-baserade installationen.

### Förutsättningar

- En Linuxserver med Debian eller Ubuntu och 64-bitars x86 eller ARM.
- Docker Engine med Docker Compose-plugin.
- Tailscale installerat på servern och på de datorer/mobiler som ska använda applikationen.
- Git för att klona och uppdatera källkoden.

Officiella instruktioner:

- [Installera Docker Engine](https://docs.docker.com/engine/install/)
- [Installera Tailscale på Linux](https://tailscale.com/download/linux)
- [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)

### Installation på servern

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

## Separat arbetsinloggning när administratören inte kan skapa aktiviteter

I **Konton och behörigheter** kan en administratör välja
**Skapa separat arbetskonto – behåll administratören**.

Välj den *befintliga* medarbetaren (exempelvis Tobias Hillbom), ange en
**ny och unik inloggningsadress** samt ett lösenord med minst 12 tecken.
Markera **minst ett projekt** där personen ska kunna utföra arbete.
Du kan samtidigt utse personen till projektledare för de valda projekten.
Välj gruppchefsbehörighet om personen ska hantera underställda.

Denna funktion kör en atomär transaktion: ett äldre administratörskonto
som redan är kopplat till medarbetaren frikopplas, och det nya arbetskontot
får kopplingen. Administratörskontot behåller sin behörighet, blir inte
inaktiverat och kan fortfarande användas för systemadministration.
Inga medarbetare, projekt eller aktiviteter skapas eller tas bort.
En medarbetare kan fortsatt bara ha **ett** kopplat konto åt gången.

Logga sedan ut och in med arbetskontot. Projektvalen gör personen
till projektmedlem och kan samtidigt ge projektledarskap. För att lägga
aktiviteter i andra projekt måste användaren vara projektmedlem, redan
ha en aktivitet där eller vara projektledare/uppdragsledare. Administratören
kan under samma behörighetssida senare ändra projekt och ledarroller.
Mottagarens godkännande krävs fortfarande vid tilldelningsförslag.

Försök inte använda en inloggningsadress som redan finns, eller separera
ett vanligt medarbetarkonto som redan är kopplat till personen; API:et
returnerar i så fall 409 utan att något ändras. En kopplad administratör
som saknar fungerande planering behöver inte få en extra personpost.

## Tidrapportering på aktiviteter

Planering har en egen flik **Tidrapportering**, med:
- Starta/stoppa tidtagning för en aktivitet. Klockan fortsätter på servern
  även när webbläsaren stängs. En medarbetare kan bara ha en aktiv klocka.
- Registrera tid manuellt för ett visst datum (1–1440 minuter).
- Justera datum, antal minuter och kommentar i efterhand; varje ändring
  får en revisionspost i `time_entry_audit`.
- Ta bort en felregistrering utan att radera revisionshistoriken (mjuk borttagning).
- Visa sparade poster och summering av faktisk tid, separat från planerad
  beläggning. Samma personpost används av separat arbetsinloggning.
- CSV-export med stabilt `entry_id`, `employee_email`, `project_code`,
  `activity_code`, `work_date`, `duration_minutes`, `duration_hours`,
  `updated_at_utc` och `status` (`active` eller `deleted`).
  Pågående klockor exporteras inte. Borttagna poster exporteras med
  status `deleted` för framtida synkronisering.

**Tidrapport-integration:** Ingen verifierad Tidrapport-API-specifikation
eller Tidrapport-kodbas är kopplad till detta repo. CSV-export är färdig
för manuell import/mappning, men **ingen automatisk synkronisering**
eller dataskrivning till Tidrapport är ännu aktiverad. Tidrapport behöver
ha en verifierad import/API-mottagare, autentisering och idempotenta
upsert/delete-regler innan den tvåvägsintegrationen kan driftsättas.
Tidposter identifieras av (`source_system`,`entry_id`) för att
undvika dubbelregistrering. Vid flera separata Planering-instanser
måste instans-ID inkluderas i nyckeln.

API för inloggad medarbetare: `GET /api/time-entries`,
`POST /api/time-entries` med action `start`, `stop`, `manual`,
`update` eller `delete`, samt `GET /api/time-entries?format=csv`.
Administratörer kan exportera rapporterad tid för samtliga medarbetare
med `?format=csv&scope=all`, förutsatt att kontot har en kopplad
medarbetaridentitet. All åtkomst kräver giltig webb-session,
och API:t tillåter inte att en användare ändrar någon annans tid.
CSV-hämtning är **inte** ett maskin-till-maskin-API; dela inte
sessioncookies med Tidrapport.

Databasmigrering `0014_time_entries.sql` skyddar rapporterad tid genom
FK-restriktioner och förhindrar att en medarbetare, aktivitet eller ett
projekt raderas av misstag när rapporterad tid finns. Det är möjligt
att ändra den planerade bemanningen oberoende av rapporterade timmar.

## Isolerat test av roller och aktivitetsbehörigheter

`scripts/test-role-access.mjs` startar en **separat** lokal Wrangler/D1-instans
med en temporär SQLite-databas under `/tmp/resursplanering-roles-*`.
Den använder testkonton och testprojekt, **inte** de verkliga kontona
eller databasen under `/var/lib/resursplanering*`. Databasen tas bort efter
testet, även vid testfel.

Testet kontrollerar administratör (även utan medarbetarkoppling), gruppchef,
projektledare, TEAM-leader och vanlig medarbetare. Det verifierar valbara
projekt, att andra projekt inte går att använda genom direkta API-anrop,
egna aktiviteter, erbjudanden till andra, mottagarens godkännande samt
SQLite-integritet. Det körs automatiskt i Docker/CI efter integrationstesterna.

```bash
# Från applikationens källkodskatalog efter pnpm install:
node scripts/test-role-access.mjs
```

Även `node scripts/test-individual-integration.mjs` körs mot en isolerad
testdatabas. **Godkänd CI verifierar koden, inte din befintliga databas
eller de projekt som just nu visas i din Proxmox-container.**
Om inga projekt syns vid inloggning: kontrollera att rätt testversion
körs och att `GET /api/data` innehåller projekt. Snabbformuläret
hämtar nu också valbara projekt oberoende via `GET /api/quick-activity`
och visar ett separat meddelande om kontot saknar medarbetarkoppling.

## Lokal utveckling

Kräver Node.js 22.13 eller senare och pnpm.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
DATA_DIR="$PWD/.wrangler/selfhost" HOST=127.0.0.1 PORT=3000 pnpm start:selfhosted
```

Öppna därefter `http://127.0.0.1:3000`.
