import { getCollection } from 'astro:content';
import rss from '@astrojs/rss';
import { SITE_DESCRIPTION, SITE_TITLE } from '../consts';

export async function GET(context) {
	const posts = await getCollection('blog');
	const site = new URL(import.meta.env.BASE_URL, context.site);
	if (!site.pathname.endsWith('/')) site.pathname += '/';
	return rss({
		title: SITE_TITLE,
		description: SITE_DESCRIPTION,
		site: site.href,
		items: posts.map((post) => ({
			title: post.data.title,
			pubDate: post.data.pubDate,
			description: post.data.description,
			link: new URL(`blog/${post.id}/`, site).href,
		})),
	});
}
