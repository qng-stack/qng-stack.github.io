// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	// User site. The GitHub repository must be named qng-stack.github.io.
	site: 'https://qng-stack.github.io',
	integrations: [mdx(), sitemap()],
	devToolbar: {
		enabled: false,
	},
});
