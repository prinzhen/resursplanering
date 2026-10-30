# Excelimport: automatisk registrering och daterad aktivitetsprioritet

Gäller grenen `feature/team-roles-approvals`, testinstans port 3200. Kräver migrering `0012_activity_priority_history.sql`.

## Behörigheter
- **Administratör**: kan importera en befintlig eller ny medarbetare. Saknade projekt skapas automatiskt.
- **Gruppchef**: kan importera sig själv, sina befintliga direkt underställda och helt nya medarbetare. En ny medarbetare kopplas automatiskt till importerande gruppchef via `employees.manager_id`. Gruppchefen kan inte importera en redan registrerad medarbetare som tillhör någon annan chef.
- **Vanlig medarbetare**: får bara importera sin egen befintliga planering i projekt där hen redan deltar. Saknade medarbetare/projekt skapas inte.

### Konton
En ny medarbetare får ett **inaktivt** personligt inloggningskonto med ett slumpgenererat, okänt lösenord. Administratören anger ett nytt lösenord under **Behörigheter**, vilket aktiverar kontot. Inget standardlösenord skickas via Excel eller loggar.

## Så används Excel
1. Gå till **Veckoplanering · Excel**. Gruppchef och admin kan klicka **Tom mall för ny medarbetare**.
2. Fyll i **namn (B4)** och **e-post (F4)**.
3. Ange en eller flera aktivitetsrader. **Projektkod (E)** identifierar projekt, medan **Projekt/verksamhet (D)** används som projektnamn om ett nytt projekt behöver skapas.
4. **Prioritet (H)** kan vara 1–5, där 1 är högst. Lämna tomt i äldre filer för att behålla aktivitetens nuvarande prioritet.
5. Under **Projektmedverkan** används projektkod och namn för att lägga upp andra projekt som saknas, även om inga aktiviteter är tilldelade.
6. Granska importens förhandsvisning och tryck **Godkänn och importera**.

Importen matchar medarbetare på e-post och projekt på projektkod. Befintliga aktiviteter matchas via stabilt ID, eller entydig kombination av namn/projektkod/första planerade veckan när ID saknas. Återimport med oförändrade uppgifter ska inte ge dubbletter.

## Ändrad prioritet och periodindelning
Om ett befintligt aktivitetsvärde ändras i Excel, får den **nya prioriteten verkan från importdagen i svensk lokal tid (Europe/Stockholm)**.

För varje resurs som arbetar på aktiviteten och har en aktiv beläggningsperiod som sträcker sig över importdagen:
- Föregående period slutar **dagen före importdagen**.
- En ny period börjar **importdagen**, har samma beläggning i procent och behåller tidigare planerat slutdatum.
- Historiska prioriteringar sparas i `activity_priority_history`, med datum och användarkonto som gjorde ändringen.
- Import med oförändrad prioritet gör **ingen** ny delning.
- Om prioritet ändras flera gånger samma dag uppdateras dagens prioritet; ingen ny gräns eller dubbelbeläggning skapas.

Exempel: en period `2026-10-01–2026-11-30` på 50 % med prioritet 3 ändras vid import `2026-10-30` till 1. Perioderna blir `2026-10-01–2026-10-29` (50 %) och `2026-10-30–2026-11-30` (50 %). Historiken visar 3 före 30/10 och 1 från 30/10.

Saknade projekt från en gruppchefsimport skapas med gruppchefen som projektledare. Projektprioriteten är separat från varje aktivitetsprioritet.

## Backuper och utrullning
Prioritet och prioritetshistorik ingår i den ordinarie planeringsbackupen, tillsammans med `assignment_periods`. Lösenordshashar/sessionsdata ingår **inte** i planeringsexporten.

Uppdatera enbart port 3200: stoppa `resursplanering-test-access`, säkerhetskopiera `/var/lib/resursplanering-test-access/data`, bygg och typkontrollera koden, kör `node scripts/test-individual-integration.mjs` på en isolerad testdatabas, migrera 0012 mot port 3200:s datakatalog och starta tjänsten. Installationsskriptet för initial installation är **inte** avsett för uppgraderingar.
