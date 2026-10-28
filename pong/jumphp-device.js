// Page life and phone features for PHP (JumPHP\Device\Lifecycle, JumPHP\Device\Device).
// - page -> PHP: JsBridge 'page' events (hide, show, blur, focus, online, offline, resize, fullscreen, close)
//   and 'device' events (tilt, motion, battery). 'hide' and 'close' are delivered at once (api.now(): PHP runs
//   between two frames), so the game can save before the tab freezes or goes away.
// - PHP -> page: JsBridge 'device' messages {do: vibrate | awake | orientation | fullscreen | copy | motion}.
export function install(api) {
	const orientation = () => (innerWidth >= innerHeight ? 'landscape' : 'portrait');
	const page = (e, extra = {}, key = null) => api.send('page', { e, ...extra }, key);

	// the state before the first frame (no events)
	api.send('page', {
		e: 'state', visible: !document.hidden, focus: document.hasFocus(), online: navigator.onLine !== false,
		w: innerWidth, h: innerHeight, o: orientation(),
	});

	document.addEventListener('visibilitychange', () => {
		if (document.hidden) {
			page('hide');
			api.now();
			window.saveUserFiles?.();
		} else {
			page('show');
			if (wantAwake) lockAwake();
		}
	});
	addEventListener('blur', () => page('blur'));
	addEventListener('focus', () => page('focus'));
	addEventListener('online', () => page('online'));
	addEventListener('offline', () => page('offline'));
	addEventListener('resize', () => page('resize', { w: innerWidth, h: innerHeight, o: orientation() }, 'resize'));
	const fullscreenChanged = () => page('fullscreen', { on: !!api.isFullscreen() }, 'fullscreen');
	document.addEventListener('fullscreenchange', fullscreenChanged);
	document.addEventListener('webkitfullscreenchange', fullscreenChanged);
	addEventListener('pagehide', () => {
		page('close');
		api.now();
		window.saveUserFiles?.();
	});

	// --- screen awake (Wake Lock: lost when the tab is hidden, taken again when it comes back) ---
	let wantAwake = false;
	let sentinel = null;
	function lockAwake() {
		if (!navigator.wakeLock || sentinel) return;
		navigator.wakeLock.request('screen').then((s) => {
			sentinel = s;
			s.addEventListener('release', () => { sentinel = null; });
		}).catch(() => {});
	}

	// --- sensors ---
	let motionOn = false;
	function startMotion() {
		if (motionOn) return;
		motionOn = true;
		const clamp = (v) => Math.max(-1, Math.min(1, v));
		addEventListener('deviceorientation', (e) => {
			if (e.gamma == null) return;
			// beta: front/back (90 = upright), gamma: left/right; the screen turned: axes turn too
			let x = e.gamma / 45;
			let y = (e.beta - 45) / 45;
			const angle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
			if (angle === 90) [x, y] = [e.beta / 45, -e.gamma / 45 - 1];
			else if (angle === -90 || angle === 270) [x, y] = [-e.beta / 45, e.gamma / 45 - 1];
			api.send('device', { tilt: [clamp(x), clamp(y)] }, 'tilt');
		});
		addEventListener('devicemotion', (e) => {
			const a = e.accelerationIncludingGravity;
			if (a && a.x != null) api.send('device', { motion: [a.x, a.y, a.z] }, 'motion');
		});
	}
	function requestMotion() {
		const ask = window.DeviceOrientationEvent && DeviceOrientationEvent.requestPermission;
		if (!ask) { startMotion(); return; }
		// iOS: only from a user gesture
		api.gesture(() => {
			DeviceOrientationEvent.requestPermission().then((r) => { if (r === 'granted') startMotion(); }).catch(() => {});
			window.DeviceMotionEvent?.requestPermission?.().catch(() => {});
		});
	}

	// --- battery (Chromium) ---
	if (navigator.getBattery) {
		navigator.getBattery().then((b) => {
			const send = () => api.send('device', { battery: { level: b.level, charging: b.charging } }, 'battery');
			send();
			b.addEventListener('levelchange', send);
			b.addEventListener('chargingchange', send);
		}).catch(() => {});
	}

	api.on('device', (msg) => {
		switch (msg.do) {
			case 'vibrate':
				try { navigator.vibrate?.(msg.pattern); } catch (e) { /* not allowed before a gesture */ }
				break;
			case 'awake':
				wantAwake = !!msg.on;
				if (wantAwake) lockAwake();
				else if (sentinel) { sentinel.release().catch(() => {}); sentinel = null; }
				break;
			case 'orientation':
				if (!screen.orientation) break;
				if (msg.o === 'any') { try { screen.orientation.unlock(); } catch (e) { /* not locked */ } } else screen.orientation.lock(msg.o).catch(() => {});
				break;
			case 'fullscreen':
				if (!!msg.on === !!api.isFullscreen()) break;
				// browsers want a user gesture: now if it works, else at the next tap / key
				if (msg.on) api.enterFullscreen().then(() => { if (!api.isFullscreen()) api.gesture(() => api.enterFullscreen()); });
				else api.exitFullscreen();
				break;
			case 'copy':
				if (navigator.clipboard?.writeText) {
					navigator.clipboard.writeText(msg.text).catch(() => api.gesture(() => navigator.clipboard.writeText(msg.text).catch(() => {})));
				}
				break;
			case 'motion':
				requestMotion();
				break;
		}
	});
}
