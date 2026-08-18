import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Set BASE_PATH when the site isn't served from the domain root, e.g.
// BASE_PATH=/wie-spaet-ist-zu-spaet for https://<user>.github.io/<repo>/.
const rawBase = (process.env.BASE_PATH ?? '').trim().replace(/\/+$/, '');
const base = (rawBase === '' ? '' : rawBase.startsWith('/') ? rawBase : `/${rawBase}`) as
	| ''
	| `/${string}`;

export default defineConfig({
	server: {
		allowedHosts: ['localhost', 'hp-laptop.tailf4434.ts.net']
	},
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			paths: { base },

			// adapter-static: there is no backend at all. The timetable and delay
			// data live in static/data/ (built by `npm run data:build`) and minotor
			// runs in the browser, so `npm run build` emits a plain folder of files
			// that any static host - GitHub Pages included - can serve.
			adapter: adapter({ fallback: '404.html' })
		})
	]
});
