/**
 * password-strength.js
 *
 * Shared password-strength meter + validator for every register-* page.
 * Replaces the ~30-line IIFE that was duplicated in register-user,
 * register-broker, register-inmobiliaria, register-constructora, and
 * register-agency. Reset-password also uses the same meter.
 *
 * Usage in HTML:
 *   <input type="password" id="password" />
 *   <div class="pw-strength-wrap" id="pwStrengthWrap" style="display:none">
 *     <div id="pwBar1"></div><div id="pwBar2"></div>
 *     <div id="pwBar3"></div><div id="pwBar4"></div>
 *     <ul>
 *       <li id="rule-len">✗ 8+ caracteres</li>
 *       <li id="rule-up">✗ Mayúscula</li>
 *       <li id="rule-low">✗ Minúscula</li>
 *       <li id="rule-num">✗ Número</li>
 *       <li id="rule-spec">✗ Especial (!@#...)</li>
 *     </ul>
 *   </div>
 *   <script src="/js/password-strength.js"></script>
 *   <script>HogaresPwStrength.attach('password');</script>
 *
 * Or, with non-default IDs:
 *   HogaresPwStrength.attach('newPassword', { wrap: 'pwStrengthWrap' });
 *
 * The same module exposes HogaresPwStrength.validate(value) which returns
 * an error string or null — use it inside the form's submit handler so
 * client + meter share one source of truth.
 */
(function (global) {
  'use strict';

  // Bar fill colors graded weak → strong (red, orange, yellow, green).
  // Kept page-agnostic; tokens live in core.css if pages want to override.
  var COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e'];
  var EMPTY  = '#e0e8f5';

  function check(v) {
    return {
      len:  v.length >= 8,
      up:   /[A-Z]/.test(v),
      low:  /[a-z]/.test(v),
      num:  /[0-9]/.test(v),
      spec: /[^A-Za-z0-9]/.test(v),
    };
  }

  /** Returns an error string in Spanish, or null when the password is OK. */
  function validate(p) {
    if (!p || p.length < 8) return 'La contraseña debe tener al menos 8 caracteres';
    if (!/[A-Z]/.test(p))   return 'Incluye al menos una letra mayúscula';
    if (!/[a-z]/.test(p))   return 'Incluye al menos una letra minúscula';
    if (!/[0-9]/.test(p))   return 'Incluye al menos un número';
    if (!/[^A-Za-z0-9]/.test(p)) return 'Incluye al menos un carácter especial (!@#$%...)';
    return null;
  }

  /** Wires the strength meter to a <input type="password"> by id. */
  function attach(inputId, opts) {
    opts = opts || {};
    var input = document.getElementById(inputId);
    if (!input) return;
    var wrap  = document.getElementById(opts.wrap || 'pwStrengthWrap');
    var bars  = [1, 2, 3, 4].map(function (i) {
      return document.getElementById((opts.barPrefix || 'pwBar') + i);
    });
    var rules = {
      len:  document.getElementById('rule-len'),
      up:   document.getElementById('rule-up'),
      low:  document.getElementById('rule-low'),
      num:  document.getElementById('rule-num'),
      spec: document.getElementById('rule-spec'),
    };

    function update() {
      var v = input.value;
      if (!v) { if (wrap) wrap.style.display = 'none'; return; }
      if (wrap) wrap.style.display = 'block';
      var checks = check(v);
      var score = 0;
      Object.keys(checks).forEach(function (k) {
        if (checks[k]) score += 1;
        var li = rules[k];
        if (!li) return;
        li.textContent = (checks[k] ? '✓ ' : '✗ ') + li.textContent.slice(2);
        li.style.color = checks[k] ? '#22c55e' : '#94a3b8';
      });
      var level = Math.max(0, score - 1);
      bars.forEach(function (b, i) {
        if (!b) return;
        b.style.background = i < level ? COLORS[Math.min(level - 1, 3)] : EMPTY;
      });
    }

    input.addEventListener('input', update);
    return { update: update, validate: validate };
  }

  global.HogaresPwStrength = { attach: attach, validate: validate };
})(typeof window !== 'undefined' ? window : globalThis);
