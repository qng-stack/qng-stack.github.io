// 翻页脚本。没有把页面画成图片。
//
// 一次换页做三件事：
// 1. 把当前页面的节点复制一份，盖住屏幕。这是同一份 DOM，文字和照片都还是原来的元素。
// 2. 盖住之后，把真正的下一页换进文档，滚到顶部。
// 3. 用一条折痕把盖着的这一页从角上裁掉，底下的下一页露出来。裁完就删掉这层盖子。
//
// 会翻页的点击：左键、本站、地址确实换成了另一页，而且目标是首页、目录、某一章或关于。
// 不翻页的点击：文章里的小标题（# 开头）、新窗口、下载、外链、按着 Ctrl/Shift/Alt 的点击。

export function installPageTurn() {
	// 开发时脚本可能再次执行。先卸掉上一次的监听，避免旧的截图翻页还挂着。
	if (typeof window.__pageTurnAbort === 'function') window.__pageTurnAbort();
	if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

	let busy = false;
	// 记住当前路径，用来区分「只是改了锚点」和「浏览器后退换了页面」。
	let pagePath = location.pathname;

	// 只给这四类页面做翻页，其他地址交给浏览器自己跳。
	function pathKind(pathname) {
		const path = pathname.replace(/\/$/, '') || '/';
		if (path === '/') return 'home';
		if (path === '/blog' || path === '/next') return 'catalog';
		if (path.startsWith('/blog/')) return 'article';
		if (path === '/about') return 'about';
		return 'other';
	}

	// 往首页、从文章回到目录或关于、从关于回到目录：从左下角揭开。
	// 其余按层级决定。首页 0，目录和关于 1，文章 2。层级变高就从右上角揭开。
	function direction(from, to) {
		if (to === 'home') return 'back';
		if ((to === 'catalog' || to === 'about') && from === 'article') return 'back';
		if (to === 'catalog' && from === 'about') return 'back';
		const rank = { home: 0, catalog: 1, about: 1, article: 2, other: 1 };
		return rank[to] < rank[from] ? 'back' : 'forward';
	}

	function samePath(a, b) {
		return (a || '').replace(/\/$/, '') === (b || '').replace(/\/$/, '');
	}

	// 盖住屏幕的那一层。复制的是节点，不是像素。
	function cover() {
		// html 的宽度含滚动条预留的那一条。正文和顶栏实际排在更窄的 body 里。
		// 盖层若跟 html 一样宽，首页顶栏是绝对定位，会被拉进这条槽，标签整体往右跳。
		const pageWidth = document.body.clientWidth;
		const width = document.documentElement.clientWidth;
		const height = document.documentElement.clientHeight;
		const scene = document.createElement('div');
		scene.className = 'turn-scene';
		scene.style.width = width + 'px';
		scene.style.height = height + 'px';

		// 带上 body 的类，首页的透明顶栏、目录的纸页样式才能套在这份拷贝上。
		const sheet = document.createElement('div');
		sheet.className = 'turn-sheet ' + document.body.className;
		const page = document.createElement('div');
		page.className = 'turn-page';
		page.style.width = pageWidth + 'px';
		// 用外边距上移，不用 transform。transform 会让浏览器把文字重新栅格化，
		// 笔画发虚发粗，顶栏那几个字会在盖上的瞬间跳一下。
		if (window.scrollY) page.style.marginTop = -window.scrollY + 'px';

		for (const child of document.body.children) {
			if (child.tagName === 'SCRIPT') continue;
			const copy = child.cloneNode(true);
			copy.querySelectorAll('script').forEach((node) => node.remove());
			// 去掉 id，避免和即将换上的真页面抢同一个 id。
			copy.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
			page.appendChild(copy);
		}

		// flap 是折过去的纸背，fold 是折痕上的阴影。开始时都藏着。
		const flap = document.createElement('div');
		flap.className = 'turn-flap';
		const fold = document.createElement('div');
		fold.className = 'turn-fold';
		sheet.appendChild(page);
		scene.append(sheet, flap, fold);
		document.documentElement.appendChild(scene);
		return { scene, sheet, flap, fold, width, height };
	}

	// 换上的新 body 里的脚本不会自己执行。内联脚本负责首页问候和书封取色，
	// 模块脚本负责文章里的图。图放到揭页结束再跑，避免动画过程中把版面撑开。
	function reviveScripts(body, which) {
		const jobs = [];
		body.querySelectorAll('script').forEach((old) => {
			const moduleSrc = old.type === 'module' && old.getAttribute('src');
			if (which === 'inline' && moduleSrc) return;
			if (which === 'module' && !moduleSrc) return;
			if (moduleSrc) {
				const src = old.getAttribute('src');
				old.remove();
				jobs.push(
					fetch(src)
						.then((response) => response.text())
						.then((code) => {
							// blob 地址解析不了以 / 开头的导入，先改成完整地址。
							const absolute = code.replace(
								/from\s+["'](\/[^"']+)["']/g,
								(_, path) => `from "${location.origin}${path}"`,
							);
							const url = URL.createObjectURL(new Blob([absolute], { type: 'text/javascript' }));
							return import(/* @vite-ignore */ url).finally(() => URL.revokeObjectURL(url));
						}),
				);
				return;
			}
			const script = document.createElement('script');
			for (const attr of old.attributes) script.setAttribute(attr.name, attr.value);
			script.textContent = old.textContent;
			old.replaceWith(script);
		});
		return Promise.all(jobs);
	}

	// 书在取到封面颜色之前是透明的。揭开首页之前等它出现，避免揭开一张空封面。
	function waitForBook() {
		const hero = document.querySelector('.day-hero');
		if (!(hero instanceof HTMLElement) || hero.classList.contains('book-ready')) return Promise.resolve();
		return new Promise((resolve) => {
			const observer = new MutationObserver(() => {
				if (hero.classList.contains('book-ready')) {
					observer.disconnect();
					resolve();
				}
			});
			observer.observe(hero, { attributes: true, attributeFilter: ['class'] });
			setTimeout(() => {
				observer.disconnect();
				resolve();
			}, 800);
		});
	}

	// 点在直线 ab 的哪一侧。结果的正负表示左右，0 表示点在直线上。
	function side(point, a, b) {
		return (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
	}

	// 折痕是一条无限长的直线，这里求它和屏幕四条边的交点。能落在边上的通常是两个。
	function hitsOnRect(point, line, w, h) {
		const found = [];
		function add(x, y) {
			if (x < -0.5 || y < -0.5 || x > w + 0.5 || y > h + 0.5) return;
			const next = { x: Math.min(w, Math.max(0, x)), y: Math.min(h, Math.max(0, y)) };
			if (!found.some((item) => Math.hypot(item.x - next.x, item.y - next.y) < 1)) found.push(next);
		}
		if (Math.abs(line.x) > 1e-4) {
			add(0, point.y + ((0 - point.x) / line.x) * line.y);
			add(w, point.y + ((w - point.x) / line.x) * line.y);
		}
		if (Math.abs(line.y) > 1e-4) {
			add(point.x + ((0 - point.y) / line.y) * line.x, 0);
			add(point.x + ((h - point.y) / line.y) * line.x, h);
		}
		return found;
	}

	// 把一个角沿折痕镜像到纸背上，用来裁出翻过去的那一块。
	function reflect(point, a, b) {
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const length = dx * dx + dy * dy || 1;
		const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / length;
		return { x: 2 * (a.x + t * dx) - point.x, y: 2 * (a.y + t * dy) - point.y };
	}

	// clip-path 需要顶点按顺时针或逆时针排好，否则裁出来的形状会扭。
	function polygon(points) {
		if (!points.length) return 'polygon(0 0, 0 0, 0 0)';
		const center = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
		center.x /= points.length;
		center.y /= points.length;
		const ordered = points
			.slice()
			.sort((p, q) => Math.atan2(p.y - center.y, p.x - center.x) - Math.atan2(q.y - center.y, q.x - center.x));
		return 'polygon(' + ordered.map((point) => point.x.toFixed(1) + 'px ' + point.y.toFixed(1) + 'px').join(', ') + ')';
	}

	// 折痕从角上扫过屏幕。正面留下还没揭开的区域，纸背补上已经折过去的角。
	function peel(coverState, forward) {
		const { sheet, flap, fold, width: w, height: h } = coverState;
		const started = performance.now();
		const duration = 1200;
		return new Promise((resolve) => {
			function frame(now) {
				const t = Math.min(1, (now - started) / duration);
				// 慢进慢出，避免折痕一开始就猛地扫过。
				const p = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
				// 往前翻从右上角走向左下，往回翻从左下角走向右上。0.5 是折痕的倾斜。
				const sweep = forward
					? { x: Math.cos(Math.PI - 0.5), y: Math.sin(Math.PI - 0.5) }
					: { x: Math.cos(-0.5), y: Math.sin(-0.5) };
				const origin = forward ? { x: w, y: 0 } : { x: 0, y: h };
				const corner = forward ? { x: w - 1, y: 1 } : { x: 1, y: h - 1 };
				const travel = forward ? -w * sweep.x + h * sweep.y : w * sweep.x - h * sweep.y;
				const distance = Math.max(10, p * travel);
				const mid = { x: origin.x + sweep.x * distance, y: origin.y + sweep.y * distance };
				const line = { x: -sweep.y, y: sweep.x };
				const hits = hitsOnRect(mid, line, w, h);
				// 交点不足两个时，折痕已经离开屏幕：整页揭完，或还没开始。
				if (hits.length < 2) {
					const gone =
						side(corner, mid, { x: mid.x + line.x, y: mid.y + line.y }) *
							side({ x: w / 2, y: h / 2 }, mid, { x: mid.x + line.x, y: mid.y + line.y }) >
						0;
					sheet.style.clipPath = gone ? 'polygon(0 0, 0 0, 0 0)' : 'none';
					flap.style.opacity = '0';
					fold.style.opacity = '0';
				} else {
					const [a, b] = hits;
					const curlSide = side(corner, a, b);
					const corners = [
						{ x: 0, y: 0 },
						{ x: w, y: 0 },
						{ x: w, y: h },
						{ x: 0, y: h },
					];
					const keep = corners.filter((point) => side(point, a, b) * curlSide <= 0);
					const turned = corners.filter((point) => side(point, a, b) * curlSide > 0);
					sheet.style.clipPath = polygon(keep.concat(hits));
					flap.style.clipPath = polygon(hits.concat(turned.map((point) => reflect(point, a, b))));
					flap.style.opacity = '1';
					const shade = Math.atan2(b.y - a.y, b.x - a.x);
					fold.style.opacity = String(0.55 + 0.35 * Math.sin(Math.min(p, 1) * Math.PI));
					fold.style.width = Math.hypot(b.x - a.x, b.y - a.y) + 'px';
					fold.style.left = (a.x + b.x) / 2 + 'px';
					fold.style.top = (a.y + b.y) / 2 + 'px';
					fold.style.transform = 'translate(-50%, -40%) rotate(' + shade + 'rad)';
				}
				if (t < 1) requestAnimationFrame(frame);
				else resolve();
			}
			requestAnimationFrame(frame);
		});
	}

	// mode 为 pop 时是浏览器后退，不再往历史里压一条新记录。
	async function turn(href, dir, mode) {
		if (busy) return;
		busy = true;
		const layer = cover();
		try {
			const response = await fetch(href);
			if (!response.ok) throw new Error(String(response.status));
			const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
			document.body.replaceWith(doc.body);
			document.title = doc.title;
			window.scrollTo(0, 0);
			await reviveScripts(document.body, 'inline');
			if (document.body.classList.contains('home')) await waitForBook();
			await peel(layer, dir !== 'back');
			pagePath = new URL(href, location.href).pathname;
			if (mode !== 'pop') history.pushState({ turn: true }, '', href);
			reviveScripts(document.body, 'module');
		} finally {
			layer.scene.remove();
			busy = false;
		}
	}

	function onClick(event) {
		const link = event.target instanceof Element ? event.target.closest('a') : null;
		if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
		const raw = link.getAttribute('href') || '';
		if (raw.startsWith('#')) return;
		let url;
		try {
			url = new URL(link.href, location.href);
		} catch (error) {
			return;
		}
		if (url.origin !== location.origin) return;
		// 同一篇文章里的小标题只滚动，不翻页。
		if (url.hash && samePath(url.pathname, location.pathname)) return;
		const to = pathKind(url.pathname);
		if (to === 'other' || samePath(url.pathname, location.pathname)) return;
		event.preventDefault();
		turn(url.href, direction(pathKind(location.pathname), to), 'push').catch(() => {
			location.href = url.href;
		});
	}

	function onPopState() {
		if (samePath(location.pathname, pagePath)) return;
		if (busy) {
			location.reload();
			return;
		}
		turn(location.href, 'back', 'pop').catch(() => location.reload());
	}

	document.addEventListener('click', onClick);
	window.addEventListener('popstate', onPopState);
	window.__pageTurnAbort = () => {
		document.removeEventListener('click', onClick);
		window.removeEventListener('popstate', onPopState);
	};
}
