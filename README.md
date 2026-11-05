# Resursplanering

Webbapplikation för projekt, uppdrag, aktiviteter, bemanning, beläggning, personliga planeringar, Gantt-scheman samt import och export.

## Medarbetare med rapporterad tid – behåll på grupp eller ta bort

När en administratör tar bort en medarbetare som har rapporterad tid erbjuder
bekräftelsedialogen två uttryckliga alternativ:

- **Behåll timmarna på grupp:** Välj befintlig TEAM/grupp. Alla tidposter,
  inklusive tidigare mjukt borttagna poster för revisionshistorik, kopplas om
  till en icke-personlig **gruppbokföringsidentitet**. Namn och e-postadress
  från medarbetaren används inte som rapportidentitet. Projekt, aktivitet,
  arbetsdatum, minuter, kommentarer, externa tidpost-ID och tidrapportens
  ändringshistorik behålls. Gruppbokföringsidentiteten är varken ett konto
  eller en person som visas i den ordinarie personal- och bemanningsvyn.
  Endast en särskilt dold teknisk personrad används för att uppfylla
  SQLite-tabellens befintliga foreign key `time_entries.employee_id`.
- **Radera timmar:** Kräver `RADERA TID`. Tidposterna tas bort från den
  aktiva redovisningen, men revisionsarkivet och tombstones för framtida
  synkronisering sparas. Arkivet anonymiserar namn och e-postadress.

**Behörighet:** Under fliken *Tidrapportering* väljer administratören
*Alla medarbetare och grupper* för att se och **ändra** datum, minuter,
kommentar och aktivitet/projekt på slutförda tidposter. Ändringar spåras
i `time_entry_audit`, och byte av aktivitet även i
`time_entry_relocations`. Gruppchefer som äger gruppen
(`employee_groups.owner_id` och aktiv gruppchefsroll) och projektledare
för projektet (`project_leaders`) får välja *Historiska timmar bokförda
på grupp*. De får **läsa men inte ändra** grupptimmarna. Vanliga medarbetare
får inte läsa andra personers tid eller gruppens historik.

**Viktiga begränsningar:** En pågående tidtagning måste stoppas innan
medarbetaren tas bort. Om medarbetaren har ett eget inloggningskonto visas
ett **separat obligatoriskt val** för att inaktivera och koppla bort kontot,
samt återkalla alla sessioner. Kontot behålls i inaktiverat tillstånd för
administrativ revisionshistorik, aldrig som aktivt personkonto.
För att gruppchef ska se grupptimmarna måste gruppen ha en tilldelad chef/ägare. Fritextkommentarer kan själva
innehålla personnamn och behöver i så fall granskas separat. En grupp
med kvarvarande historiska bokföringsrader kan inte raderas utan att
historiens destination först hanteras.

Migration `0016_group_time_ledger.sql` lägger till gruppkoppling och
bokföringsmarkering utan att återskapa eller tömma `time_entries` eller
`time_entry_audit`. Testerna verifierar skyddad åtkomst, korrigeringar,
gruppöverföring och bevarade FK-relationer.

### Produktionsuppdatering

Använd `scripts/update-production-group-ledger.sh` i utvecklingsgrenen
när GitHub Actions har passerat. Skriptet installerar en versionslåst
release, testar helt isolerat och tar kall backup av skarpa databasen innan
den byter kod på port 3000. Nginx på port 3001 och Tailscale ändras inte.
Skriptet kontrollerar ledigt utrymme på `/opt` för att minska risken för
det tidigare felet `ERR_PNPM` och bekräftar uttryckligen migrering `0016`
i den faktiska applikationsdatabasen (inte Wranglers metadatabas).

```bash
curl -fsSLo /tmp/update-production-group-ledger.sh \
  https://raw.githubusercontent.com/prinzhen/resursplanering/16e6ad174890706babe5402cfb87750769f6df61/scripts/update-production-group-ledger.sh
bash -n /tmp/update-production-group-ledger.sh
sudo bash /tmp/update-production-group-ledger.sh
# Bekräfta med JA GRUPPTID
```

