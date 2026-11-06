/** Prefix an in-site path with Astro's base. For this user site the base is `/`. */
export function withBase(path: string): string {
	const base = import.meta.env.BASE_URL.replace(/\/$/, '');
	if (/^(?:[a-z]+:)?\/\//i.test(path) || path.startsWith('#')) return path;
	const normalized = path.startsWith('/') ? path : `/${path}`;
	return `${base}${normalized}`;
}
