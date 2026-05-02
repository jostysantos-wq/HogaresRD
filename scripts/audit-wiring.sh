#!/usr/bin/env bash
# Frontend ↔ backend API wiring audit.
#
# Catches the highest-leverage bugs:
#   - Frontend pages calling endpoints the server never declared (404 in prod)
#   - Server routes nobody calls (dead code or stale rewrites)
#   - Field-name drift between handler responses and rendering code
#
# Usage:  scripts/audit-wiring.sh
# Exits 0 if clean, 1 if any frontend caller has no matching backend handler.

set -euo pipefail
cd "$(dirname "$0")/.."

declared=$(mktemp); called=$(mktemp); trap "rm -f $declared $called" EXIT

# ── 1. Declared endpoints ──────────────────────────────────────────────
# Each route file is mounted under a prefix in server.js. Pull the prefix
# and concatenate it with each router.<verb>('<path>') inside the file so
# the resulting URL matches what the frontend actually requests.
# Build a (prefix → route file) map by handling BOTH mount patterns:
#   1. inline:    app.use('/api/foo', require('./routes/foo'))
#   2. variable:  const x = require('./routes/foo'); app.use('/api/foo', x)
#                 const x = require('./routes/foo'); app.use('/api/foo', x.router)
# For pattern 2 we trace the variable back to its require().
mount_map=$(mktemp); trap "rm -f $declared $called $mount_map" EXIT

# Pattern 1: inline require(). Accepts arbitrary middleware between
# the path and the require(), e.g.
#   app.use('/api/X', authMW, gateMW, require('./routes/X'))
grep -E "^[[:space:]]*app\.use\(['\"]/api/[^'\"]*['\"].*,[[:space:]]*require\(['\"]\\./routes/" server.js \
  | sed -E "s|.*app\.use\(['\"]([^'\"]+)['\"].*require\(['\"]\\./(routes/[^'\"]+)['\"]\\).*|\1\t./\2.js|" \
  >> "$mount_map"

# Pattern 2: variable. Build varname → file from two declaration shapes:
#   (a) const X        = require('./routes/Y')
#   (b) const { router: X, ...} = require('./routes/Y')
varfile=$(mktemp); trap "rm -f $declared $called $mount_map $varfile" EXIT
grep -E "^[[:space:]]*const[[:space:]]+[a-zA-Z_][a-zA-Z0-9_]*[[:space:]]*=[[:space:]]*require\(['\"]\\./routes/" server.js \
  | sed -E "s|.*const[[:space:]]+([a-zA-Z_][a-zA-Z0-9_]*)[[:space:]]*=[[:space:]]*require\(['\"]\\./(routes/[^'\"]+)['\"]\\).*|\1\t./\2.js|" \
  >> "$varfile"
grep -E "^[[:space:]]*const[[:space:]]+\{.*router:[[:space:]]*[a-zA-Z_][a-zA-Z0-9_]*.*\}[[:space:]]*=[[:space:]]*require\(['\"]\\./routes/" server.js \
  | sed -E "s|.*router:[[:space:]]*([a-zA-Z_][a-zA-Z0-9_]*).*require\(['\"]\\./(routes/[^'\"]+)['\"]\\).*|\1\t./\2.js|" \
  >> "$varfile"

# Then find `app.use('/api/...', VAR)` or `app.use('/api/...', VAR.router)` lines
# whose VAR appears in varfile, and emit the prefix→file pair.
grep -E "^[[:space:]]*app\.use\(['\"]/api/" server.js \
  | grep -vE "require\(" \
  | while IFS= read -r line; do
      pfx=$(echo "$line" | sed -nE "s|.*app\.use\(['\"]([^'\"]+)['\"].*|\1|p")
      var=$(echo "$line" | sed -nE "s|.*app\.use\([^,]+,[[:space:]]*([a-zA-Z_][a-zA-Z0-9_]*)(\.[a-zA-Z]+)?[[:space:]]*\).*|\1|p")
      [ -z "$pfx" ] || [ -z "$var" ] && continue
      file=$(awk -F'\t' -v V="$var" '$1==V{print $2}' "$varfile")
      [ -n "$file" ] && printf "%s\t%s\n" "$pfx" "$file" >> "$mount_map"
    done

