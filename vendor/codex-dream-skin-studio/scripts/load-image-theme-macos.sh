#!/bin/bash

# Dynamically load one pure image as the active theme.
# Hot-applies when CDP is already open (fast).

set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"

IMAGE=""
THEME_NAME=""
FROM_LIBRARY=""
APPLY_NOW="true"
APPEARANCE="auto"
SAFE_AREA="auto"
TASK_MODE="auto"
FOCUS_X=""
FOCUS_Y=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --file) IMAGE="${2:-}"; shift 2 ;;
    --from-library) FROM_LIBRARY="${2:-}"; shift 2 ;;
    --name) THEME_NAME="${2:-}"; shift 2 ;;
    --appearance) APPEARANCE="${2:-}"; shift 2 ;;
    --safe-area) SAFE_AREA="${2:-}"; shift 2 ;;
    --task-mode) TASK_MODE="${2:-}"; shift 2 ;;
    --focus-x) FOCUS_X="${2:-}"; shift 2 ;;
    --focus-y) FOCUS_Y="${2:-}"; shift 2 ;;
    --no-apply) APPLY_NOW="false"; shift ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

case "$APPEARANCE" in auto|light|dark) ;; *) fail "Invalid appearance: $APPEARANCE" ;; esac
case "$SAFE_AREA" in auto|left|right|center|none) ;; *) fail "Invalid safe area: $SAFE_AREA" ;; esac
case "$TASK_MODE" in auto|ambient|banner|off) ;; *) fail "Invalid task mode: $TASK_MODE" ;; esac

ensure_state_root
IMAGES_DIR="$STATE_ROOT/images"
THEMES_ROOT="$STATE_ROOT/themes"
ensure_private_directory "$IMAGES_DIR" "Theme source image directory"
ensure_private_directory "$THEMES_ROOT" "Saved themes directory"
ensure_private_directory "$THEME_DIR" "Active theme directory"

if [ -n "$FROM_LIBRARY" ]; then
  [ "$(/usr/bin/basename "$FROM_LIBRARY")" = "$FROM_LIBRARY" ] \
    || fail "Library image must be a filename, not a path."
  case "$FROM_LIBRARY" in
    *$'\n'*|*$'\r'*|*'|'*|*'"'*|*'\'*) fail "Unsafe library image filename." ;;
  esac
  IMAGE="$IMAGES_DIR/$FROM_LIBRARY"
fi

[ -n "$IMAGE" ] || fail "Pass --file <image> or --from-library <name-in-images-dir>"
[ -f "$IMAGE" ] || fail "Image not found: $IMAGE"
[ ! -L "$IMAGE" ] || fail "Theme source image must not be a symbolic link."

case "$IMAGE" in
  *.png|*.PNG|*.jpg|*.JPG|*.jpeg|*.JPEG|*.webp|*.WEBP|*.heic|*.HEIC|*.tif|*.tiff|*.TIF|*.TIFF) ;;
  *) fail "Unsupported image type: $IMAGE" ;;
esac

SOURCE_BYTES="$(/usr/bin/stat -f '%z' "$IMAGE")"
[ "$SOURCE_BYTES" -le 52428800 ] || fail "Image larger than 50 MB."

if [ -z "$THEME_NAME" ]; then
  base="$(/usr/bin/basename "$IMAGE")"
  THEME_NAME="${base%.*}"
fi
[ -n "$THEME_NAME" ] || THEME_NAME="我的主题"

theme_id="img-$(/bin/date '+%Y%m%d%H%M%S')-$$-${RANDOM:-0}"

progress() {
  printf '%s\n' "$*" >&2
  notify_user "$*"
}

progress "Loading image..."

# Fast Node for write-theme (avoid full codesign when possible)
ensure_node_runtime

image_name="background-${theme_id}.jpg"
temporary="$THEME_DIR/.background.$$.tmp.jpg"
rendered="$THEME_DIR/.background.$$.rendered.jpg"
prepared="$THEME_DIR/$image_name"
cleanup_temporary() { /bin/rm -f "$temporary" "$rendered"; }
trap cleanup_temporary EXIT

# Normalize every new theme to one predictable 16:9 canvas without stretching.
# Landscape art is cover-cropped; square/portrait art keeps its complete subject
# over a blurred fill. The original selected image is archived below.
PREPARE_OUTPUT="$(/usr/bin/osascript -l JavaScript \
  "$SCRIPT_DIR/prepare-theme-image.jxa" "$IMAGE" "$rendered")" \
  || fail "Could not prepare image. Use PNG/JPEG/HEIC/TIFF/WebP."
