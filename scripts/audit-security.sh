#!/usr/bin/env bash
# Mechanical security checks. Each check is a focused grep that produces
# small, sorted, signal-rich output. False positives are suppressed with
# `# audit-security: ignore` on the same line.
#
# Usage:  scripts/audit-security.sh
# Exits 0 if every section is clean, 1 otherwise.

set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
ignore_marker="audit-security: ignore"

# ── 1. State-mutating routes without auth middleware ─────────────────────
# POST/PUT/PATCH/DELETE handlers that don't reference any of the project's
# auth helpers on the same line AND aren't covered by a file-level
# `router.use(<auth>)` guard. Public exceptions (login, signup, webhooks,
# tracking links) are listed in the whitelist below.
echo "═══ State-mutating handlers without auth ═══"
auth_kw='userAuth|requireLogin|brokerAuth|teamAuth|adminAuth|adminSessionAuth|optionalAuth|inmobiliariaAuth|requireBroker|requireAuth|requireStripe|adminAuthRouter|verify\(|tourRequestLimiter|appCreateLimiter|authLimiter|resetLimiter|uploadLimiter|clientErrorLimiter|tracking'
# Inline-auth markers: handler bodies that perform their own JWT / cookie /
# bearer check without a named middleware. Recognise common patterns so
# we don't flag handlers that legitimately do per-request authorization.
inline_auth_re='req\.user\?\.sub|req\.cookies\?\.hrdt|req\.headers\.authorization|verifyJwt|jwt\.verify|track-token|track_token|review_token|magic-link'
# Public-by-design route paths. These accept anonymous traffic by design
# (auth flows, public webhooks, public-facing analytics pings).
public_routes_re='/forgot-password|/reset-password|/login|/register|/verify-email|/verify|/resend-verification|/track-token|/track-upload|/csp-report|/webhook|/meta/callback|/apple|/contact|/subscribe|/unsubscribe|/leads['"'"'"]|/leads/[a-z]|/inquiry|/share-click|/click['"'"'"]|/click/|/view['"'"'"]|/impression|/feedback|/2fa/verify|/2fa/resend|/logout|/biometric|/cancel-feedback|/initial-upload|/request|/saved|/affiliate|/track\b|/reports[/'"'"'"]'
# Files whose routes are uniformly public (webhooks, public analytics).
public_files_re='meta-webhook|client-errors'
miss=0
for f in routes/*.js; do
  if echo "$f" | grep -qE "$public_files_re"; then continue; fi
  # Detect file-level guards (`router.use(userAuth)` at module scope) OR
  # mount-time guards in server.js: `app.use('/api/X', userAuth, ...)`.
  if grep -qE "^[[:space:]]*router\.use\([^)]*(${auth_kw})" "$f" 2>/dev/null; then
    continue
  fi
  basename=$(basename "$f" .js)
  if grep -qE "app\.use\(['\"][^'\"]*['\"][^,]*(${auth_kw})[^,]*,[[:space:]]*require\(['\"]\\./routes/${basename}['\"]" server.js 2>/dev/null; then
    continue
  fi
  grep -nE "^[[:space:]]*router\.(post|put|patch|delete)\(['\"]" "$f" | while IFS= read -r line; do
    if echo "$line" | grep -qE "$public_routes_re"; then continue; fi
    if echo "$line" | grep -qF "$ignore_marker"; then continue; fi
    if echo "$line" | grep -qE "$auth_kw"; then continue; fi
    lineno=$(echo "$line" | cut -d: -f1)
    end=$((lineno + 2))
    if sed -n "${lineno},${end}p" "$f" | grep -qE "$auth_kw"; then continue; fi
    # Look ~30 lines into the handler body for either an inline auth
    # pattern (req.user.sub guard, custom JWT verify, magic-link bearer,
    # etc.) or any of the named auth middlewares being invoked manually.
    bodyend=$((lineno + 30))
    body=$(sed -n "${lineno},${bodyend}p" "$f")
    if printf '%s' "$body" | grep -qE "$inline_auth_re"; then continue; fi
    if printf '%s' "$body" | grep -qE "$auth_kw"; then continue; fi
    method=$(echo "$line" | sed -nE "s|^[0-9]+:[[:space:]]*router\.([a-z]+)\(.*|\1|p" | tr 'a-z' 'A-Z')
    path=$(echo "$line"   | sed -nE "s|^[0-9]+:[[:space:]]*router\.[a-z]+\(['\"]([^'\"]+)['\"].*|\1|p")
    echo "  $f:$lineno  $method $path"
  done
done | tee /tmp/audit-sec-1.txt > /dev/null
miss=$(wc -l < /tmp/audit-sec-1.txt | tr -d ' ')
cat /tmp/audit-sec-1.txt
[ "$miss" -eq 0 ] && echo "  (clean)"
[ "$miss" -gt 0 ] && fail=$((fail + miss))

echo
# ── 2. jwt.decode() — skips signature verification ──────────────────────
echo "═══ jwt.decode() instead of jwt.verify() ═══"
n=$(grep -rnE "jwt\.decode\(" --include='*.js' . 2>/dev/null \
  | grep -vE "(node_modules|/\.claude/worktrees/|/test|\.test\.|$ignore_marker)" \
  | grep -vE ":[[:space:]]*//|:[[:space:]]*\*" \
  | tee /tmp/audit-sec-2.txt | wc -l | tr -d ' ')
