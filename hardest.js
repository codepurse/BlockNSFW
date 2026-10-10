// hardest.js
// The frame for When it's hardest. The page itself is a Supporter extra
// (extras/hardest.js), which store builds include and this repository
// doesn't: here it is an empty stand-in (extras/README.md). Without it, the
// page says so plainly; every protection is still here.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  document.addEventListener('DOMContentLoaded', () => {
    const page = self.HardestPage;
    if (page && typeof page.start === 'function' && self.Ledger) {
      page.start();
      return;
    }
    $('h-head').textContent = 'See when it tends to get hard.';
    $('h-lede').textContent = 'When it’s hardest is a Supporter extra. It comes with BlockNSFW from the Chrome Web Store, Microsoft Edge Add-ons and Firefox Add-ons. This is the open-source build, which has every protection but not the extras.';
  });
})();
