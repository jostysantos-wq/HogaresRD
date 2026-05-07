---
name: i18n-coverage
description: Audit HogaresRD's Spanish/English translation coverage. Use this skill whenever the user asks "what's missing in translations", "i18n audit", "untranslated strings", or before a release that touches user-facing copy. Diffs `/public/locales/es.json` against `en.json`, finds keys referenced in HTML/JS but absent from both, finds defined-but-unused keys, and reports per-page coverage. Spanish is the primary locale (Dominican Spanish), English is fallback — all user-visible strings should resolve through `data-i18n` attributes.
---

# i18n coverage audit

HogaresRD ships Spanish-first to a Dominican Republic audience. English is the fallback. The locale files are:
- `/public/locales/es.json` — primary
- `/public/locales/en.json` — fallback

Strings get pulled in via `<element data-i18n="key.path">` attributes processed by `/public/js/i18n.js`. When a page literal-strings a Spanish phrase instead of going through i18n, English-locale users see Spanish — that's the drift this skill audits.

## When to fire

User says one of:
- "i18n audit" / "translation coverage"
- "what strings are missing in en.json"
- "find untranslated strings"
- "before launch, what's not localized"
- "diff es.json and en.json"

Or proactively: when reviewing a PR that adds new HTML copy, check that the literal strings have corresponding i18n keys.

## How to run the audit

### Step 1 — Diff `es.json` vs `en.json`

```bash
cd /Users/neverknowsbest/Documents/HogaresRD\ WebPage
node -e "
const es = require('./public/locales/es.json');
const en = require('./public/locales/en.json');
function flatten(o, prefix='') {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) {
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key));
    else out[key] = v;
  }
  return out;
}
const E = flatten(es), N = flatten(en);
const inEsOnly = Object.keys(E).filter(k => !(k in N));
const inEnOnly = Object.keys(N).filter(k => !(k in E));
const same = Object.keys(E).filter(k => E[k] === N[k] && typeof E[k] === 'string' && E[k].length > 4);
console.log('Keys in es.json missing from en.json:', inEsOnly.length);
inEsOnly.slice(0, 30).forEach(k => console.log('  -', k));
console.log('\\nKeys in en.json missing from es.json:', inEnOnly.length);
inEnOnly.slice(0, 30).forEach(k => console.log('  -', k));
console.log('\\nKeys with identical es/en values (suspicious — possibly untranslated):', same.length);
same.slice(0, 30).forEach(k => console.log('  -', k, '=>', JSON.stringify(E[k]).slice(0, 60)));
"
```

### Step 2 — Find `data-i18n` keys referenced but undefined

```bash
node -e "
const fs = require('fs'); const path = require('path');
const es = require('./public/locales/es.json');
function flatten(o, p='') { const out={}; for (const [k,v] of Object.entries(o||{})) { const key=p?p+'.'+k:k; if (v && typeof v==='object'&&!Array.isArray(v)) Object.assign(out, flatten(v,key)); else out[key]=v; } return out; }
const defined = new Set(Object.keys(flatten(es)));
const referenced = new Set();
for (const f of fs.readdirSync('public').filter(n => n.endsWith('.html'))) {
  const t = fs.readFileSync('public/'+f, 'utf8');
  const matches = [...t.matchAll(/data-i18n=[\"']([^\"']+)[\"']/g)];
  matches.forEach(m => referenced.add(m[1]));
}
const undef = [...referenced].filter(k => !defined.has(k));
console.log('data-i18n keys referenced in HTML but NOT in es.json:', undef.length);
undef.forEach(k => console.log('  -', k));
const unused = [...defined].filter(k => !referenced.has(k));
console.log('\\nKeys defined in es.json but never referenced:', unused.length);
unused.slice(0, 20).forEach(k => console.log('  -', k));
"
```

### Step 3 — Find Spanish literal strings in HTML that bypass i18n

```bash
# Look for visible Spanish text inside element bodies (not inside attributes)
# that doesn't have a sibling/ancestor data-i18n attribute.
grep -rnE '>(\s*)(Cargando|Buscar|Guardar|Cancelar|Aceptar|Continuar|Volver|Siguiente|Anterior|Próximamente|Sin resultados|No hay)[^<]*</' public/*.html | head -30
```

Each hit is a candidate for i18n migration. A page that literal-strings "Próximamente" needs a matching `data-i18n="vecindario.coming_soon"` or similar.

### Step 4 — Per-page coverage

```bash
for f in public/home.html public/comprar.html public/listing.html public/submit.html public/login.html; do
  total=$(grep -cE 'data-i18n=' "$f")
  literals=$(grep -cE '>\s*(Cargando|Buscar|Sin resultados|No hay|Continuar)\s*<' "$f")
  echo "$(basename $f): $total i18n keys, $literals literal Spanish strings"
done
```

Pages with low ratio (literals > i18n keys) need migration.

## Output format

Report in this shape:

```markdown
# i18n coverage audit — YYYY-MM-DD

## Coverage summary
| Locale | Keys defined | Keys missing |
|---|---|---|
| es | 412 | — (primary) |
| en | 397 | 15 missing vs es |

## Missing in en.json (15 keys)
- `vecindario.coming_soon` (es: "Próximamente")
- `listing.hero_book_tour` (es: "Reservar visita")
- ...

## Suspicious matches (es and en identical)
These keys have the same value in both locales — usually means en.json wasn't translated:
- `nav.home` → "Inicio" (should be "Home")
- ...

## Untranslated literals in HTML
| Page | Literal | Suggested key |
|---|---|---|
| `listing.html:1247` | "Próximamente" | `listing.coming_soon` |
| `comprar.html:892` | "Sin resultados" | `comprar.no_results` |
| ... |

## Defined but unused
These keys exist in es.json but are never referenced — candidates for cleanup:
- `legacy.old_signup_v1` ...

## Recommendations
1. Translate the 15 missing en keys.
2. Migrate the N literal strings to data-i18n.
3. Drop the M unused keys.
```

Keep it under 800 words. Don't list every key — top 30 + counts.

## What good looks like

- Every visible string in `public/*.html` resolves through `data-i18n=` (no Spanish literals in visible body text).
- es.json and en.json have the same set of keys.
- Identical-value pairs are limited to genuinely untranslatable strings (proper nouns, "USD", "OK").
- Per-page coverage is consistently high (>95% of visible text via i18n).

## Don't fix in this skill — just report

The skill audits and reports. The user decides whether to fix. Migration is a content-review task that benefits from a human pass.

If the user asks for the fix, then:
1. Migrate one page at a time.
2. Add the new key to es.json with the existing literal.
3. Add to en.json with `TODO_translate` placeholder OR an attempted translation flagged for human review.
4. Replace the literal in HTML with `data-i18n="..."`.
5. Test the page renders correctly in both locales.

## See also

- `data-context` skill for general data model context.
- `web-design-contract` for the broader web design rules.