Produktionens version efter lyckad installation:
`acb0dada80ae635e76264ab2123bec343f775977`.
Tidigare kod och kall databasbackup bevaras för återställning.
**Kör först efter att den angivna releaseversionen fått gröna CI-tester.**

## Administratör: flytta eller radera tid vid projektradering

Om ett projekt, uppdrag eller en aktivitet har registrerade tidposter visas
nu en obligatorisk administratörsdialog som visar antalet tidposter och timmar,
även tidposter som tidigare markerats som borttagna.

Administratören väljer:

1. **Flytta tidposter** till en befintlig aktivitet utanför det som ska raderas.
   Överföring bevarar medarbetare, arbetsdatum, varaktighet, kommentarer och
   tidpostens oförändrade ID. Endast aktivitet/projekt ändras.
   Flytten registreras i `time_entry_relocations` med gammal och ny kontext,
   administratörskonto och tidpunkt. Projektmedlemskap och bemanning på
   mottagaren ändras **inte** automatiskt.
2. **Ta bort tidposter**. Kräver att administratören skriver `RADERA TID`.
   Varje borttagen tidpost arkiveras i `time_entry_removal_archive`
   tillsammans med en egen beständig utgående delete-händelse för framtida
   synkronisering mot Tidrapport. De gamla huvud- och auditposterna kan därefter
   tas bort utan FK-fel, men granskningsuppgifterna finns kvar i arkivet.

Om någon tidtagning fortfarande pågår måste den stoppas innan projektet
eller aktiviteten får raderas. Dialogen använder en tidsdatabas-fingerprint
för att upptäcka förändrade tidposter och kräva att användaren granskar igen
före borttagningen. Alla förändringar utförs i samma D1 batch/transaction.

Det finns också ett administratörsval **Visa alla medarbetares tidposter**
under Tidrapportering. Där kan administratören markera en annan medarbetares
avslutade tidpost som borttagen (soft delete) utan att radera dennes
revisionshistorik. Den kan sedan arkiveras tillsammans med källprojektet.

**Installera på skarp port 3000 efter grön CI**, utan att påverka Tailscale eller
Nginx och utan att skriva över databasen:

```bash
curl -fsSLo /tmp/update-production-timereconciliation.sh \
  https://raw.githubusercontent.com/prinzhen/resursplanering/feature/quick-activities-gantt-proposals/scripts/update-production-timereconciliation.sh
bash -n /tmp/update-production-timereconciliation.sh
sudo bash /tmp/update-production-timereconciliation.sh
```

Skriptet kräver `JA TID`, kör isolerade tester före bytet, tar en kall
säkerhetskopia av hela D1/SQLite-databasen, växlar endast programkoden och
kontrollerar antalet projekt, aktiviteter, medarbetare och tidposter efteråt.
Om något misslyckas försöker det återställa gammal kod och databas. **Kör inte
äldre `installera.sh` från `main` för denna uppdatering**.

## En enda inloggning – ta bort Nginx-popupen

Planerings egna personliga inloggning på `/login` använder sessioncookies,
kontroll på varje skyddat API och kontobaserade behörigheter. Den äldre
Nginx Basic Authentication (webbläsar-popupen) behövs därför inte som
separat inloggningslager. Port 3000, Nginx på 3001 och Tailscale Funnel
förblir oförändrade. **Observera:** Funnel är publik på internet och när
popupen tas bort kan vem som helst se inloggningssidan; skyddet består
därefter av Planerings inbyggda inloggning och dess låsningsfunktion
vid upprepade felaktiga lösenord.

Ändra den befintliga skarpa installationen på Planering-servern
(uppdaterar enbart Nginx-konfigurationen, INTE applikation eller databas):

```bash
curl -fsSLo /tmp/disable-nginx-basic-auth.sh \
  https://raw.githubusercontent.com/prinzhen/resursplanering/feature/quick-activities-gantt-proposals/scripts/disable-nginx-basic-auth.sh
bash -n /tmp/disable-nginx-basic-auth.sh
sudo bash /tmp/disable-nginx-basic-auth.sh
```

