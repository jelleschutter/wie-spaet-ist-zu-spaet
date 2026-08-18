// This page is a fully client-driven tool (current time/date, navigator.share,
// clipboard, deep links in the URL fragment) that reads the timetable and delay data
// straight from static/data/ in the browser — there's nothing to render on the
// server, so skip SSR entirely and prerender the shell at build time.
export const ssr = false;
export const prerender = true;
