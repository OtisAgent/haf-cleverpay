/* HAF theme switch — day is the default everywhere.
 *
 * Drop this in the <head>, before the first paint, so a returning visitor who
 * chose night never sees a flash of the day page. It sets data-theme on <html>
 * and remembers the choice per browser under one key shared by every HAF site,
 * so picking night on KNECT means PLNA opens in night too.
 *
 * Anything with [data-haf-theme-toggle] becomes a switch, and gets its label
 * and aria-pressed kept in step automatically. No framework, no dependencies.
 */
(function () {
  var KEY = 'haf-theme';
  var root = document.documentElement;

  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function apply(theme) {
    if (theme === 'night') root.setAttribute('data-theme', 'night');
    else root.removeAttribute('data-theme');   // absent = day, the default
    label(theme);
  }

  function label(theme) {
    var night = theme === 'night';
    var nodes = document.querySelectorAll('[data-haf-theme-toggle]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].setAttribute('aria-pressed', night ? 'true' : 'false');
      nodes[i].setAttribute('title', night ? 'Switch to day' : 'Switch to night');
      var text = nodes[i].querySelector('[data-haf-theme-label]');
      if (text) text.textContent = night ? 'Day' : 'Night';
    }
  }

  var current = stored() === 'night' ? 'night' : 'day';
  apply(current);

  function toggle() {
    current = current === 'night' ? 'day' : 'night';
    try { localStorage.setItem(KEY, current); } catch (e) {}
    apply(current);
  }

  function wire() {
    label(current);
    var nodes = document.querySelectorAll('[data-haf-theme-toggle]');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].__hafWired) continue;
      nodes[i].__hafWired = true;
      nodes[i].addEventListener('click', function (e) { e.preventDefault(); toggle(); });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  window.hafTheme = { get: function () { return current; }, set: function (t) {
    current = t === 'night' ? 'night' : 'day';
    try { localStorage.setItem(KEY, current); } catch (e) {}
    apply(current);
  }, toggle: toggle };
})();