/usr/bin/sips -s format jpeg -s formatOptions 85 -z 1440 2560 \
  "$rendered" --out "$temporary" >/dev/null \
  || fail "Could not finalize the 2560x1440 theme image."
[ -s "$temporary" ] || fail "Prepared image is empty."
PREPARED_WIDTH="$(/usr/bin/sips -g pixelWidth "$temporary" 2>/dev/null | /usr/bin/awk '/pixelWidth:/{print $2}')"
PREPARED_HEIGHT="$(/usr/bin/sips -g pixelHeight "$temporary" 2>/dev/null | /usr/bin/awk '/pixelHeight:/{print $2}')"
[ "$PREPARED_WIDTH" = "2560" ] && [ "$PREPARED_HEIGHT" = "1440" ] \
  || fail "Prepared image must be exactly 2560x1440."
case "$PREPARE_OUTPUT" in
  *'"lowResolution":true'*) progress "Warning: source image needs more than 1.5x enlargement and may look soft." ;;
esac
PREPARED_BYTES="$(/usr/bin/stat -f '%z' "$temporary")"
[ "$PREPARED_BYTES" -le 16777216 ] || fail "Prepared image larger than 16 MB."
/bin/chmod 600 "$temporary"
/bin/mv -f "$temporary" "$prepared"
/bin/rm -f "$rendered"

theme_args=(
  custom
  --output-dir "$THEME_DIR"
  --id "$theme_id"
  --image "$image_name"
  --name "$THEME_NAME"
  --tagline "Make something wonderful."
  --quote "MAKE SOMETHING WONDERFUL"
  --appearance "$APPEARANCE"
  --safe-area "$SAFE_AREA"
  --task-mode "$TASK_MODE"
)
[ -n "$FOCUS_X" ] && theme_args+=(--focus-x "$FOCUS_X")
[ -n "$FOCUS_Y" ] && theme_args+=(--focus-y "$FOCUS_Y")
"$NODE" "$SCRIPT_DIR/write-theme.mjs" "${theme_args[@]}" >/dev/null
/usr/bin/find "$THEME_DIR" -maxdepth 1 -type f -name 'background.*' ! -name "$image_name" -delete
trap - EXIT

lib_dir="$THEMES_ROOT/$theme_id"
[ ! -e "$lib_dir" ] && [ ! -L "$lib_dir" ] || fail "Generated theme ID already exists; retry creation."
lib_stage="$(/usr/bin/mktemp -d "$THEMES_ROOT/.theme-create.XXXXXX")"
cleanup_library_stage() { [ -z "${lib_stage:-}" ] || /bin/rm -rf "$lib_stage"; }
trap cleanup_library_stage EXIT
/bin/chmod 700 "$lib_stage"
/bin/cp "$THEME_DIR/$image_name" "$lib_stage/$image_name"
/bin/cp "$THEME_DIR/theme.json" "$lib_stage/theme.json"
/bin/chmod 600 "$lib_stage/$image_name" "$lib_stage/theme.json"
/bin/mv "$lib_stage" "$lib_dir"
lib_stage=""
trap - EXIT

if [ -z "$FROM_LIBRARY" ]; then
  original_basename="$(/usr/bin/basename "$IMAGE")"
  original_extension="${original_basename##*.}"
  dest_lib_img="$IMAGES_DIR/${theme_id}-original.${original_extension}"
  /bin/cp -f "$IMAGE" "$dest_lib_img" 2>/dev/null || true
fi

if [ "$APPLY_NOW" != "true" ]; then
  progress "Ready: ${THEME_NAME} (not applied)"
  exit 0
fi

PORT=9341
if [ -f "$STATE_PATH" ]; then
  saved="$(state_field port 2>/dev/null || true)"
  [ -n "${saved:-}" ] && PORT="$saved"
fi

progress "Hot reapply..."
if hot_reapply_theme "$PORT" 8000; then
  progress "Done: ${THEME_NAME}"
  exit 0
fi

progress "CDP not ready, full start..."
if "$SCRIPT_DIR/start-dream-skin-macos.sh" --port "$PORT" --prompt-restart; then
  progress "Done: ${THEME_NAME}"
  exit 0
fi

alert_user "Image saved but inject failed. Click Apply Skin."
exit 1
