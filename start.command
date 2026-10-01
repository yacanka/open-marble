#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHARP_DIR="$ROOT_DIR/Apple-Sharp-Image-to-3D-View-Synthesis"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
SUPERSPLAT_DIR="$ROOT_DIR/supersplat"
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openmarble.XXXXXX")"

PIDS=()
NAMES=()
LOG_FILES=()
LAST_LOG_FILE=""

info() {
  printf '\n[%s] %s\n' "OpenMarble" "$1"
}

die() {
  printf '\n[OpenMarble] HATA: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$2"
}

http_ok() {
  curl --fail --silent --show-error --max-time 3 "$1" >/dev/null 2>&1
}

http_body_contains() {
  local body
  body="$(curl --fail --silent --show-error --max-time 3 "$1" 2>/dev/null)" || return 1
  [[ "$body" == *"$2"* ]]
}

port_is_listening() {
  command -v lsof >/dev/null 2>&1 &&
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

ensure_port_available() {
  local port="$1"
  local service="$2"

  if port_is_listening "$port"; then
    die "$service başlatılamadı; $port portu başka bir süreç tarafından kullanılıyor. Süreci kapatıp tekrar deneyin."
  fi
}

start_service() {
  local name="$1"
  local directory="$2"
  shift 2

  local safe_name
  local log_file
  safe_name="$(printf '%s' "$name" | tr '[:upper:] ' '[:lower:]-')"
  log_file="$LOG_DIR/$safe_name.log"

  (
    cd "$directory"
    exec "$@"
  ) >"$log_file" 2>&1 &

  PIDS+=("$!")
  NAMES+=("$name")
  LOG_FILES+=("$log_file")
  LAST_LOG_FILE="$log_file"
  printf '[OpenMarble] %s başlatılıyor (PID %s).\n' "$name" "$!"
}

print_log_tail() {
  local name="$1"
  local log_file="$2"

  printf '\n--- %s son çıktısı ---\n' "$name" >&2
  tail -n 80 "$log_file" >&2 || true
  printf '%s\n' '------------------------' >&2
}

wait_for_http() {
  local name="$1"
  local url="$2"
  local log_file="$3"
  local timeout_seconds="${4:-120}"
  local elapsed=0

  while ((elapsed < timeout_seconds)); do
    if http_ok "$url"; then
      printf '[OpenMarble] %s hazır.\n' "$name"
      return 0
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done

  print_log_tail "$name" "$log_file"
  die "$name $timeout_seconds saniye içinde hazır olmadı. Tam log: $log_file"
}

wait_for_backend() {
  local log_file="$1"
  local timeout_seconds="${2:-120}"
  local elapsed=0

  while ((elapsed < timeout_seconds)); do
    if http_body_contains "http://127.0.0.1:8000/api/health" '"gradio_connected":true'; then
      printf '[OpenMarble] Backend hazır ve SHARP bağlantısı aktif.\n'
      return 0
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done

  print_log_tail "Backend" "$log_file"
  die "Backend SHARP bağlantısını $timeout_seconds saniye içinde kuramadı. Tam log: $log_file"
}

cleanup() {
  local exit_code=$?
  local index

  trap - EXIT INT TERM

  if ((${#PIDS[@]} > 0)); then
    printf '\n[OpenMarble] Başlatılan servisler durduruluyor...\n'
    for ((index = 0; index < ${#PIDS[@]}; index++)); do
      kill "${PIDS[$index]}" >/dev/null 2>&1 || true
    done
    for ((index = 0; index < ${#PIDS[@]}; index++)); do
      wait "${PIDS[$index]}" >/dev/null 2>&1 || true
    done
  fi

  printf '[OpenMarble] Loglar: %s\n' "$LOG_DIR"

  if ((exit_code != 0 && exit_code != 130)) && [[ -t 0 ]]; then
    printf '[OpenMarble] Kapatmak için Enter tuşuna basın.'
    read -r _ || true
  fi

  exit "$exit_code"
}

handle_signal() {
  exit 130
}

trap cleanup EXIT
trap handle_signal INT TERM

# Finder'dan açılan .command dosyalarında kullanıcıya ait bin dizini PATH'te
# olmayabilir. uv'nin varsayılan kurulum konumunu güvenli şekilde ekle.
if [[ -d "$HOME/.local/bin" ]] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

require_command curl "curl bulunamadı. macOS Command Line Tools kurulumunu kontrol edin."
require_command npm "npm bulunamadı. Önce Node.js 22 veya daha yeni bir sürüm kurun."
require_command uv "uv bulunamadı. Kurulum için: curl -LsSf https://astral.sh/uv/install.sh | sh"

info "Bağımlılıklar kontrol ediliyor"

if [[ ! -x "$FRONTEND_DIR/node_modules/.bin/next" ]]; then
  info "Frontend bağımlılıkları kuruluyor"
  (cd "$FRONTEND_DIR" && npm install --no-audit --no-fund)
fi

if [[ ! -x "$SUPERSPLAT_DIR/node_modules/.bin/rollup" ]] ||
  [[ ! -x "$SUPERSPLAT_DIR/node_modules/.bin/serve" ]]; then
  info "SuperSplat bağımlılıkları kuruluyor"
  (cd "$SUPERSPLAT_DIR" && npm install --no-audit --no-fund)
fi

info "SHARP Python ortamı eşitleniyor"
uv sync --project "$SHARP_DIR" --locked

if [[ ! -x "$BACKEND_DIR/.venv/bin/python" ]]; then
  info "Backend Python ortamı oluşturuluyor"
  uv venv "$BACKEND_DIR/.venv" --python 3.13
fi

info "Backend bağımlılıkları eşitleniyor"
uv pip install --python "$BACKEND_DIR/.venv/bin/python" \
  --requirements "$BACKEND_DIR/requirements.txt"

info "SuperSplat derleniyor"
(cd "$SUPERSPLAT_DIR" && npm run build)

info "Servisler başlatılıyor"

if http_ok "http://127.0.0.1:7860/"; then
  printf '[OpenMarble] Mevcut SHARP servisi kullanılıyor.\n'
else
  ensure_port_available 7860 "SHARP"
  start_service \
    "SHARP" \
    "$SHARP_DIR" \
    env "MPLCONFIGDIR=$LOG_DIR/matplotlib" \
    "$SHARP_DIR/.venv/bin/python" app.py
  wait_for_http "SHARP" "http://127.0.0.1:7860/" "$LAST_LOG_FILE" 180
fi

if http_body_contains "http://127.0.0.1:8000/api/health" '"gradio_connected":true'; then
  printf '[OpenMarble] Mevcut backend servisi kullanılıyor.\n'
else
  ensure_port_available 8000 "Backend"
  start_service \
    "Backend" \
    "$BACKEND_DIR" \
    "$BACKEND_DIR/.venv/bin/python" -m uvicorn main:app \
    --host 127.0.0.1 --port 8000
  wait_for_backend "$LAST_LOG_FILE" 120
fi

if http_ok "http://127.0.0.1:3090/"; then
  printf '[OpenMarble] Mevcut SuperSplat servisi kullanılıyor.\n'
else
  ensure_port_available 3090 "SuperSplat"
  start_service \
    "SuperSplat" \
    "$SUPERSPLAT_DIR" \
    "$SUPERSPLAT_DIR/node_modules/.bin/serve" dist -l 3090 -C
  wait_for_http "SuperSplat" "http://127.0.0.1:3090/" "$LAST_LOG_FILE" 60
fi

if http_ok "http://127.0.0.1:3080/openmarble"; then
  printf '[OpenMarble] Mevcut frontend servisi kullanılıyor.\n'
else
  ensure_port_available 3080 "Frontend"
  start_service \
    "Frontend" \
    "$FRONTEND_DIR" \
    env \
    NEXT_PUBLIC_URL=http://localhost:3080 \
    NEXT_PUBLIC_BACKEND_URL=http://localhost:8000 \
    NEXT_PUBLIC_SUPERSPLAT_URL=http://localhost:3090 \
    "$FRONTEND_DIR/node_modules/.bin/next" dev -p 3080 --turbo
  wait_for_http "Frontend" "http://127.0.0.1:3080/openmarble" "$LAST_LOG_FILE" 180
fi

printf '\n'
printf '%s\n' '============================================================'
printf '%s\n' ' OpenMarble hazır: http://localhost:3080/openmarble'
printf '%s\n' ' Durdurmak için bu pencerede Control+C tuşlarına basın.'
printf '%s\n' '============================================================'

if [[ "${OPEN_BROWSER:-1}" == "1" ]]; then
  if command -v open >/dev/null 2>&1; then
    open "http://localhost:3080/openmarble"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:3080/openmarble" >/dev/null 2>&1 || true
  fi
fi

while true; do
  for ((index = 0; index < ${#PIDS[@]}; index++)); do
    if ! kill -0 "${PIDS[$index]}" >/dev/null 2>&1; then
      print_log_tail "${NAMES[$index]}" "${LOG_FILES[$index]}"
      die "${NAMES[$index]} beklenmedik şekilde durdu."
    fi
  done
  sleep 2
done