Skriptet verifierar **innan** ändringen att `/api/data` och
`/api/time-entries` ger HTTP 401 utan en Planering-session.
Det tar backup av Nginx-konfigurationen i
`/etc/nginx/sites-available/resursplanering.before-native-login-<timestamp>`,
tar endast bort de två `auth_basic`-direktiven, kör `nginx -t`,
laddar om Nginx och testar sedan att `/login` ger HTTP 200 och
att privata API:er fortfarande ger HTTP 401. Fel triggar återställning.

Kontroll efteråt (utan cookies/credentials):

```bash
curl -s -o /dev/null -w 'Login: HTTP %{http_code}\n' http://127.0.0.1:3001/login
curl -s -o /dev/null -w 'Data: HTTP %{http_code}\n' http://127.0.0.1:3001/api/data
# Login ska ge 200. Data ska ge 401.
```

Gamla htpasswd-filen behålls orörd som återställningsmöjlighet,
men används inte. Rulla inte tillbaka till äldre `installera.sh` på
`main` – den skulle kunna lägga tillbaka popupen **och** installera
äldre applikationskod. Den uppdaterade installeraren i
`feature/quick-activities-gantt-proposals` tar inte längre emot eller
kräver ett separat Nginx-lösenord.

Den rekommenderade egna driftsättningen på Ubuntu 24.04 använder Node.js och en systemd-tjänst, helt utan Docker. Applikationen ligger på serverns loopback-adress, skyddas av applikationens personliga inloggning och publiceras med HTTPS via Tailscale Funnel. Inga inkommande portar behöver öppnas i internetbrandväggen.

## Snabbinstallation på Ubuntu 24.04

Kör följande kommando på servern:

```bash
curl -fsSL https://raw.githubusercontent.com/prinzhen/resursplanering/main/installera.sh | sudo bash
```

Installationsskriptet installerar Node.js, pnpm, Nginx och Tailscale, hämtar och bygger applikationen samt skapar systemd-tjänsterna. Första gången får du välja användarnamn och ett lösenord på minst 14 tecken. Endast lösenordets bcrypt-hash sparas. När Tailscale visar en inloggningslänk öppnar du den och godkänner servern.

Tailscale Funnel gör inloggningssidan publik på internet. Projektdata och skyddade API:er kräver inloggning i Planering; använd ett unikt och långt lösenord på varje konto.

Applikationsdata sparas i `/var/lib/resursplanering/data` och påverkas inte när installationsskriptet körs igen.

```bash
# Status
sudo systemctl status resursplanering

# Logg
sudo journalctl -u resursplanering -f

# Byt lösenord på ett befintligt personligt konto via Planerings kontosida

# Uppdatera till senaste versionen
curl -fsSL https://raw.githubusercontent.com/prinzhen/resursplanering/main/installera.sh | sudo bash
```

Docker-instruktionerna längre ned finns kvar som ett alternativ för miljöer där Docker redan fungerar.

## Arkitektur

- Vinext/React för webbgränssnitt och API.
- Lokal Cloudflare Worker-körning via Wrangler/Miniflare.
- Lokal beständig SQLite/D1-databas i `/var/lib/resursplanering/data`.
- systemd för start, övervakning och automatisk omstart.
- Nginx som omvänd proxy på `127.0.0.1:3001`; Planerings egen sessioninloggning skyddar data.
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

## Säker övergång från testport 3200 till skarp port 3000

På Planering-servern (Ubuntu 24.04) används:

- Produktion: `resursplanering.service`, `127.0.0.1:3000`,
  `/var/lib/resursplanering/data`, systemanvändare `resursplanering`.
- Nginx: `127.0.0.1:3001`, bakom Tailscale Funnel på befintlig adress.
- Test: `resursplanering-test-access.service`, `127.0.0.1:3200`,
  `/var/lib/resursplanering-test-access/data`, systemanvändare `prinzhen`.

**Databaserna är oberoende. Ingen automatisk sammanslagning genomförs.**
Att välja testdatabasen innebär att produktionsdata från 3000 blir en
säkerhetskopierad historisk datamängd (inte aktiva person-/projektposter).
Använd `--inspect` och kontrollera posterna innan datakälla väljs.

Den kontrollerade växlingsrutinen finns i
`scripts/promote-test-to-production.sh`:

