// Installable / offline game (JumPHP\Device\Pwa), when game.yaml `pwa` is on: registers sw.js, keeps the
// browser's install question for later, tells PHP (JsBridge 'pwa' events) and runs its requests
// ({do: 'install' | 'update'}).
export function install(api) {
	if (!api.GAME.pwa || !('serviceWorker' in navigator) || !isSecureContext) return {};
	let deferred = null;
	let registration = null;

	addEventListener('beforeinstallprompt', (e) => {
		e.preventDefault();               // no mini-infobar: the game offers it in its own menu
		deferred = e;
		api.send('pwa', { installable: true }, 'pwa-installable');
	});
	addEventListener('appinstalled', () => {
		deferred = null;
		api.send('pwa', { installed: true });
	});

	const watch = (worker) => {
		if (!worker) return;
		const check = () => {
			// a worker waiting while another one controls the page: a newer build
			if (worker.state === 'installed' && navigator.serviceWorker.controller) api.send('pwa', { update: true });
		};
		worker.addEventListener('statechange', check);
		check();
	};

	navigator.serviceWorker.register('sw.js').then((reg) => {
		registration = reg;
		watch(reg.waiting);
		watch(reg.installing);
		reg.addEventListener('updatefound', () => watch(reg.installing));
		// look for a newer build now and then (a long session, a phone app kept open for days)
		// (not at once: the registration job may still run and the check would be dropped)
		const check = () => { if (navigator.serviceWorker.controller) reg.update().catch(() => {}); };
		setTimeout(check, 3000);
		setInterval(check, 30 * 60 * 1000);
		document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
		return navigator.serviceWorker.ready;
	}).then(() => api.send('pwa', { offline: true })).catch((e) => console.warn('[pwa]', e));

	let reloading = false;
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		if (reloading || !api.updating) return;
		reloading = true;
		Promise.resolve(window.saveUserFiles?.()).finally(() => location.reload());
	});

	api.on('pwa', (msg) => {
		if (msg.do === 'install') {
			const ask = () => {
				if (!deferred) { api.send('pwa', { choice: false }); return; }
				const e = deferred;
				deferred = null;
				api.send('pwa', { installable: false }, 'pwa-installable');
				e.prompt().then(() => e.userChoice)
					.then((choice) => api.send('pwa', { choice: choice.outcome === 'accepted' }))
					.catch(() => api.gesture(() => { deferred = e; ask(); }));   // no recent gesture: at the next tap / key
			};
			ask();
		} else if (msg.do === 'update' && registration && registration.waiting) {
			api.updating = true;
			registration.waiting.postMessage('skipWaiting');
		}
	});
	return {};
}
