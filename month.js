// month.js
// The frame for Your month and Your year. The pages themselves are a
// Supporter extra (extras/month.js), which store builds include and this
// repository doesn't: here it is an empty stand-in (extras/README.md).
// Without it, the page says so plainly; every protection is still here.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  document.addEventListener('DOMContentLoaded', () => {
    const page = self.MonthPage;
    if (page && typeof page.start === 'function' && self.Ledger) {
      page.start();
      return;
    }
    $('m-head').textContent = 'A letter at the start of every month.';
    $('m-lede').textContent = 'Your month and Your year are Supporter extras. They come with BlockNSFW from the Chrome Web Store, Microsoft Edge Add-ons and Firefox Add-ons. This is the open-source build, which has every protection but not the extras.';
  });
})();