```bash
# På Planering-servern: hämta och syntaxkontrollera skriptet.
curl -fsSLo /tmp/promote-test-to-production.sh \
  https://raw.githubusercontent.com/prinzhen/resursplanering/feature/quick-activities-gantt-proposals/scripts/promote-test-to-production.sh
bash -n /tmp/promote-test-to-production.sh

# 1. OFARLIG inventering av båda databaserna (ingen tjänst stoppas):
sudo bash /tmp/promote-test-to-production.sh --inspect

# 2. Först efter granskning: välj exakt EN aktiv datakälla.
# Behåll konton och arbete som registrerats i testversionen:
sudo bash /tmp/promote-test-to-production.sh --promote --source=test

# Alternativt: behåll produktionsdatan (kräver aktivt adminkonto där):
# sudo bash /tmp/promote-test-to-production.sh --promote --source=production
```

Skriptet gör följande:

1. Kontrollerar tjänsternas `PORT` och `DATA_DIR` mot förväntade värden.
2. Visar tabellantal, SQLite-integritet och antal aktiva administratörer.
3. Kräver explicit datakälla och en interaktiv bekräftelse.
4. Klonar och bygger **exakt en GitHub-CI-testad release-SHA**
   i en separat stagingkatalog; kör både roll- och synkroniseringstester.
5. Stoppar 3000 och 3200, tar kalla fullständiga databaskopior,
   kopierar vald datakälla vid behov och byter applikationskod.
6. Startar produktion på port 3000 och verifierar API, autenticering,
   SQLite-integritet, aktiva administratörer, antal dataposter och
   Nginx-skydd (HTTP 401 utan credentials).
7. Om något misslyckas återställs den gamla produktionskoden,
   originaldatabasen och båda tjänsterna automatiskt.
8. Först efter lyckad kontroll inaktiveras testtjänsten.
   Tidrapport-adaptern aktiveras **inte**; separat systemd-timer
   förblir avstängd tills mottagar-API är verifierat.

Både kod från föregående version och originaldatabaser bevaras
under `/opt/resursplanering.before-<timestamp>` respektive
`/var/backups/resursplanering-promotion/<timestamp>/`.
Testkataloger tas inte bort automatiskt och kan tas bort först
när den nya skarpa versionen har använts och manuellt verifierats.

Efter uppgraderingen:

```bash
sudo systemctl status resursplanering --no-pager
sudo systemctl is-enabled resursplanering-test-access
sudo ss -lntp | grep -E ':3000|:3001|:3200'
sudo tailscale funnel status
```

Tänk på att ett gammalt webbläsarpass till port 3000 inte behöver
gälla i den nya databasen: logga in med ett aktivt administratörs- eller
arbetskonto från **vald datakälla**. Nginx Basic Auth och Tailscale-adressen
är oförändrade. Ändra inte `installera.sh` mot `main` som en genväg
innan samma nya release har förts till huvudgrenen.

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

**Tidrapport-integration:** Nu ingår ett förberett utgående API-adapter-skript,
`scripts/sync-tidrapport.mjs`. Det läser bara den lokala
SQLite/D1-databasens `time_entry_audit` (migrering 0014) och skickar
nya, justerade och mjukt borttagna tidposter som JSON-POST till
**ett verifierat mottagar-API** på Tidrapport-servern.

**Viktigt:** Tidrapports faktiska API/källkod har ännu inte kunnat verifieras.
Anslutningen är därför som standard **AVSTÄNGD**. Ingen automation eller
överföring till Tidrapport har driftsatts. Skriptet fungerar mot en
testmottagare, men ett riktigt mottagar-API måste stödja nedanstående
kontrakt innan `TIDRAPPORT_SYNC_ENABLED=yes` används.

### Utgående integrationskontrakt (Planering -> Tidrapport)

Planering använder ett *stabilt käll-ID* per tidpost och ett monotont
*versions-ID* från dess revisionshistorik.

Exempel på JSON-body (en POST per ändring):

