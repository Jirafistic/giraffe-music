// La interfaz: la nueva (como el rediseño de YouTube Music) o la de siempre.
// Se elige en Configuración → Información; al cambiarla la app se reinicia.
// Solo se carga el estilo de la elegida (nada que la otra necesite).
(function () {
  var ui = 'new';
  try { ui = JSON.parse(localStorage.getItem('gm.settings') || '{}').ui || 'new'; } catch (e) {}
  window.UI_NEW = ui !== 'old';
  if (window.UI_NEW) {
    document.documentElement.classList.add('ui-new');
    document.write('<link rel="preload" href="/fonts/figtree.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="/new.css">');
  }
})();