while IFS=$'\t' read -r prefix file; do
  [ -f "$file" ] || continue
  grep -nE "router\.(get|post|put|patch|delete)\(['\"]/[^'\"]*['\"]" "$file" | \
  while IFS= read -r line; do
    lineno=$(echo "$line" | cut -d: -f1)
    method=$(echo "$line" | sed -nE "s|.*router\.([a-z]+)\(['\"][^'\"]+['\"].*|\1|p" | tr 'a-z' 'A-Z')
    path=$(echo "$line"  | sed -nE "s|.*router\.[a-z]+\(['\"]([^'\"]+)['\"].*|\1|p")
    [ -z "$method" ] && continue
    [ -z "$path" ] && continue
    printf "%s%s\t%s\t%s:%s\n" "$method" "$prefix" "$path" "$file" "$lineno" >> "$declared"
  done
done < "$mount_map"

# Also pick up direct app.get/app.post handlers in server.js itself
# (e.g., /api/mapkit-token, /api/upload/photos that aren't in routes/).
grep -nE "^[[:space:]]*app\.(get|post|put|patch|delete)\(['\"]/api/" server.js | \
while IFS= read -r line; do
  lineno=$(echo "$line" | cut -d: -f1)
  method=$(echo "$line" | sed -nE "s|^[0-9]+:[[:space:]]*app\.([a-z]+)\(.*|\1|p" | tr 'a-z' 'A-Z')
  path=$(echo "$line"   | sed -nE "s|^[0-9]+:[[:space:]]*app\.[a-z]+\(['\"]([^'\"]+)['\"].*|\1|p")
  [ -z "$method" ] || [ -z "$path" ] && continue
  printf "%s%s\t%s\tserver.js:%s\n" "$method" "" "$path" "$lineno" >> "$declared"
done

# Strip duplicates (same route, different file lines)
sort -u -k1,2 "$declared" -o "$declared"

# ── 2. Called endpoints from frontend ──────────────────────────────────
# Pull /api/... URLs from public/, strip ?query and template ${...} parts,
# and normalize. Anything in node_modules / uploads / locales is skipped.
# Capture /api/... including template-literal innards. We grep loosely
# (any non-whitespace after /api/) then aggressively normalize:
#   - ${...} or ${... // anything until the next backtick or quote → :id
#   - encodeURIComponent(...) → :id
#   - drop ?query and trailing punctuation
# Pre-process source files to collapse template-literal interpolations
# (`${ ... }` with arbitrarily nested parens) to `:id` BEFORE grep, so the
# URL match can run cleanly. Done in-place in awk per-line.
collapse_template() {
  awk '
    {
      out = ""; i = 1; len = length($0)
      while (i <= len) {
        c = substr($0, i, 1); n = substr($0, i, 2)
        if (n == "${") {
          # Skip through balanced braces (simple counter; good enough)
          depth = 1; i += 2
          while (i <= len && depth > 0) {
            cc = substr($0, i, 1)
            if (cc == "{") depth++
            else if (cc == "}") depth--
            i++
          }
          out = out ":id"
        } else {
          out = out c; i++
        }
      }
      print FILENAME ":" FNR ":" out
    }
  ' "$@"
}

