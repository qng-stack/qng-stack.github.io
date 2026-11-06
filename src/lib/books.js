// 首页上的两本书。第一本对应现有章节，第二本先留空目录。
export const aospBook = {
	href: '/blog/',
	title: 'AOSP源码解析',
	cover: ['AOSP', '源码解析'],
	cta: '点击翻开',
};

export const nextBook = {
	href: '/next/',
	title: '未完待续',
	cover: ['未完待续'],
	cta: '尚未开写',
};

// 1–99 转成「四十一章」这种封面用的写法。
export function chapterCount(count) {
	const digit = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
	if (count <= 0) return '零章';
	if (count < 10) return digit[count] + '章';
	if (count < 20) return '十' + digit[count % 10] + '章';
	if (count < 100) return digit[Math.floor(count / 10)] + '十' + digit[count % 10] + '章';
	return count + '章';
}
