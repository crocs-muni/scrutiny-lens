import { config } from 'dotenv';
config();

import { runQueryAgent } from './src/lib/ai/agents/query.js';

const env = {
	API_KEY: process.env.API_KEY,
	BASE_URL: process.env.BASE_URL,
	MODEL: process.env.MODEL ?? 'coder'
};

const queries = [
	'ROCA vulnerability in Infineon chips',
	'cc:BSI-DSZ-CC-0814-2012',
	'CVE-2017-15361',
	'smartcard controllers from NXP'
];

for (const query of queries) {
	console.log(`\nQuery: ${query}`);
	const started = Date.now();
	const result = await runQueryAgent(env, { query });
	console.log(`  ${result.ok ? 'OK' : 'FAIL'} ${Date.now() - started}ms`);
	if (result.ok) {
		console.log(`  interpretation: ${result.result.interpretation}`);
		console.log(`  filters: ${JSON.stringify(result.result.filters, null, 2)}`);
	} else {
		console.log(`  ${result.kind}: ${result.message}`);
	}
}