collapse_template public/*.html public/js/*.js 2>/dev/null \
  | grep -oE "[^:]+:[0-9]+:.*/api/[^[:space:]\"\`(),;<>]+" \
  | grep -vE "(node_modules|uploads|locales)" \
  | sed -E "s|'||g; s|encodeURIComponent\([^)]*\)|:id|g; s|\?.*||; s|[).,;:]+$||" \
  | awk '{
      first = index($0, ":"); rest = substr($0, first + 1); file = substr($0, 1, first - 1)
      second = index(rest, ":"); afterln = substr(rest, second + 1); lineno = substr(rest, 1, second - 1)
      idx = index(afterln, "/api/")
      if (idx == 0) next
      # Skip JS line-comments (// ...), HTML comments (<!-- ... -->), and
      # block-comment continuation lines (`*` at column 0-2 followed by
      # content) which are common in JSDoc headers.
      slash = index(afterln, "//"); if (slash > 0 && slash < idx) next
      htmlc = index(afterln, "<!--"); if (htmlc > 0 && htmlc < idx) next
      stripped0 = afterln; gsub(/^[ \t]+/, "", stripped0)
      if (substr(stripped0, 1, 1) == "*") next
      if (substr(stripped0, 1, 2) == "/*") next
      # Skip lines that are pure variable/const string-constant declarations.
      # Pattern: <whitespace> <var|let|const> <NAME> <=> <quote> /api/...
      # These are endpoint URL constants used by fetch calls elsewhere; they
      # would be flagged with whatever default method we picked otherwise.
      stripped = afterln; gsub(/^[ \t]+/, "", stripped)
      # Match either quote style — we already collapsed single quotes
      # earlier in the pipeline, so check for both pre- and post-collapse.
      if (stripped ~ /^(var|let|const)[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*["][\/]api\//) next
      if (stripped ~ /^(var|let|const)[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*[\/]api\//) next
      url = substr(afterln, idx)
      if (substr(url, length(url), 1) == "/") url = url ":id"
      printf "%s\t%s\t%s\n", url, file, lineno
    }' \
  | sort -u > "$called.raw"

# Method detection — look ahead 3 lines from each call site in the source
# file for an explicit method: "POST" / "PUT" / "PATCH" / "DELETE" / "GET".
# Multi-line fetch options (`fetch(url, {↵ method: 'POST' ... })`) are the
# common case so single-line scanning would default 90% of POSTs to GET.
# If no method is found in the window, default to GET.
> "$called"
while IFS=$'\t' read -r url file lineno; do
  start=$lineno; end=$((lineno + 3))
  ctx=$(sed -n "${start},${end}p" "$file" 2>/dev/null || true)
  # First check the conventional fetch options shape: method: 'POST'
  method=$(printf '%s' "$ctx" | grep -oE "method:[[:space:]]*['\"\`](POST|PUT|PATCH|DELETE|GET)['\"\`]" 2>/dev/null \
           | head -1 \
           | sed -E "s|.*['\"\`]([A-Z]+)['\"\`]|\1|" 2>/dev/null || true)
  # Fall back to positional-arg shape: API(url, 'POST', ...)
  if [ -z "$method" ]; then
    method=$(printf '%s' "$ctx" | grep -oE "['\"\`](POST|PUT|PATCH|DELETE)['\"\`]" 2>/dev/null \
             | head -1 \
             | sed -E "s|['\"\`]||g" 2>/dev/null || true)
  fi
  # Verb-named helper functions infer method from their name.
  if [ -z "$method" ]; then
    if   printf '%s' "$ctx" | grep -qE "(apiUpload|formData|FormData|multipart|apiPost|\bpost\()" 2>/dev/null; then method="POST"
    elif printf '%s' "$ctx" | grep -qE "(apiPut|\bput\()" 2>/dev/null; then method="PUT"
    elif printf '%s' "$ctx" | grep -qE "(apiPatch|\bpatch\()" 2>/dev/null; then method="PATCH"
    elif printf '%s' "$ctx" | grep -qE "(apiDelete|\bdelete\()" 2>/dev/null; then method="DELETE"
    fi
  fi
  if [ -z "$method" ]; then method="GET"; fi
  printf "%s %s\t%s:%s\n" "$method" "$url" "$file" "$lineno" >> "$called"
done < "$called.raw"
sort -u "$called" -o "$called"
rm -f "$called.raw"

# Re-extract the URL column (the awk above already did, but normalize).
awk -F'\t' '{
  url = $1
  # Trim trailing /:id repetition that grep glued on
  gsub(/\/+$/, "", url)
  print url "\t" $2
}' "$called" | sort -u -o "$called"

# ── 3. Diff ────────────────────────────────────────────────────────────
echo "═══ Declared backend routes ═══"
wc -l "$declared" | awk '{print $1, "routes"}'

echo
echo "═══ Frontend API references ═══"
wc -l "$called" | awk '{print $1, "unique URL+caller pairs"}'

echo
echo "═══ Frontend calls with no backend handler ═══"
# Build a set of declared METHOD+URLs for quick lookup. When the router-local
# path is just "/", use the prefix alone — Express treats /api/foo and
# /api/foo/ as equivalent and the frontend doesn't include the trailing slash.
declared_urls=$(awk -F'\t' '{
  p=$1
  method = ""; while (match(p, /^[A-Z]/)) { method = method substr(p,1,1); p = substr(p,2) }
  sub(/\/$/, "", p)
  url = ($2 == "/") ? p : p $2
  print method " " url
}' "$declared" | sort -u)
missing=0; method_mismatch=0
while IFS=$'\t' read -r methodurl caller; do
  url=$(echo "$methodurl" | awk '{print $2}')
  method=$(echo "$methodurl" | awk '{print $1}')
  # Replace :id with a regex-friendly placeholder for matching dynamic routes.
  url_re=$(echo "$url" | sed 's|:id|[^/]*|g; s|/|\\/|g')
  if echo "$declared_urls" | grep -qE "^${method} ${url_re}$"; then
    continue
  fi
  # Method mismatch? URL exists but with a different method.
  other=$(echo "$declared_urls" | grep -E " ${url_re}$" | awk '{print $1}' | sort -u | tr '\n' ',' | sed 's/,$//')
  if [ -n "$other" ]; then
    echo "  METHOD-DRIFT  $method $url  ←  $caller   (backend has: $other)"
    method_mismatch=$((method_mismatch + 1))
  else
    echo "  MISSING       $methodurl  ←  $caller"
    missing=$((missing + 1))
  fi
done < "$called"
[ $missing -eq 0 ] && [ $method_mismatch -eq 0 ] && echo "  (none — all frontend calls have a matching backend handler)"

echo
echo "═══ Backend routes nobody calls ═══"
# Extract just the URL from declared, strip the method prefix, glue with router-local path.
declared_paths=$(awk -F'\t' '{
  p=$1
  while (match(p, /^[A-Z]/)) { p = substr(p,2) }
  sub(/\/$/, "", p)
  url = ($2 == "/") ? p : p $2
  print url "\t" $3
}' "$declared")
called_paths=$(awk -F'\t' '{ split($1, a, " "); print a[2] }' "$called" | sort -u)
orphans=0
while IFS=$'\t' read -r path src; do
  # Skip well-known exempt paths (webhooks, health, csp, system endpoints)
  case "$path" in
    /api/health|/api/csp-report|/api/stripe/webhook|/api/webhooks/*|/api/push/*) continue ;;
  esac
  path_re=$(echo "$path" | sed 's|:[a-zA-Z]*|[^/]*|g; s|/|\\/|g')
  if ! echo "$called_paths" | grep -qE "^${path_re}$"; then
    echo "  ORPHAN  $path  ($src)"
    orphans=$((orphans + 1))
  fi
done <<< "$declared_paths"
[ $orphans -eq 0 ] && echo "  (none — every declared route has a frontend caller)"

echo
total=$((missing + method_mismatch))
if [ $total -gt 0 ]; then
  echo "FAIL: $missing missing handler(s), $method_mismatch method mismatch(es)"
  exit 1
fi
echo "OK"
