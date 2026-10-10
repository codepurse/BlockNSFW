// gooddays.js
// The frame for Your good days. The page itself is a Supporter extra
// (extras/gooddays.js and extras/checkin.js), which store builds include and
// this repository doesn't: here they are empty stand-ins (extras/README.md).
// Without them, the page says so plainly; every protection is still here.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  document.addEventListener('DOMContentLoaded', () => {
    const page = self.GoodDaysPage;
    if (page && typeof page.start === 'function' && self.Checkin) {
      page.start();
      return;
    }
    $('gd-title').textContent = 'What your good days have in common.';
    $('gd-lede').textContent = 'Your good days is a Supporter extra. It comes with BlockNSFW from the Chrome Web Store, Microsoft Edge Add-ons and Firefox Add-ons. This is the open-source build, which has every protection but not the extras.';
  });
})();
