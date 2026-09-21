#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="resursplanering"
APP_USER="resursplanering"
APP_GROUP="resursplanering"
APP_DIR="/opt/resursplanering"
STATE_DIR="/var/lib/resursplanering"
SERVICE_FILE="/etc/systemd/system/resursplanering.service"
AUTH_FILE="/etc/nginx/resursplanering.htpasswd"
NGINX_SITE="/etc/nginx/sites-available/resursplanering"
REPO_ARCHIVE="https://github.com/prinzhen/resursplanering/archive/refs/heads/main.tar.gz"
NODE_MAJOR="24"
PNPM_VERSION="11.25.0"
TEMP_DIR=""

step() { printf '\n==> %s\n' "$*"; }
die() { printf '\nFEL: %s\n' "$*" >&2; exit 1; }
cleanup() {
  if [[ -n "${TEMP_DIR}" && -d "${TEMP_DIR}" && "${TEMP_DIR}" == /tmp/resursplanering.* ]]; then
    rm -rf -- "${TEMP_DIR}"
  fi
}
trap cleanup EXIT

if [[ ${EUID} -ne 0 ]]; then
  die "Kör skriptet med sudo."
fi

source /etc/os-release
[[ ${ID:-} == "ubuntu" && ${VERSION_ID:-} == "24.04" ]] || \
  die "Skriptet kräver Ubuntu 24.04. Hittade ${PRETTY_NAME:-okänt system}."

export DEBIAN_FRONTEND=noninteractive

step "Installerar grundpaket"
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg rsync tar

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/package.json" ]]; then
  SOURCE_DIR="${SCRIPT_DIR}"
else
  step "Hämtar Resursplanering från GitHub"
  TEMP_DIR="$(mktemp -d /tmp/resursplanering.XXXXXXXX)"
  curl -fL --retry 3 --retry-delay 2 "${REPO_ARCHIVE}" -o "${TEMP_DIR}/source.tar.gz"
  tar -xzf "${TEMP_DIR}/source.tar.gz" -C "${TEMP_DIR}"
  SOURCE_DIR="${TEMP_DIR}/resursplanering-main"
fi
[[ -f "${SOURCE_DIR}/package.json" && -f "${SOURCE_DIR}/pnpm-lock.yaml" ]] || \
  die "Källkoden kunde inte hämtas eller saknar nödvändiga filer."

step "Installerar Node.js ${NODE_MAJOR} och pnpm ${PNPM_VERSION}"
install -d -m 0755 /usr/share/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
printf 'deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_%s.x nodistro main\n' \
  "${NODE_MAJOR}" > /etc/apt/sources.list.d/nodesource.list
apt-get update
apt-get install -y --no-install-recommends nodejs
[[ "$(node --version)" == v${NODE_MAJOR}.* ]] || \
  die "Fel Node-version installerades: $(node --version)."
npm install --global "pnpm@${PNPM_VERSION}"

step "Installerar och startar Tailscale"
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg \
  -o /usr/share/keyrings/tailscale-archive-keyring.gpg
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list \
  -o /etc/apt/sources.list.d/tailscale.list
apt-get update
apt-get install -y --no-install-recommends tailscale

# Proxmox LXC saknar ibland TUN. Tailscale Serve fungerar i userspace-läge.
if [[ ! -c /dev/net/tun ]]; then
  if grep -q '^FLAGS=' /etc/default/tailscaled; then
    sed -i 's|^FLAGS=.*|FLAGS="--tun=userspace-networking"|' /etc/default/tailscaled
  else
    printf '%s\n' 'FLAGS="--tun=userspace-networking"' >> /etc/default/tailscaled
  fi
fi
systemctl daemon-reload
systemctl enable tailscaled
systemctl restart tailscaled

tailscaled_ready=false
for _ in $(seq 1 15); do
  if systemctl is-active --quiet tailscaled; then
    tailscaled_ready=true
    break
  fi
  sleep 1
done
if [[ ${tailscaled_ready} != true ]]; then
  systemctl status --no-pager tailscaled || true
  journalctl -u tailscaled -n 100 --no-pager || true
  die "Tailscale-tjänsten kunde inte startas. Diagnostiken visas ovan."
fi

step "Skapar tjänstekonto och datakatalog"
getent group "${APP_GROUP}" >/dev/null || groupadd --system "${APP_GROUP}"
if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${APP_GROUP}" --home-dir "${STATE_DIR}" \
    --shell /usr/sbin/nologin "${APP_USER}"
fi
install -d -m 0750 -o "${APP_USER}" -g "${APP_GROUP}" \
  "${STATE_DIR}" "${STATE_DIR}/data" "${STATE_DIR}/config"

step "Installerar applikationsfiler"
source_real="$(realpath -m "${SOURCE_DIR}")"
app_real="$(realpath -m "${APP_DIR}")"
if [[ "${source_real}" != "${app_real}" ]]; then
  if [[ -d "${APP_DIR}" && ! -f "${APP_DIR}/.native-resursplanering" ]]; then
    backup_dir="${APP_DIR}.fore-native-$(date -u +%Y%m%dT%H%M%SZ)"
    mv "${APP_DIR}" "${backup_dir}"
    printf 'Tidigare innehåll sparades i %s\n' "${backup_dir}"
  fi
  install -d -m 0755 "${APP_DIR}"
  rsync -a --delete \
    --exclude node_modules --exclude dist --exclude .next \
    --exclude .wrangler --exclude .git \
    "${SOURCE_DIR}/" "${APP_DIR}/"
