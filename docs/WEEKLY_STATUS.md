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


## Förslag på ersättning för HTTP Basic Authentication

Den befintliga Nginx-konfigurationen använder `auth_basic`, vilket triggar webbläsarens inbyggda HTTP 401-dialog. Detta är inte en popup.

Rekommenderat säkert alternativ för självhostad drift: en dedikerad autentiseringsproxy (exempelvis oauth2-proxy med verifierad OIDC-identitetsleverantör) framför applikationen och Nginx `auth_request`. Inloggning sker som vanlig navigering till en sida och med en serververifierad sessionscookie.

Säkerhetskrav innan aktivering:
- Ge bara autentiserade användare åtkomst till såväl `/api/data` som `/api/weekly`, inte enbart webbsidor.
- Introducera individuella behörigheter innan användare får hämta eller redigera andra personers data.
- Använd HTTPS, Secure, HttpOnly och SameSite för cookies samt CSRF-skydd.
- Låt aldrig publika klienter nå port 3000 direkt. Nginx/autentiseringsproxyn måste vara enda ingången.
- Konfigurera Tailscale Serve/Funnel och proxy-headers för den faktiska driftsmiljön.
- Behåll `auth_basic` tills ersättningen har end-to-end-testats, inklusive nekad åtkomst till API för oinloggade användare.

Att bara rita en lösenordsruta i React utan serververifiering är **inte** ett säkert alternativ. Denna gren innehåller ännu ingen sådan autentiseringsproxy.
