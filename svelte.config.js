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
			// GH Pages project sites mount at /<repo>; base is build-time only.
			// CI sets BASE_PATH; root mounts need nothing. See issue #16.
			base: process.env.BASE_PATH ?? ''
		}
	}
};

export default config;
