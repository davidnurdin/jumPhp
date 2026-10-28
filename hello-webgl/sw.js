// JumPHP service worker (game.yaml `pwa`): the game plays offline once loaded.
// Install: caches every file of this build (the list and hashes come from version.json, the URLs are exactly
// the ones the page asks for: file?v=<hash>). Requests: cache first for versioned files, network first for
// the page and version.json (an update is seen at once when online; offline, the cached build starts).
// A new build has a new BUILD below: it installs next to the old one and waits; the page shows "update ready"
// (JumPHP\Device\Pwa::updateReady()) and applyUpdate() switches to it.
const BUILD = '5e60b2b49824';
const GAME = 'hello-webgl';
const CACHE = `jumphp-pwa-${GAME}-${BUILD}`;
const STATIC = ['./', 'index.html', 'game.json', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (event) => {
	event.waitUntil((async () => {
		const cache = await caches.open(CACHE);
		const version = await fetch('version.json', { cache: 'no-store' }).then((r) => r.json());
		const files = Object.keys(version).filter((k) => k !== 'build').map((f) => `${f}?v=${version[f]}`);
		await cache.add(new Request('version.json', { cache: 'no-store' }));
		await cache.addAll([...STATIC, ...files].map((url) => new Request(url, { cache: 'reload' })));
	})().catch((e) => { console.error('[sw] install failed', e); throw e; }));
});

self.addEventListener('activate', (event) => {
	event.waitUntil((async () => {
		for (const name of await caches.keys()) {
			if (name.startsWith(`jumphp-pwa-${GAME}-`) && name !== CACHE) await caches.delete(name);
		}
		await self.clients.claim();
	})());
});

self.addEventListener('message', (event) => {
	if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
	const request = event.request;
	const url = new URL(request.url);
	if (request.method !== 'GET' || url.origin !== location.origin) return;
	const file = url.pathname.split('/').pop();
	if (request.mode === 'navigate' || file === 'version.json' || file === '' || file === 'index.html') {
		// network first: updates; offline: this build
		event.respondWith(fetch(request).catch(async () => {
			const cache = await caches.open(CACHE);
			return (await cache.match(request, { ignoreSearch: true })) || (await cache.match('./')) || Response.error();
		}));
		return;
	}
	event.respondWith((async () => {
		const cache = await caches.open(CACHE);
		const hit = await cache.match(request);
		if (hit) return hit;
		const response = await fetch(request);
		// same-origin files of a newer build (seen online before this worker was replaced): keep them too
		if (response.ok && url.search.startsWith('?v=')) cache.put(request, response.clone()).catch(() => {});
		return response;
	})());
});
