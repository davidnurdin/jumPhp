// JumPHP task worker (JumPHP\Async in the browser): a Web Worker running its own PHP engine with the game's
// files, started by jumphp.js when the game sends work to a pool / thread. It boots PHP once, then runs one
// job per message: the job file goes into this engine's file system, JumPHP\Async\Worker::run() writes the
// result file, which goes back to the page. No SDL, no canvas, no IndexedDB here: only computation.
// The engine is built for web pages: a few of its globals touch `document` / `window` when it loads (SDL's
// event targets). A worker has neither: minimal stand-ins, never used for anything (no SDL call here).
self.window = self;
const inert = () => ({ style: {}, getContext: () => null, addEventListener() {}, removeEventListener() {} });
self.document = {
	addEventListener() {}, removeEventListener() {}, createElement: inert, getElementById: () => null,
	querySelector: () => null, body: inert(), documentElement: inert(), title: '',
};

let ccall = null;
let FS = null;
const errors = [];

async function boot({ moduleUrl, dataUrl, wasmBinary }) {
	const { default: createPhpModule } = await import(moduleUrl);
	const module = await createPhpModule({
		wasmBinary,
		locateFile: (path, prefix) => (path === 'php-web.data' ? dataUrl : prefix + path),
		print: (text) => console.log('[worker]', text),
		printErr(text) {
			if (!text || /munmap\(\) failed/.test(text)) return;
			errors.push(String(text));
			if (errors.length > 8) errors.shift();
			console.error('[worker]', text);
		},
	});
	ccall = module.ccall;
	FS = module.FS;
	FS.mkdirTree('/tmp/job');
	ccall('php_embed_init', 'number', ['number', 'number'], [0, 0]);
	php(`define('JUMPHP_WASM', true); define('JUMPHP_WORKER', true); chdir('/game'); require '/game/vendor/autoload.php';`);
	if (!php(`echo class_exists('JumPHP\\\\Async\\\\Worker') ? 'ok' : 'missing';`, true).includes('ok')) {
		throw new Error('the game autoloader did not load in the worker: ' + errors.join(' | '));
	}
}

// zend_eval_string has no zend_try around it here: PHP code given to it must never throw (Worker::run()
// catches everything); a fatal error ends this worker and the page starts another one
function php(code, capture = false) {
	if (!capture) {
		ccall('zend_eval_string', 'number', ['string', 'number', 'string'], [code, 0, 'jumphp worker']);
		return '';
	}
	ccall('zend_eval_string', 'number', ['string', 'number', 'string'],
		[`file_put_contents('/tmp/job/out', (function () { ob_start(); ${code} return ob_get_clean(); })());`, 0, 'jumphp worker']);
	return FS.readFile('/tmp/job/out', { encoding: 'utf8' });
}

self.onmessage = async ({ data }) => {
	if (data.type === 'boot') {
		try {
			await boot(data);
			self.postMessage({ type: 'ready' });
		} catch (e) {
			self.postMessage({ type: 'failed', error: String(e && e.message ? e.message : e) });
		}
		return;
	}
	if (data.type === 'job') {
		try {
			FS.writeFile('/tmp/job/in', data.payload);
			php(`JumPHP\\Async\\Worker::run('/tmp/job/in', '/tmp/job/out');`);
			const result = FS.readFile('/tmp/job/out');
			FS.unlink('/tmp/job/out');
			self.postMessage({ type: 'result', id: data.id, payload: result }, [result.buffer]);
		} catch (e) {
			self.postMessage({ type: 'crash', id: data.id, error: String(e && e.message ? e.message : e) + ' ' + errors.join(' | ') });
		}
	}
};
