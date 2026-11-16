# Vanlig projektimport och export – testversion

Separat från personlig Excel v2.

## Format och nuläge
- XLSX: import/export av projekt, medarbetare, uppdrag, aktiviteter och enkel bemanning.
- XML/MSPDI: grundläggande import/export för ett projekt i taget, med datum och resurser.
- MPX: grundläggande import/export av numrerade aktivitetsfält (61/70) och datum.
- MPP: inte aktiverat. Binär läsning kräver en isolerad MPXJ-konverterare.
- JSON: fullständig säkerhetskopiering. Återställning hanteras separat.
- CSV: borttaget ur gränssnitt och vanligt import-API; legacy-anrop ger HTTP 410.

MSPDI och MPX bevarar ännu inte alla avancerade beroenden, kalendrar eller baslinjer. Verifiera utbytet mot riktiga filer från aktuell källapplikation.

## Säkerhet
- Organisationsövergripande import kräver administratör.
- Förhandsgranskning är läsande och visar nya/uppdaterade objekt och varningar.
- Godkänd import använder en enda D1.batch, atomär vid SQL-fel.
- Befintliga projektnamn och personnamn behålls.
- Aktivitet matchas via projektkod+aktivitetskod eller verifierad RP-ID.
- Felaktiga datum stoppas före sparande. Särskilda bemanningsperioder får inte massuppdateras.
- Resurstilldelningar som inte finns i importfilen raderas inte.

## Automatisk testsvit
Kör från en separat Git-klon som vanlig användare (utan sudo):

    bash scripts/test-all-permissions-exchange.sh

Skriptet vägrar köra inuti en aktiv installationskatalog och testar mot tillfälliga lokala databaser. GitHub Actions kör motsvarande isolerade tester under byggningen.

## Före produktionssättning
1. Verifiera MSPDI/MPX med filer från riktig Microsoft Project-installation.
2. Lägg till MPXJ-tjänst om binär MPP-import behövs.
3. Utöka formatmappningen för beroenden, kalendrar och avancerade resursprofiler.
4. Behåll JSON-återställning som separat administrativt arbetsflöde.
