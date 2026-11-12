// Giraffe Expressive (Giraffe Music 1.0): la única interfaz. Antes de dibujar nada se
// aplican las opciones de Configuración > Aspecto, así no hay parpadeo al abrir la app.
(function () {
  var s = {};
  try { s = JSON.parse(localStorage.getItem('gm.settings') || '{}'); } catch (e) {}
  window.UI_NEW = true;
  var c = document.documentElement.classList;
  c.add('ui-new');
  window.applyLook = function (s) {
    c.remove('fx-soft', 'fx-off', 'fx-blur', 'sh-medium', 'sh-square');
    if (s.anim === 'soft' || s.anim === 'off') c.add('fx-' + s.anim);
    if (s.blur !== false) c.add('fx-blur');
    if (s.shape === 'medium' || s.shape === 'square') c.add('sh-' + s.shape);
  };
  window.applyLook(s);
  document.write('<link rel="preload" href="/fonts/figtree.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="/new.css"><link rel="stylesheet" href="/expressive.css">');
})();
