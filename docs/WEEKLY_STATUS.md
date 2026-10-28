# Veckostatus – första implementationen

En ny vy finns på `/weekly` (knappen **Veckostatus** i huvudmenyn). Den är knuten till den befintliga databasen.

## Funktioner
- En individuell veckovy för uppföljning, aktuell vecka, nästa vecka och kommande start.
- Projektmedverkan med värdena Aktiv och Vilande, separat från bemannade aktiviteter.
- Ny medarbetare skapas automatiskt om angiven e-postadress inte finns.
- Befintliga veckoposter uppdateras med stabilt `item_uid`. En redan existerande aktivitet kan inte tas över av en annan medarbetare.
- Föregående veckas sparade aktiviteter hämtas som uppföljningsunderlag.
- CSV UTF-8 (semikolonseparerad) kan öppnas och redigeras i Microsoft Excel. CSV-filen innehåller både aktiviteter och projektmedverkan.
- Import sker i två steg: läs in filen och granska, sedan **Spara**.

## Viktigt innan produktionsdriftsättning
- Gör en separat säkerhetskopia av lokala databasfiler och JSON-export.
- Detta är ett första utvecklingssteg. Riktig `.xlsx`-import/export med flera flikar, importförhandsgranskning med radvisa diffar, rollbaserad behörighetskontroll och helt automatiska veckoskiften återstår.
- Den nya routen använder samma yttre Nginx/Tailscale-skydd som den nuvarande applikationen. API:et har ännu ingen separat medarbetarbehörighet; exponera inte verktyget utan korrekt autentisering och behörighetskontroll.
- Nginx Basic Authentication används i den rekommenderade självhostade driften. Det är webbläsarens HTTP 401-dialog, inte en JavaScript-popup. Felsök med `curl -I` från klient och `curl -i http://127.0.0.1:3001/` från server.
- Nginx ska inte kopplas förbi för att undvika inloggningsdialogen.

## API
`GET /api/weekly?email=<adress>&week=<måndag YYYY-MM-DD>`

`POST /api/weekly` med JSON:
```json
{
  "email": "person@example.se",
  "name": "Person Exempel",
  "week": "2026-10-26",
  "items": [
    {"uid": "unik-uuid", "week": "2026-10-26", "category": "current",
     "title": "Granskning", "projectCode": "P-1042",
     "hours": 12, "outcome": "Pågår", "note": ""}
  ],
  "members": [
    {"projectCode": "P-1042", "projectName": "Modernisering",
     "state": "Aktiv"}
  ]
}
```

En tom lista tar inte bort befintliga projekt eller aktiviteter. Radera/avsluta genom separat framtida arbetsflöde.

## Drift
Installationsskriptet kör redan `wrangler d1 migrations apply` vid start. Testa den nya migrationen `0003_weekly_status.sql` på en kopia av databasen före uppdatering.
