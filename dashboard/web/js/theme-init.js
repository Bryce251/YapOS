(function () {
  try {
    var t = window.localStorage.getItem('yapos-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    return;
  }
})();
