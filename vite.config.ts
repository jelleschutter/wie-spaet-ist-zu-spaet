import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

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

			// adapter-node: this app holds GBs of timetable/delay data resident in
			// memory after a slow startup load, so it needs a long-lived Node
			// process (not a serverless/edge adapter). `npm run build && npm start`
			// runs the whole app — frontend and /api routes — as a single process.
			adapter: adapter()
		})
	]
});
