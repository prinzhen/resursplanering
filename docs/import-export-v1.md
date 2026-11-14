# Import och export – format v1

## Beslut

De tidigare CSV-mallarna utgår som **stödda planeringsformat**. En separat JSON-säkerhetskopia av hela databasen är fortfarande nödvändig och ska inte ersättas av XLSX.

Två **olika** XLSX-mallar:
- **Veckoplanering** med exakt 16 kolumner enligt `WEEKLY_HEADERS`. Vecka är ISO-vecka (`2026-V40`), dag är valfri, varaktighet är kalendertid i dagar/veckor och planerade timmar anges separat.
- **Projektplanering** med datumintervall, resurser och beroenden enligt `PROJECT_HEADERS`.

Standardkapacitet: 8 timmar/dag, 5 arbetsdagar/vecka, 40 timmar/vecka. Insats är procent av arbetskapacitet. Manuell planerad tid får avvika från automatiskt beräknad tid. Helger räknas inte som arbetsdagar.

## Datamodell som krävs innan återimport kan aktiveras

En aktivitets identitet måste vara oberoende av planeringsposter. En aktivitet kan ha flera veckoplaneringar med samma aktivitets-ID. Varje planeringspost måste ha ett **eget stabilt ID** (i dold XLSX-metadata eller särskild teknisk kolumn) för säkra uppdateringar.

Följande behövs utöver nuvarande `activities` och `assignments`:
- Veckoplaneringsposter: aktivitets-ID, medarbetar-ID, ISO-vecka, valfri dag, varaktighet i kalenderdagar, insats %, planerade timmar, status, prioritet, deadline, kommentar och flyttorsak.
- Först planerad (oföränderlig originalvecka) och revisionshistorik.
- Importbatch-ID, originalfil, formatversion samt rad-ID för idempotens.
- Mappning av externa ID:n (Microsoft Project/GanttProject) till interna aktivitets-ID:n.

## Säker import

1. Validera filformat, filstorlek, kolumnrubriker, datatyper och värden.
2. Förhandsgranska och redovisa nya, uppdaterade och konfliktdrabbade poster.
3. Kontrollera behörighet för projekt, användare och tilldelningar.
4. Ändra aldrig rapporterad tid eller historik implicit.
5. Genomför godkända ändringar transaktionellt och revisionslogga.
6. Ta aldrig bort en aktivitet endast för att en rad saknas i importfilen.

## Stöd för andra filformat (senare steg)

MSPDI/XML prioriteras för datautbyte med Microsoft Project. MPP importeras via en separat MPXJ-adapter; binär MPP-export ska **inte** utlovas. MPX/GAN och andra format läggs i dedikerade adaptrar med tydligt angiven import/export-kapacitet.

## Implementationens status

Denna första commit levererar gemensamma, testbara tidsregler och ett låst kolumnkontrakt. **Den innehåller ännu inte XLSX-filhantering, nya databasfält, UI eller produktionsklar import.** Ändra inte den aktiva CSV/JSON-funktionen förrän den nya importen kan ersätta den säkert.
