import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit({ adapter: adapter() })],
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
