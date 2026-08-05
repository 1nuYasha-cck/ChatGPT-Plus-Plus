#!/bin/bash

set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"

IMAGE=""
THEME_NAME=""
TAGLINE=""
QUOTE=""
ACCENT="#7cff46"
SECONDARY="#36d7e8"
HIGHLIGHT="#642a8c"
APPLY_NOW="true"
RESET_DEMO="false"
SAVE_CUSTOM_THEME="false"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --image) IMAGE="${2:-}"; shift 2 ;;
    --name) THEME_NAME="${2:-}"; shift 2 ;;
    --tagline) TAGLINE="${2:-}"; shift 2 ;;
    --quote) QUOTE="${2:-}"; shift 2 ;;
    --accent) ACCENT="${2:-}"; shift 2 ;;
    --secondary) SECONDARY="${2:-}"; shift 2 ;;
    --highlight) HIGHLIGHT="${2:-}"; shift 2 ;;
    --no-apply) APPLY_NOW="false"; shift ;;
    --reset-demo) RESET_DEMO="true"; shift ;;
    *) fail "Unknown customize argument: $1" ;;
  esac
done

discover_codex_app
require_macos_runtime
ensure_state_root

save_active_custom_theme() {
  local themes_root="$STATE_ROOT/themes"
  local theme_id=""
  local theme_name=""
  local theme_image=""
  local destination=""
  local staging=""

  [ -f "$THEME_DIR/theme.json" ] && [ ! -L "$THEME_DIR/theme.json" ] \
    || fail "Active theme metadata is missing or unsafe; nothing was saved."
  theme_id="$("$NODE" -e 'try{const t=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(t.id||"")}catch{}' "$THEME_DIR/theme.json")"
  theme_name="$("$NODE" -e 'try{const t=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(t.name||"")}catch{}' "$THEME_DIR/theme.json")"
  theme_image="$("$NODE" -e 'try{const t=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(t.image||"")}catch{}' "$THEME_DIR/theme.json")"
  case "$theme_id" in
    custom-[0-9]*) ;;
    *) fail "Active custom theme has an invalid ID; nothing was saved." ;;
  esac
  case "$theme_image" in
    ''|.|..|*/*|*'\\'*|*$'\n'*|*$'\r'*) fail "Active theme image name is unsafe; nothing was saved." ;;
  esac
  [ -f "$THEME_DIR/$theme_image" ] && [ ! -L "$THEME_DIR/$theme_image" ] \
    || fail "Active theme image is missing or unsafe; nothing was saved."

  /bin/mkdir -p "$themes_root"
  /bin/chmod 700 "$themes_root"
  destination="$themes_root/$theme_id"
  [ ! -e "$destination" ] || fail "A saved theme already has this ID; nothing was overwritten."
  staging="$(/usr/bin/mktemp -d "$themes_root/.theme-save.XXXXXX")"
  cleanup_saved_theme() { [ -z "${staging:-}" ] || /bin/rm -rf "$staging"; }
  trap cleanup_saved_theme RETURN
  /bin/chmod 700 "$staging"
  /bin/cp "$THEME_DIR/theme.json" "$THEME_DIR/$theme_image" "$staging/"
  /bin/chmod 600 "$staging"/*
  /bin/mv "$staging" "$destination"
  staging=""
  trap - RETURN
  [ -n "$theme_name" ] || theme_name="$theme_id"
  printf 'Saved theme: %s\n' "$theme_name"
}

if [ "$RESET_DEMO" = "true" ]; then
  "$NODE" "$SCRIPT_DIR/write-theme.mjs" reset-demo --output-dir "$THEME_DIR"
else
  if [ -z "$IMAGE" ]; then
    IMAGE="$(/usr/bin/osascript -e 'POSIX path of (choose file with prompt "选择一张主题图片（建议横向、宽度 2000px 以上）" of type {"public.image"})')" \
      || fail "Image selection was cancelled."
  fi
  [ -f "$IMAGE" ] || fail "Selected image does not exist: $IMAGE"
  SOURCE_BYTES="$(/usr/bin/stat -f '%z' "$IMAGE")"
  [ "$SOURCE_BYTES" -le 52428800 ] || fail "Selected image is larger than 50 MB. Choose a smaller file."

  if [ -z "$THEME_NAME" ]; then
    THEME_NAME="$(/usr/bin/osascript -e 'text returned of (display dialog "给这套主题起个名字" default answer "我的 Codex Dream Skin" buttons {"取消", "继续"} default button "继续")')" \
      || fail "Theme setup was cancelled."
  fi
  if [ -z "$TAGLINE" ]; then TAGLINE="把喜欢的画面变成可交互的 Codex 工作台。"; fi
  if [ -z "$QUOTE" ]; then QUOTE="MAKE SOMETHING WONDERFUL"; fi

  /bin/mkdir -p "$THEME_DIR"
  /bin/chmod 700 "$THEME_DIR"
  image_name="background-$(/bin/date '+%Y%m%d-%H%M%S')-$$.jpg"
  temporary="$THEME_DIR/.${image_name}.tmp.jpg"
  prepared="$THEME_DIR/$image_name"
  cleanup_temporary() { /bin/rm -f "$temporary"; }
  trap cleanup_temporary EXIT
  /usr/bin/sips -s format jpeg -s formatOptions 84 -Z 3200 "$IMAGE" --out "$temporary" >/dev/null \
    || fail "macOS could not convert the selected image. Use PNG, JPEG, HEIC, TIFF, or WebP."
  [ -s "$temporary" ] || fail "The converted image is empty."
  PREPARED_BYTES="$(/usr/bin/stat -f '%z' "$temporary")"
  [ "$PREPARED_BYTES" -le 16777216 ] || fail "The prepared image is larger than 16 MB. Choose a simpler or smaller image."
  /bin/mv -f "$temporary" "$prepared"
  /bin/chmod 600 "$prepared"

  "$NODE" "$SCRIPT_DIR/write-theme.mjs" custom \
    --output-dir "$THEME_DIR" --image "$image_name" \
    --name "$THEME_NAME" --tagline "$TAGLINE" --quote "$QUOTE" \
    --accent "$ACCENT" --secondary "$SECONDARY" --highlight "$HIGHLIGHT"
  /usr/bin/find "$THEME_DIR" -maxdepth 1 -type f -name 'background-*' ! -name "$image_name" -delete
  trap - EXIT
  SAVE_CUSTOM_THEME="true"
fi

if [ "$APPLY_NOW" = "true" ]; then
  "$SCRIPT_DIR/start-dream-skin-macos.sh" --port 9341 --prompt-restart
  if [ "$SAVE_CUSTOM_THEME" = "true" ]; then
    save_active_custom_theme
  fi
fi

printf 'Codex Dream Skin Studio theme is ready.\n'