cat /tmp/audit-sec-2.txt | sed 's/^/  /'
[ "$n" -eq 0 ] && echo "  (clean)"
[ "$n" -gt 0 ] && fail=$((fail + n))

echo
# ── 3. Open redirects: res.redirect(<non-string-literal>) ────────────────
echo "═══ Open-redirect candidates (res.redirect with non-literal arg) ═══"
n=$(grep -rnE "res\.redirect\(" --include='*.js' . 2>/dev/null \
  | grep -vE "(node_modules|/\.claude/worktrees/|$ignore_marker)" \
  | grep -vE "res\.redirect\([0-9]+,[[:space:]]*['\"][^'\"]+['\"]\)" \
  | grep -vE "res\.redirect\(['\"][^'\"]+['\"]\)" \
  | grep -vE "res\.redirect\(([0-9]+,[[:space:]]*)?\`/[^?\$]" \
  | grep -vE "res\.redirect\(([0-9]+,[[:space:]]*)?\`\\\$\{BASE_URL\}/" \
  | grep -vE "res\.redirect\(['\"]?/[a-z]+['\"]?[ )]?$" \
  | grep -vE "res\.redirect\([a-zA-Z_][a-zA-Z0-9_]*\)" \
  | grep -vE "res\.redirect\(['\"]/[^'\"+]+['\"][[:space:]]*\+[[:space:]]*encodeURIComponent" \
  | tee /tmp/audit-sec-3.txt | wc -l | tr -d ' ')
cat /tmp/audit-sec-3.txt | sed 's/^/  /'
[ "$n" -eq 0 ] && echo "  (clean)"
[ "$n" -gt 0 ] && fail=$((fail + n))

echo
# ── 4. Command execution with non-literal arg ────────────────────────────
echo "═══ exec/spawn/execSync with template-literal or variable arg ═══"
# Only consider files that actually import child_process. Other files'
# .exec(...) calls are SQL helpers, regex.exec, etc. — not shell commands.
> /tmp/audit-sec-4.txt
for f in $(grep -rlE "require\(['\"]child_process['\"]\)|from ['\"]child_process['\"]" --include='*.js' . 2>/dev/null \
            | grep -vE "(node_modules|/\.claude/worktrees/)"); do
  grep -nE "(exec|spawn|execSync|spawnSync|execFile|fork)\(" "$f" 2>/dev/null \
    | grep -vE "(exec|spawn)\(['\"][^'\"]*['\"]" \
    | grep -vE "$ignore_marker" \
    | sed "s|^|$f:|" >> /tmp/audit-sec-4.txt
done
n=$(wc -l < /tmp/audit-sec-4.txt | tr -d ' ')
cat /tmp/audit-sec-4.txt | sed 's/^/  /'
cat /tmp/audit-sec-4.txt | sed 's/^/  /'
[ "$n" -eq 0 ] && echo "  (clean)"
[ "$n" -gt 0 ] && fail=$((fail + n))

