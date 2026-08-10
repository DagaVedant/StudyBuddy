export const THEME_STORAGE_KEY = 'studybuddy-theme'

/**
 * Applies the stored theme before the browser paints anything.
 *
 * Inline in `<head>` on purpose: any deferred version of this runs after the
 * first paint, which is a white flash on every load for anyone who chose dark.
 *
 * It lives here rather than beside the toggle so `next.config.ts` can hash it
 * for the Content-Security-Policy without importing a client component. The
 * hash covers these exact bytes, so editing this string changes it: if the CSP
 * report-only header starts complaining about an inline script after a change
 * here, that is why, and the fix is to recompute rather than to loosen the
 * policy.
 */
export const themeInitScript = `
(function () {
  try {
    var stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    if (stored === 'light' || stored === 'dark') {
      document.documentElement.setAttribute('data-theme', stored);
    }
  } catch (e) {}
})();
`.trim()
