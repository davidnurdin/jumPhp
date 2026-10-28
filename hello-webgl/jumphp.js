// JumPHP browser runtime: downloads the engine (php-web.wasm) and the game (php-web.data), restores the
// player's files (IndexedDB), boots PHP and lets it run one frame per requestAnimationFrame.
//
// URL parameters: ?net=wss://host/ws (relay server) &room=ABCD &lang=fr &debug=1 &back=<url> (where "quit" goes)
// &workers=N (Web Workers for JumPHP\Async, 0 = none; default: cores - 1, at most 4)
// Bridge with PHP (JumPHP\Bridge\JsBridge), synchronous with the frames: right before each PHP frame
// (emscripten preMainLoop) the page's events are written to /tmp/jumphp-events; right after it (postMainLoop)
// the game's messages (/tmp/jumphp-bridge) are handled and the modules run. WebGL needs no module: PHP draws
// with the OpenGL extension in SDL's own WebGL context (JumPHP\Gl\OpenGl).
// Modules: jumphp-device.js (page life, phone features), jumphp-http.js (fetch),
// jumphp-pwa.js (installable / offline game: sw.js), jumphp-gamepad.js (Gamepad API).
// window.JumPHP.send(type, data) sends a custom event to the game: $engine->bridge->on(type, fn (array $data)).
// Embedding (games portal): the page posts {type: 'jumphp:ready' | 'jumphp:quit' | 'jumphp:bridge', ...}
// to window.parent; window.JumPHP.onBridge(message) receives the game's custom JsBridge messages.
const GAME = window.JUMPHP_GAME || {};
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const TOUCH = matchMedia('(pointer: coarse)').matches;
const loader = $('loader');
const statusEl = $('status');
const barEl = $('bar').firstElementChild;
const SAVE_DIR = '/game/var';
const BRIDGE_FILE = '/tmp/jumphp-bridge';
const EVENTS_FILE = '/tmp/jumphp-events';
const TASKS_DIR = '/tmp/jumphp-tasks';
const WORKERS = typeof Worker === 'undefined' ? 0
	: Math.max(0, Math.min(8, Number(params.get('workers') ?? Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) || 0));
const lastLines = [];

window.JumPHP = window.JumPHP || { onBridge: null, FS: null };

// --- the bridge with PHP ---------------------------------------------------------------------------------
let FSref = null;
let booted = false;
let callPhp = null;
const outbox = [];                // events for PHP, in order; a key keeps only the latest one (tilt, resize...)
const handlers = {};              // PHP message type -> [fn]
const afterFrame = [];
const beforeFrame = [];
const gestures = [];
function sendToPhp(type, data = {}, key = null) {
	const event = { ...data, t: type };
	if (key) {
		const i = outbox.findIndex((e) => e.key === key);
		if (i >= 0) outbox.splice(i, 1);
	}
	outbox.push({ key, line: JSON.stringify(event) });
}
function writeEvents() {
	if (!FSref || !outbox.length) return;
	const text = outbox.map((e) => e.line).join('\n') + '\n';
	outbox.length = 0;
	try {
		const old = FSref.analyzePath(EVENTS_FILE).exists ? FSref.readFile(EVENTS_FILE, { encoding: 'utf8' }) : '';
		FSref.writeFile(EVENTS_FILE, old + text);
	} catch (e) { console.error('[bridge]', e); }
}
// PHP handles the events now, between two frames (the tab is being hidden / closed)
function deliverNow() {
	if (!booted || !callPhp) return;
	writeEvents();
	try { callPhp('jumphp_events();'); } catch (e) { console.error('[bridge]', e); }
}
// for things a browser only allows from a user gesture (fullscreen, sensors permission, clipboard)
function onGesture(fn) { gestures.push(fn); }
function runGestures() {
	for (const fn of gestures.splice(0)) { try { fn(); } catch (e) { console.error(e); } }
}
addEventListener('pointerup', runGestures, true);
addEventListener('keydown', runGestures, true);
window.JumPHP.send = (type, data) => sendToPhp(String(type), data || {});
const moduleApi = {
	canvas,
	GAME,
	FS: () => FSref,
	send: sendToPhp,
	now: deliverNow,
	on: (type, fn) => { (handlers[type] ||= []).push(fn); },
	afterFrame: (fn) => afterFrame.push(fn),
	beforeFrame: (fn) => beforeFrame.push(fn),
	gesture: onGesture,
	enterFullscreen: () => enterFullscreen(),
	exitFullscreen: () => exitFullscreen(),
	isFullscreen: () => fullscreenElement(),
};

