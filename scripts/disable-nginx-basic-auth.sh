#!/usr/bin/env bash
# Remove the *outer* Nginx Basic Authentication popup on Planering production.
# Keep the app's native /login session authentication, Nginx reverse proxy
# and Tailscale Funnel unchanged.
set -Eeuo pipefail
umask 077

SITE="/etc/nginx/sites-available/resursplanering"
NGINX_URL="http://127.0.0.1:3001"
APP_URL="http://127.0.0.1:3000"
BACKUP=""
CHANGED=0
SUCCESS=0

msg() { printf '\n==> %s\n' "$*"; }
die() { printf 'FEL: %s\n' "$*" >&2; exit 1; }
status_code() {
  curl --noproxy '*' --connect-timeout 2 --max-time 10 \
    -sS -o /dev/null -w '%{http_code}' "$1"
}
rollback() {
  if [[ "$CHANGED" -eq 1 && "$SUCCESS" -eq 0 ]]; then
    printf '\nÅTERSTÄLLER Nginx-konfigurationen efter misslyckad kontroll...\n' >&2
    cp -a "$BACKUP" "$SITE"
    nginx -t && systemctl reload nginx || \
      printf 'KRITISKT: kunde inte läsa om Nginx. Kontrollera nginx -t och systemctl status nginx!\n' >&2
  fi
}
trap rollback EXIT
[[ "$EUID" -eq 0 ]] || die "Kör med sudo."
[[ -f "$SITE" && ! -L "$SITE" ]] || die "Den förväntade Nginx-konfigurationen saknas eller är en symlänk: $SITE"
for bin in curl nginx systemctl python3 cp; do command -v "$bin" >/dev/null || die "Saknar kommando: $bin"; done

msg "Verifierar Planerings INBYGGDA sessionskydd innan Nginx ändras"
[[ "$(status_code "$APP_URL/api/auth")" == 200 ]] || die "/api/auth på 3000 svarar inte HTTP 200."
[[ "$(status_code "$APP_URL/api/data")" == 401 ]] || \
  die "STOPP: Planerings /api/data kräver inte inloggning (väntat 401). Ta INTE bort Nginx-skyddet."
[[ "$(status_code "$APP_URL/api/time-entries")" == 401 ]] || \
  die "STOPP: tidrapport-API saknar sessionsskydd (väntat 401)."
[[ "$(status_code "$APP_URL/login")" == 200 ]] || die "Den inbyggda /login-sidan svarar inte HTTP 200."
systemctl is-active --quiet nginx || die "Nginx körs inte."
nginx -t >/dev/null

BACKUP="${SITE}.before-native-login-$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$SITE" "$BACKUP"
msg "Säkerhetskopia: $BACKUP"

# Remove only the exact Basic Authentication directives inside this one site.
# Abort if the site contains an unexpected syntax we don't know how to edit.
python3 - "$SITE" <<'PY'
import pathlib,re,sys
site=pathlib.Path(sys.argv[1])
source=site.read_text()
lines=source.splitlines(keepends=True)
regex=re.compile(r'^\s*auth_basic(?:_user_file)?\s+[^\n;]+;\s*(?:#.*)?$')
kept=[]
removed=[]
for line in lines:
    if re.match(r'^\s*auth_basic(?:_user_file)?\b',line):
        if not regex.fullmatch(line.rstrip('\r\n')):
            raise SystemExit("Okänt auth_basic-direktiv. Konfigurationen lämnas oförändrad: "+line.strip())
        removed.append(line.strip())
    else:
        kept.append(line)
if removed and len(removed)!=2:
    raise SystemExit("Förväntade två Basic Auth-direktiv, hittade "+str(len(removed))+".")
if len(removed)==2 and not any(x.startswith("auth_basic_user_file ") for x in removed):
    raise SystemExit("Saknar auth_basic_user_file. Konfigurationen lämnas oförändrad.")
if len(removed)==2:
    updated="".join(kept)
    if not all(word in updated for word in ["listen 127.0.0.1:3001;","proxy_pass http://127.0.0.1:3000;"]):
        raise SystemExit("Okänd proxystruktur; avbryter.")
    site.write_text(updated)
    print("Tog bort Nginx Basic Authentication. Övriga inställningar behållna.")
else:
    print("Nginx Basic Authentication är redan frånslagen.")
PY
CHANGED=1
msg "Kontrollerar och laddar om Nginx utan att starta om Planering"
nginx -t
systemctl reload nginx

msg "Verifierar: inbyggd login synlig, alla data fortfarande skyddade"
[[ "$(status_code "$NGINX_URL/login")" == 200 ]] || die "/login svarar inte HTTP 200 via Nginx."
[[ "$(status_code "$NGINX_URL/api/auth")" == 200 ]] || die "/api/auth svarar inte HTTP 200 via Nginx."
[[ "$(status_code "$NGINX_URL/api/data")" == 401 ]] || die "/api/data måste svara HTTP 401 utan session via Nginx."
[[ "$(status_code "$NGINX_URL/api/time-entries")" == 401 ]] || die "/api/time-entries måste svara HTTP 401 utan session via Nginx."
if curl --noproxy '*' --connect-timeout 2 --max-time 10 -sSI "$NGINX_URL/api/data" \
 | grep -qi '^www-authenticate: *basic'; then
  die "Det finns fortfarande en Basic Authentication-utmaning från Nginx."
fi
SUCCESS=1
msg "KLART: Nginx-popupen är borttagen och Planerings egna inloggning är kvar."
printf '%s\n' "Nginx- och Tailscale-proxyn är oförändrad." \
 "Logga in som vanligt på https://planering.tail323ccb.ts.net/login" \
 "Säkerhetskopia av Nginx-konfigurationen: $BACKUP"
