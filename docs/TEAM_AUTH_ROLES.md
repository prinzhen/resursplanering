# TEAM, inloggning och behörigheter – säker testgren

Denna funktion utvecklas i `feature/team-roles-approvals` och får inte flyttas till produktionsgrenen utan godkända bygg-, API- och rättighetstester.

## Begrepp
* **Organisatorisk grupp**: Chef–medarbetare-relationen `employees.manager_id`.
* **TEAM**: Namngiven tvärfunktionell grupp med valbara medlemmar, `employee_groups` och `employee_group_members`. Databastabellens äldre namn behålls för kompatibilitet.
* **Gruppchef**: Individuellt konto med `is_group_manager=1`, som kan administrera sina direktrapporter och egna TEAM.
* **TEAM-leader**: Explicit koppling i `team_leaders`; får se TEAM-planeringen men får inte därigenom ändra någon annans arbete.
* **Projektledare**: Explicit koppling i `project_leaders`; får se och planera aktiviteter inom de projekt hen leder.
* **Admin**: Individuellt konto med `is_admin=1`.

En person kan samtidigt vara gruppchef, projektledare och TEAM-leader.

## Medarbetarens inloggning
Den gamla Nginx Basic Auth är ett *yttre* skydd och identifierar inte användaren i applikationen. Den här grenen inför lokal kontobaserad inloggning via `/login`.

Inloggningen använder saltad PBKDF2-SHA256 (310 000 iterationer), per användare, och tidsbegränsade opaka sessioner i HttpOnly-kakor. Logininformation sparas inte i JavaScript eller localStorage. Felaktiga försök låser kontot temporärt.

Administratören kan skapa konton på `/access`; användaren byter lösenord på `/account`. Inloggning avser befintligt konto, **inte bara ett namn i en rullista**.

## Behörighetsprincip
Alla kontroller ligger i API:et. Webbgränssnittet döljer eller låser också otillåtna åtgärder, men kan aldrig bevilja behörighet.

| Åtgärd | Medarbetare | TEAM-leader | Projektledare | Gruppchef | Admin |
| --- | --- | --- | --- | --- | --- |
| Se alla aktiviteter i projekt man deltar i | Ja | Ja | Ja | Ja, för egna rapporter | Ja |
| Se TEAM-översikt/Gantt/Kanban | Egna projekt/aktivitet | Hela TEAMET | Egna projekt | Egna rapporter/TEAM | Alla |
| Skapa aktivitet åt sig själv | I projekt man deltar i | Som medarbetare | Ja | Som medarbetare | Ja |
| Direkt bemanna någon annan | Nej | Nej | Inom eget projekt | Egna medarbetare via bemannings-/projektstyrning | Ja |
| Begära aktivitet åt kollega | Ja, kräver godkännande | Ja | Kan även bemanna direkt | Kan även administrera rapporter | Ja |
| Godkänna tilldelningsförfrågan | Endast mottagare | Endast mottagare | Endast mottagare | Endast mottagare | Ja |
| Utse TEAM-leader/projektledare | Nej | Nej | Nej | Bland egna medarbetare, inom eget ansvar | Ja |
| Skapa konto/tilldela Gruppchef | Nej | Nej | Nej | Nej | Ja |

## Godkännande av aktivitetsbemanning
1. En medarbetare skapar en aktivitet i sitt projekt (automatiskt egen tilldelning med 0 % som startvärde), eller väljer en befintlig aktivitet som hen kan se.
2. Via **Förfrågningar** väljer hen en projektmedlem, datum, procent och kommentar.
3. En rad i `assignment_requests` skapas med `pending` – ingen bemanning eller belastning för mottagaren skapas ännu.
4. Mottagaren godkänner: `assignments` och `assignment_periods` skapas, status blir `approved`.
5. Mottagaren avvisar: status blir `rejected`, ingen tilldelning skapas.
6. Begäraren kan återkalla en väntande förfrågan.

Mottagaren måste redan vara med i projektet. Gruppchef/projektledare lägger först till personen i projektet vid behov. Om en befintlig tilldelning finns för samma aktivitet och person stoppas förfrågan.

## Uppstart av separat testinstans
Använd en **egen kopia** av kod och datakatalog. Migreringar 0009 och 0010 krävs innan konton skapas. Exempel: kod `/opt/resursplanering-test-access`, datakatalog `/var/lib/resursplanering-test-access/data` och loopback-port `3200`.

1. Gör säkerhetskopia av källdatabasen när tjänsten är stoppad.
2. Starta testinstansen så att migreringar körs; stoppa den igen.
3. Kör offline-provisionering av administratör med ett starkt lösenord (programmet frågar utan att visa tecknen):
```bash
sudo python3 /opt/resursplanering-test-access/scripts/provision-account.py \
  --data-dir /var/lib/resursplanering-test-access/data \
  --email admin@example.se --admin
```
4. Starta instansen, logga in på `/login` och lägg upp riktiga användarkonton med koppling till medarbetare.
5. Prova logins och nekade API-anrop under separata webbläsarprofiler innan extern åtkomst.

**OBS:** Starta inte denna gren på den befintliga port 3100 utan först ett separat verifierat test. Den tidigare delade Basic Auth räcker inte för behörighetsstyrning på API-nivå. Konton och rättighetsdata ska aldrig kopieras till ett publikt testsystem utan åtkomstskydd.