```json
{
  "schemaVersion": 1,
  "sourceSystem": "planering",
  "sourceInstance": "planering-test-3200",
  "sourceEntryId": "22",
  "sourceEventId": "85",
  "sourceVersion": 85,
  "operation": "upsert",
  "employee": {
    "sourceId": 7,
    "email": "employee@example.se",
    "name": "Exempelperson"
  },
  "project": {"sourceId": 11, "code": "P-1042", "name": "Exempelprojekt"},
  "activity": {"sourceId": 12, "code": "A-42", "name": "Exempelaktivitet"},
  "workDate": "2026-11-03",
  "durationSeconds": 3600,
  "note": "Projektarbete",
  "origin": "manual",
  "startedAtUtc": "2026-11-03T08:00:00.000Z",
  "endedAtUtc": "2026-11-03T09:00:00.000Z",
  "updatedAtUtc": "2026-11-03T09:00:00.000Z",
  "eventTimeUtc": "2026-11-03T09:00:00.000Z"
}
```

Headers: `Authorization: Bearer <TIDRAPPORT_SYNC_TOKEN>`,
`Content-Type: application/json`,
`Idempotency-Key: planering:<instance>:<entryId>:<eventId>`.
En borttagen tidpost skickas med `operation=delete` och
`durationSeconds=null` men med oförändrat käll-ID.
Mottagaren ska lagra `(sourceSystem,sourceInstance,sourceEntryId)`
som unik nyckel, **uppdatera bara om `sourceVersion` är högre** och
besvara även redan behandlade meddelanden med HTTP 2xx. Den måste
registrera tidposten varaktigt *innan* den returnerar 2xx.
Kompatibilitet och projekt-/personmappning måste godkännas
i Tidrapport innan riktiga data skickas. Adaptern skickar ingen
information från pågående, ännu inte stoppad klocka.

Vid HTTP-fel eller nätverksfel avslutas körningen utan att avancera
checkpoint. Nästa körning skickar om den första ej bekräftade
ändringen med samma idempotensnyckel. Checkpoint lagras som en separat
atomiskt uppdaterad JSON-fil utanför databasmappen.
Körning med `TIDRAPPORT_SYNC_DRY_RUN=yes` visar planerade
händelser utan att skicka något eller spara checkpoint.
Databasen öppnas read-only.

### Installation och test mot riktig Tidrapport (enbart testport 3200)

Använd detta först **efter** att Tidrapport-applikationens kod/API har
granskats och mottagaren har ett verifierat idempotent REST-gränssnitt.
Exempelfiler finns i `deploy/`; de installeras **inte automatiskt**.

```bash
# Kör med ditt konto som har sudo:
sudo install -d -m 700 /etc/planering
sudo install -m 600 deploy/tidrapport-sync.test.env.example /etc/planering/tidrapport-sync.env
sudo install -d -o prinzhen -g prinzhen -m 700 /var/lib/resursplanering-test-access/tidrapport-sync
sudoedit /etc/planering/tidrapport-sync.env
# Sätt korrekt mottagar-URL, bearer-token, instans-ID. Låt ENABLED=no först.

# Test mot den lokala D1-databasen, INGEN nätverksöverföring:
sudo -u prinzhen env -i PATH=/usr/bin:/bin \
  PLANERING_DATA_DIR=/var/lib/resursplanering-test-access/data \
  TIDRAPPORT_SYNC_INSTANCE=planering-test-3200 \
  TIDRAPPORT_SYNC_STATE=/var/lib/resursplanering-test-access/tidrapport-sync/state.json \
  TIDRAPPORT_SYNC_DRY_RUN=yes \
  node /opt/resursplanering-test-access/scripts/sync-tidrapport.mjs

# Aktivera ENDAST efter verifierad mottagare och lyckat test:
sudo install -m 644 deploy/tidrapport-sync.service /etc/systemd/system/
sudo install -m 644 deploy/tidrapport-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
# Ändra till TIDRAPPORT_SYNC_ENABLED=yes när mottagaren finns och har testats.
# sudo systemctl enable --now tidrapport-sync.timer
```

Kör `node scripts/test-tidrapport-sync.mjs` för isolerade integrationstester
mot en lokal HTTP-mottagare. Testen provar idempotens, manuell tid,
korrigeringar, radering, omförsök efter 503, atomisk checkpoint,
fel instans och skydd mot okrypterad extern HTTP.
Detta verifierar inte kompatibilitet med den verkliga Tidrapport-servern.

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
