#!/usr/bin/env bash
# Uploads your installed Caesar III folder (without the intro videos) to the private R2 bucket.
# Usage: web/upload-game-data.sh "/path/to/Caesar 3" [bucket-name]
# Needs: Node.js, and `npx wrangler login` done once (or CLOUDFLARE_API_TOKEN set).
set -euo pipefail

SOURCE="${1:?Usage: $0 <caesar3-folder> [bucket-name]}"
BUCKET="${2:-augustus-c3-data}"
[ -f "$SOURCE/c3.sg2" ] || [ -f "$SOURCE/C3.sg2" ] || [ -f "$SOURCE/C3.SG2" ] || {
    echo "No c3.sg2 in '$SOURCE'. Point this at the folder that directly contains the game files." >&2
    exit 1
}

cd "$SOURCE"
count=0
while IFS= read -r -d '' file; do
    rel="${file#./}"
    lower="$(printf '%s' "$rel" | tr '[:upper:]' '[:lower:]')"
    case "$lower" in
        smk/*|*/smk/*) continue ;;                  # intro and mission videos, not needed
        *.exe|*.dll|*.pdf|*.ico|*.url|*.lnk|*.inf|*.ini) continue ;;
        goggame*|unins*|webcache*|*/goggame*|*/unins*|*/webcache*) continue ;;
    esac
    echo "Uploading $rel"
    npx --yes wrangler@4 r2 object put "$BUCKET/c3/$rel" --file "$file" --remote
    count=$((count + 1))
done < <(find . -type f -print0)
echo "Done: $count files uploaded to $BUCKET"