// SDL's GLES2 renderer calls glCheckFramebufferStatus at each SDL_SetRenderTarget: in WebGL that waits for
// the GPU (up to 65 % of a frame). Our targets are always complete. And emscripten enables every WebGL
// extension at start (100-250 ms each for some): only those SDL uses.
const GL_EXTENSIONS = ['ANGLE_instanced_arrays', 'OES_vertex_array_object', 'WEBGL_draw_buffers', 'OES_element_index_uint', 'OES_standard_derivatives'];
for (const ctx of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
	if (!ctx) continue;
	ctx.prototype.checkFramebufferStatus = function () { return 0x8CD5; };
	const supported = ctx.prototype.getSupportedExtensions;
	ctx.prototype.getSupportedExtensions = function () {
		return (supported.call(this) || []).filter((name) => GL_EXTENSIONS.includes(name));
	};
}

const setStatus = (text) => { statusEl.textContent = text; };
const setProgress = (ratio) => { barEl.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`; };
const fail = (text) => { loader.style.display = 'flex'; loader.classList.add('error'); setStatus(text); };
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const notifyParent = (message) => { if (window.parent !== window) window.parent.postMessage(message, '*'); };

// version.json (always fetched fresh): content hashes, so a new build is never hidden by an old cache
const version = await fetch('version.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
const versioned = (file) => (version[file] ? `${file}?v=${version[file]}` : file);

async function cachedFetch(url) {
	let cache = null;
	try { cache = await caches.open('jumphp-' + (GAME.id || 'game')); } catch (e) { /* private mode, http */ }
	const hit = cache && await cache.match(url).catch(() => null);
	if (hit) return hit;
	const response = await fetch(url);
	if (cache && response.ok && url.includes('?v=')) {
		try {
			const file = url.split('?')[0];
			for (const old of await cache.keys()) if (new URL(old.url).pathname.endsWith('/' + file)) await cache.delete(old);
			await cache.put(url, response.clone());
		} catch (e) { console.warn('[cache]', e); }
	}
	return response;
}

async function fetchWithProgress(url, onProgress) {
	const response = await cachedFetch(url);
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	const total = Number(document.querySelector('meta[name="php-wasm-size"]')?.content) || 0;
	if (!response.body || !total) return response.arrayBuffer();
	const reader = response.body.getReader();
	const chunks = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		received += value.length;
		onProgress(received / total);
	}
	const bytes = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
	return bytes.buffer;
}

// a page value inside PHP code: base64 (in a PHP string, "$" or "{$" would run code)
const phpString = (v) => `base64_decode('${btoa(unescape(encodeURIComponent(v == null ? '' : String(v))))}')`;

function prelude() {
	const isMobile = matchMedia('(pointer: coarse)').matches;
	const lang = params.get('lang') || (navigator.language || 'en').slice(0, 2).toLowerCase();
	const lines = [
		`define('JUMPHP_WASM', true);`,
		`define('JUMPHP_CONTAINER_CACHE', true);`,
		`define('JUMPHP_MOBILE', ${isMobile ? 'true' : 'false'});`,
		`define('JUMPHP_LANG', ${phpString(lang)});`,
		`define('JUMPHP_ROOM', ${phpString((params.get('room') || '').toUpperCase())});`,
		`define('JUMPHP_DEBUG', ${params.get('debug') === '1' ? 'true' : 'false'});`,
		`define('JUMPHP_WORKERS', ${WORKERS});`,
		`define('JUMPHP_STANDALONE', ${matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone === true ? 'true' : 'false'});`,
	];
	const net = params.get('net') || GAME.net_url;
	if (net) lines.push(`define('JUMPHP_NET_URL', ${phpString(net)});`);
	return lines.join('\n') + `\nrequire '/game/vendor/jumphp/engine/bootstrap/wasm.php';\n`;
}

// the game's messages (JumPHP\Bridge\JsBridge): one JSON line each
function pollBridge(FS) {
	let text = '';
	try {
		if (!FS.analyzePath(BRIDGE_FILE).exists) return;
		text = FS.readFile(BRIDGE_FILE, { encoding: 'utf8' });
		FS.unlink(BRIDGE_FILE);
	} catch (e) { return; }
	for (const line of text.split('\n')) {
		let msg;
		try { msg = JSON.parse(line); } catch (e) { continue; }
		if (msg.t === 'open' && /^https?:\/\//.test(msg.url || '')) {
			window.open(msg.url, '_blank', 'noopener');
		} else if (msg.t === 'quit') {
			notifyParent({ type: 'jumphp:quit', game: GAME.id });
			window.saveUserFiles?.();
			const back = params.get('back');
			if (back && /^https?:\/\//.test(back)) location.href = back;
			else { $('overlay').querySelector('p').textContent = 'THANKS FOR PLAYING'; $('overlay').style.display = 'flex'; }
		} else if (msg.t === 'share' && navigator.share) {
			navigator.share({ title: GAME.title, text: msg.text || '', url: msg.url || location.href }).catch(() => {});
		} else if (handlers[msg.t]) {
			for (const fn of handlers[msg.t]) { try { fn(msg); } catch (e) { console.error(`[bridge ${msg.t}]`, e); } }
		} else {
			notifyParent({ type: 'jumphp:bridge', game: GAME.id, message: msg });
			window.JumPHP.onBridge?.(msg);
		}
	}
}

// JumPHP\Async in the browser: a pool of Web Workers, each with its own PHP engine (jumphp-worker.js), started
// with the first job. PHP writes jobs to TASKS_DIR/out/<id>.job, results come back as TASKS_DIR/in/<id>.res
// (or .err); TASKS_DIR/disabled tells PHP to run the work itself (no worker could start).
function startTasks(FS, wasmBinary) {
	const slots = [];
	let disabled = false;
	const put = (name, data) => {
		try {
			FS.writeFile(`${TASKS_DIR}/in/${name}.tmp`, data);
			FS.rename(`${TASKS_DIR}/in/${name}.tmp`, `${TASKS_DIR}/in/${name}`);
		} catch (e) { console.error('[tasks]', e); }
	};
	const disable = (why) => {
		if (disabled) return;
		disabled = true;
		console.warn('[tasks] no Web Worker: the game runs its tasks itself.', why || '');
		try { FS.writeFile(`${TASKS_DIR}/disabled`, String(why || '1')); } catch (e) { /* PHP has not created the dir */ }
	};
	const spawn = (slot) => {
		slot.ready = false;
		slot.job = null;
		const worker = slot.worker = new Worker(versioned('jumphp-worker.js'), { type: 'module' });
		const dead = (why) => {
			worker.terminate();
			if (slot.job) put(`${slot.job}.err`, why);
			if (slot.ready && ++slot.restarts < 5) return spawn(slot);   // a job crashed it: a fresh one
			slot.dead = true;
			if (slots.every((s) => s.dead)) disable(why);
		};
		worker.onmessage = ({ data }) => {
			if (data.type === 'ready') slot.ready = true;
			else if (data.type === 'result') { put(`${data.id}.res`, data.payload); slot.job = null; }
			else if (data.type === 'crash') dead(data.error);
			else if (data.type === 'failed') dead(data.error);
		};
		worker.onerror = (e) => { e.preventDefault(); dead(e.message || 'worker error'); };
		worker.postMessage({
			type: 'boot',
			moduleUrl: new URL(versioned('php-web.mjs'), location.href).href,
			dataUrl: new URL(versioned('php-web.data'), location.href).href,
			wasmBinary,
		});
	};
	const pump = () => {
		requestAnimationFrame(pump);
		if (disabled) return;
		let jobs;
		try { jobs = FS.readdir(`${TASKS_DIR}/out`).filter((n) => n.endsWith('.job')).sort(); } catch (e) { return; }
		const warm = !slots.length && FS.analyzePath(`${TASKS_DIR}/warm`).exists;
		if (!jobs.length && !warm) return;
		if (!slots.length) {
			if (!WORKERS) return disable('workers=0');
			for (let i = 0; i < WORKERS; i++) slots.push({ restarts: 0 });
			slots.forEach(spawn);
		}
		for (const slot of slots) {
			if (!jobs.length) break;
			if (!slot.ready || slot.dead || slot.job) continue;
			const name = jobs.shift();
			let payload;
			try {
				payload = FS.readFile(`${TASKS_DIR}/out/${name}`);
				FS.unlink(`${TASKS_DIR}/out/${name}`);
			} catch (e) { continue; }   // cancelled by PHP meanwhile
			slot.job = name.slice(0, -4);
			slot.worker.postMessage({ type: 'job', id: slot.job, payload }, [payload.buffer]);
		}
	};
	requestAnimationFrame(pump);
}

const modules = {};
async function loadModules() {
	for (const [name, file] of [['device', 'jumphp-device.js'], ['http', 'jumphp-http.js'], ['pwa', 'jumphp-pwa.js'], ['gamepad', 'jumphp-gamepad.js']]) {
		try {
			modules[name] = (await import('./' + versioned(file))).install(moduleApi) || {};
		} catch (e) { console.error(`[${file}]`, e); }
	}
}

async function main() {
	const { default: createPhpModule } = await import('./' + versioned('php-web.mjs'));

	setStatus('Downloading the engine...');
	const wasmBinary = await fetchWithProgress(versioned('php-web.wasm'), (r) => setProgress(r * 0.45));

	setStatus('Loading the game...');
	const { ccall, FS } = await createPhpModule({
		canvas,
		wasmBinary,
		locateFile: (path, prefix) => (path === 'php-web.data' ? versioned(path) : prefix + path),
		setStatus(text) {
			const m = /\((\d+)\/(\d+)\)/.exec(text || '');
			if (m) setProgress(0.45 + 0.45 * Number(m[1]) / Number(m[2]));
		},
		print(text) { console.log(text); },
		printErr(text) {
			// emscripten noise: PHP maps its scripts with mmap, MEMFS cannot unmap them (harmless)
			if (!text || /munmap\(\) failed/.test(text)) return;
			console.error(text);
			lastLines.push(String(text));
			if (lastLines.length > 8) lastLines.shift();
		},
		onAbort(reason) { fail('The engine crashed: ' + reason); },
		// around each PHP frame (emscripten main loop): page events in, game messages and WebGL out
		preMainLoop() {
			for (const fn of beforeFrame) { try { fn(); } catch (e) { console.error(e); } }
			writeEvents();
		},
		postMainLoop() {
			pollBridge(FSref);
			for (const fn of afterFrame) { try { fn(); } catch (e) { console.error(e); } }
		},
	});
	window.JumPHP.FS = FS;
	FSref = FS;
	callPhp = (code) => ccall('zend_eval_string', 'number', ['string', 'number', 'string'], [code, 0, 'jumphp events']);
	// debugging / tests: PHP code between two frames (its echo goes to the console)
	window.JumPHP.php = (code) => { if (booted) callPhp(code); };
	await loadModules();

	// the player's files (saves, options): var/ of the game lives in IndexedDB
	setStatus('Restoring saves...');
	setProgress(0.93);
	FS.mkdirTree(SAVE_DIR);
	FS.mount(FS.filesystems.IDBFS, {}, SAVE_DIR);
	let syncing = false;
	const syncfs = (populate) => new Promise((resolve) => {
		if (syncing && !populate) return resolve();
		syncing = true;
		FS.syncfs(populate, (err) => { syncing = false; if (err) console.error('[save]', err); resolve(); });
	});
	await syncfs(true);
	window.saveUserFiles = () => syncfs(false);
	setInterval(window.saveUserFiles, 2000);
	addEventListener('pagehide', window.saveUserFiles);
	document.addEventListener('visibilitychange', () => document.hidden && window.saveUserFiles());

	setStatus('Starting...');
	setProgress(1);
	await nextFrame();
	await nextFrame();

	try {
		ccall('phpw_run', 'void', ['string'], [prelude()]);
		// back without "unwind": jumphp_frame() was never reached (the boot failed)
		fail('The game did not start:\n' + (lastLines.join('\n') || 'see the browser console'));
		return;
	} catch (e) {
		// emscripten_set_main_loop(..., simulate_infinite_loop) throws "unwind": the normal case
		if (e !== 'unwind' && !(e && e.name === 'ExitStatus')) {
			fail(e && e.message ? e.message : String(e));
			throw e;
		}
	}

	booted = true;
	await nextFrame();
	loader.style.display = 'none';
	startTasks(FS, wasmBinary);
	window.JumPHPTouch?.start();
	notifyParent({ type: 'jumphp:ready', game: GAME.id });

	// browsers start audio and keyboard focus after a user gesture: one click / tap / key on the overlay
	const overlay = $('overlay');
	overlay.style.display = 'flex';
	const start = () => {
		overlay.style.display = 'none';
		canvas.focus();
		removeEventListener('keydown', start, true);
		// phones: fullscreen + landscape at once (game.yaml `touch: {fullscreen: false}` turns it off)
		if (TOUCH && (GAME.touch || {}).fullscreen !== false) enterFullscreen();
	};
	// a touch only allows fullscreen when the finger goes up (pointerup), a mouse when it goes down
	overlay.addEventListener(TOUCH ? 'pointerup' : 'pointerdown', start, { once: true });
	addEventListener('keydown', start, true);
}

// Fullscreen of the whole page (not only the canvas: the on-screen touch controls stay visible), then, on
// phones, the screen is locked in the orientation of the game (Android; iOS has no lock: touch.js asks the
// player to turn the phone)
const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
function enterFullscreen() {
	const root = document.documentElement;
	const request = root.requestFullscreen || root.webkitRequestFullscreen;
	if (!request || fullscreenElement()) return Promise.resolve();
	return Promise.resolve(request.call(root, { navigationUI: 'hide' }))
		.then(() => {
			if (TOUCH && screen.orientation?.lock) {
				return screen.orientation.lock((GAME.width || 16) >= (GAME.height || 9) ? 'landscape' : 'portrait');
			}
		})
		.catch(() => {});
}
function exitFullscreen() {
	const exit = document.exitFullscreen || document.webkitExitFullscreen;
	if (exit && fullscreenElement()) Promise.resolve(exit.call(document)).catch(() => {});
}
window.JumPHP.fullscreen = enterFullscreen;

$('btn-full').addEventListener('click', () => {
	fullscreenElement() ? exitFullscreen() : enterFullscreen();
	canvas.focus();
});
canvas.addEventListener('dblclick', () => enterFullscreen());
$('btn-sound').addEventListener('click', () => {
	// SDL_mixer plays through emscripten's Web Audio context
	const ctx = window.SDL2?.audioContext || window.Module?.SDL2?.audioContext;
	if (ctx) ctx.state === 'running' ? ctx.suspend() : ctx.resume();
	canvas.focus();
});

main().catch((e) => { console.error(e); fail(e && e.message ? e.message : String(e)); });
