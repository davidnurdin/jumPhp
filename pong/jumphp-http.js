// Asynchronous HTTP for PHP (JumPHP\Http\Http): PHP sends {t: 'http', id, method, url, headers, body (base64),
// timeout}, the page runs fetch() and answers with a JsBridge 'http' event {id, status, headers, body (base64),
// url} or {id, error}. CORS applies: the server must allow the page's origin.
const toBase64 = (bytes) => {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	return btoa(binary);
};
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export function install(api) {
	api.on('http', (msg) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), Math.max(1, msg.timeout || 20) * 1000);
		const init = { method: msg.method, headers: msg.headers || {}, signal: controller.signal, redirect: 'follow' };
		if (msg.body != null && msg.method !== 'GET' && msg.method !== 'HEAD') init.body = fromBase64(msg.body);
		fetch(msg.url, init)
			.then(async (response) => {
				const body = new Uint8Array(await response.arrayBuffer());
				const headers = {};
				response.headers.forEach((value, name) => { headers[name] = value; });
				api.send('http', { id: msg.id, status: response.status, headers, body: toBase64(body), url: response.url || msg.url });
			})
			.catch((e) => {
				const why = e && e.name === 'AbortError' ? 'timeout' : (navigator.onLine === false ? 'offline' : 'network error or CORS');
				api.send('http', { id: msg.id, error: why, url: msg.url });
			})
			.finally(() => clearTimeout(timer));
	});
}
