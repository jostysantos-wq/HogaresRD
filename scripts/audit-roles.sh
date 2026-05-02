#!/usr/bin/env bash
# Role-parity audit.
#
# `inmobiliaria` and `constructora` are sibling org-owner roles that should
# be checked together everywhere. This grep finds places where one is named
# without the other — those are the only places drift can hide.
#
# Usage:  scripts/audit-roles.sh
# Exits 0 if no drift, 1 otherwise. Whitelist exact strings/files via
# `# audit-roles: ignore` on the same line.

set -euo pipefail
cd "$(dirname "$0")/.."

# Files to scan: backend routes + dashboard frontend (HTML + shared JS).
files=(routes/*.js public/*.html public/js/*.js)

# A line "names" inmobiliaria if it has the literal token; same for constructora.
# We flag every line that names one but NOT the other.
inm_only=$(grep -nE "['\"]inmobiliaria['\"]|\.role *=== *['\"]inmobiliaria['\"]" "${files[@]}" 2>/dev/null \
  | grep -vE "constructora|audit-roles: ignore" \
  | grep -vE "/inmobiliaria(/|\b)" \
  || true)

constr_only=$(grep -nE "['\"]constructora['\"]|\.role *=== *['\"]constructora['\"]" "${files[@]}" 2>/dev/null \
  | grep -vE "inmobiliaria|audit-roles: ignore" \
  || true)

echo "═══ Lines naming 'inmobiliaria' without 'constructora' ═══"
if [ -n "$inm_only" ]; then
  echo "$inm_only" | sed 's/^/  /'
else
  echo "  (clean)"
fi

echo
echo "═══ Lines naming 'constructora' without 'inmobiliaria' ═══"
if [ -n "$constr_only" ]; then
  echo "$constr_only" | sed 's/^/  /'
else
  echo "  (clean)"
fi

echo
echo "═══ Canonical OWNER_ROLES references ═══"
grep -nE "OWNER_ROLES" routes/*.js | sed 's/^/  /'

[ -z "$inm_only" ] && [ -z "$constr_only" ] && { echo; echo "OK"; exit 0; }
echo
echo "FAIL: review lines above. Add 'constructora' (or 'inmobiliaria') where appropriate,"
echo "      or use the OWNER_ROLES constant. Suppress false positives with"
echo "      \`# audit-roles: ignore\` on the line."
exit 1