echo
# ── 5. Frontend innerHTML = <expression> (XSS sink) ──────────────────────
# Only flag assignments to arbitrary expressions. innerHTML = '' (clear)
# and innerHTML = `static template` are safe; anything containing a
# variable reference inside backticks or coming from outside is suspect.
echo "═══ innerHTML/outerHTML = <expression> in frontend (unescaped only) ═══"
# Surface only innerHTML assignments where the right-hand template
# literal contains a `${...}` interpolation whose contents are NOT
# wrapped in an obvious sanitizer call.
sanitizer_re='escapeHtml|sanitize|DOMPurify|encodeURI|encodeURIComponent|escape_html|escapeAttr|esc[(]|escape[(]|fmtUSD|toLocaleString|toFixed|\.length|\.count|\.total|\.size'
n=$(grep -rnE "(inner|outer)HTML[[:space:]]*=[[:space:]]*\`" --include='*.html' --include='*.js' public/ 2>/dev/null \
  | grep -vE "$ignore_marker" \
  | grep -E "\\\$\{" \
  | awk -v san="$sanitizer_re" "{
      raw = \$0; unsafe = 0
      while (match(raw, /\\\$\{[^}]*\}/)) {
        seg = substr(raw, RSTART, RLENGTH)
        # Treat as safe if the interpolation:
        #   - calls a sanitizer
        #   - is a numeric / formatter property (.length, .count, fmtUSD, …)
        #   - is a pure ALL-CAPS constant reference
        #   - is a ternary whose branches are string literals only
        body = substr(seg, 3, length(seg) - 3)
        gsub(/^[ \t]+|[ \t]+\$/, \"\", body)
        is_safe = 0
        if (seg ~ san) is_safe = 1
        # ALL_CAPS constant or ALL_CAPS.property accessor (e.g. ICON.empty)
        else if (body ~ /^[A-Z][A-Z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)*\$/) is_safe = 1
        # Ternary with literal-string or constant branches.
        else if (body ~ /\\?[ \t]*([\"'][^\"']*[\"']|[A-Z][A-Z0-9_]*)[ \t]*:[ \t]*([\"'][^\"']*[\"']|[A-Z][A-Z0-9_]*)\$/) is_safe = 1
        # Variables conventionally holding numbers / pre-sanitized markup.
        else if (body ~ /^(safe|html|markup|rendered|days|hours|minutes|seconds|count|total|unread|n|i|j|k|num|len|length|size|page|pages|year|month|day|index|id)\$/) is_safe = 1
        # Server-config-like accessor: spec.X / data.X / config.X / opts.X
        else if (body ~ /^(spec|data|config|opts|options|state|cfg|env|defaults)\\.[A-Za-z][A-Za-z0-9_]*\$/) is_safe = 1
        # JSON.stringify(...) is safe in HTML attribute / JS string context
        else if (body ~ /^JSON\\.stringify\\(/) is_safe = 1
        if (is_safe) {
          raw = substr(raw, 1, RSTART - 1) \"SAFE\" substr(raw, RSTART + RLENGTH)
        } else {
          raw = substr(raw, 1, RSTART - 1) \"UNSAFE\" substr(raw, RSTART + RLENGTH)
          unsafe = 1
        }
      }
      if (unsafe) print
    }" \
  | tee /tmp/audit-sec-5.txt | wc -l | tr -d ' ')
# Show only the first 20 — XSS-sink list is long, summary is enough.
head -20 /tmp/audit-sec-5.txt | sed 's/^/  /'
[ "$n" -eq 0 ] && echo "  (clean)"
[ "$n" -gt 20 ] && echo "  ... and $((n - 20)) more (see /tmp/audit-sec-5.txt)"
[ "$n" -gt 0 ] && fail=$((fail + n))

echo
if [ "$fail" -eq 0 ]; then
  echo "OK"
  exit 0
fi
echo "FAIL: $fail finding(s) across all categories"
exit 1