fi
touch "${APP_DIR}/.native-resursplanering"
chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"
install -d -m 0750 -o "${APP_USER}" -g "${APP_GROUP}" \
  "${APP_DIR}/selfhost/.wrangler/tmp"

step "Installerar beroenden och bygger applikationen"
runuser -u "${APP_USER}" -- env HOME="${STATE_DIR}" CI=true \
  pnpm --dir "${APP_DIR}" install --frozen-lockfile
runuser -u "${APP_USER}" -- env HOME="${STATE_DIR}" CI=true \
  pnpm --dir "${APP_DIR}" build

step "Skapar systemd-tjänsten"
cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Resursplanering
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=3000
Environment=DATA_DIR=${STATE_DIR}/data
Environment=HOME=${STATE_DIR}
Environment=XDG_CONFIG_HOME=${STATE_DIR}/config
Environment=CLOUDFLARE_CF_FETCH_ENABLED=false
Environment=WRANGLER_SEND_METRICS=false
Environment=WRANGLER_WRITE_LOGS=false
ExecStart=/usr/bin/node ${APP_DIR}/scripts/start-selfhosted.mjs
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${STATE_DIR} ${APP_DIR}/selfhost/.wrangler

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${APP_NAME}.service"
systemctl restart "${APP_NAME}.service"

step "Kontrollerar applikationen"
healthy=false
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 http://127.0.0.1:3000/api/data >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ ${healthy} != true ]]; then
  systemctl status --no-pager "${APP_NAME}.service" || true
  journalctl -u "${APP_NAME}.service" -n 100 --no-pager || true
  die "Applikationen startade inte. Diagnostiken visas ovan."
fi

step "Installerar inloggningsskydd"
apt-get install -y --no-install-recommends nginx apache2-utils

if [[ ! -s "${AUTH_FILE}" ]]; then
  [[ -r /dev/tty && -w /dev/tty ]] || \
    die "En interaktiv terminal krävs för att skapa inloggningen."

  read -r -p "Användarnamn för Resursplanering [admin]: " AUTH_USER </dev/tty
  AUTH_USER="${AUTH_USER:-admin}"
  [[ "${AUTH_USER}" =~ ^[A-Za-z0-9._-]+$ ]] || \
    die "Användarnamnet får bara innehålla bokstäver, siffror, punkt, bindestreck och understreck."

  read -r -s -p "Lösenord (minst 14 tecken): " AUTH_PASSWORD </dev/tty
  printf '\n' >/dev/tty
  read -r -s -p "Upprepa lösenordet: " AUTH_PASSWORD_CONFIRM </dev/tty
  printf '\n' >/dev/tty
  [[ ${#AUTH_PASSWORD} -ge 14 ]] || die "Lösenordet måste vara minst 14 tecken."
  [[ "${AUTH_PASSWORD}" == "${AUTH_PASSWORD_CONFIRM}" ]] || \
    die "Lösenorden stämmer inte överens."

  printf '%s\n' "${AUTH_PASSWORD}" | htpasswd -i -c -B "${AUTH_FILE}" "${AUTH_USER}" >/dev/null
  unset AUTH_PASSWORD AUTH_PASSWORD_CONFIRM
  chown root:www-data "${AUTH_FILE}"
  chmod 0640 "${AUTH_FILE}"
else
  printf 'Befintlig inloggning behålls för användaren %s.\n' "$(cut -d: -f1 "${AUTH_FILE}")"
fi

cat > "${NGINX_SITE}" <<'EOF'
server {
    listen 127.0.0.1:3001;
    server_name _;

    auth_basic "Resursplanering";
    auth_basic_user_file /etc/nginx/resursplanering.htpasswd;

    client_max_body_size 25m;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy same-origin always;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
    }
}
EOF

ln -sfn "${NGINX_SITE}" /etc/nginx/sites-enabled/resursplanering
if [[ -L /etc/nginx/sites-enabled/default ]]; then
  unlink /etc/nginx/sites-enabled/default
fi
nginx -t
systemctl enable nginx
systemctl restart nginx

auth_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3001/)"
[[ "${auth_status}" == "401" ]] || \
  die "Inloggningsskyddet svarade med HTTP ${auth_status}, förväntat svar är 401."

step "Ansluter Tailscale"
if ! tailscale ip -4 >/dev/null 2>&1; then
  printf 'Öppna Tailscale-länken som visas och godkänn servern.\n'
  tailscale up
fi

step "Aktiverar publik HTTPS med Tailscale Funnel"
tailscale funnel --bg --yes http://127.0.0.1:3001

printf '\nINSTALLATIONEN ÄR KLAR\n\n'
tailscale funnel status || true
printf '\nStatus: systemctl status %s\n' "${APP_NAME}"
printf 'Logg:   journalctl -u %s -f\n' "${APP_NAME}"
printf 'Data:   %s/data\n' "${STATE_DIR}"
