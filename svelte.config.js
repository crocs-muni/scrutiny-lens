import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			// Pure-SPA fallback (spec §8). NEVER prerender '/': a prerendered
			// homepage and this fallback would both write build/index.html.
			fallback: 'index.html'
		}),
		paths: {
			// Base is build-time only. The production custom domain
			// (lens.scrutiny.cloud) serves from /, so pages.yml sets no
			// BASE_PATH anymore; CI can still override for other mounts.
			// See issue #16.
			base: process.env.BASE_PATH ?? ''
		}
	}
};

export default config;
