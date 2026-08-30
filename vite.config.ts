import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	test: {
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'lib',
					environment: 'node',
					include: ['tests/**/*.test.ts']
				}
			}
		]
	}
});
