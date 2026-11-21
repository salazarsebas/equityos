export const THEME_STORAGE_KEY = "equityos-theme";

/**
 * Runs in <head> before the first paint. Resolves the theme from the stored choice, or from the system preference
 * when there is none, and writes it to <html data-theme>, so the page never flashes the other theme. Without
 * JavaScript the tokens follow the system preference through `color-scheme`.
 */
export const themeInitScript = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.dataset.theme=t}catch(e){}})()`;
