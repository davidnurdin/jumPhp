// Gamepads for PHP (JumPHP\Input\Gamepad): before each PHP frame, the state of navigator.getGamepads()
// goes to PHP (JsBridge 'gamepad': {pads: [{i, id, std, b: [values], a: [values]}]}) when it changed.
// "standard" mapping pads (nearly all) have W3C button numbers: PHP names them (a, b, start, lt...).
// PHP -> page: {do: 'rumble', pad, strong, weak, ms} (Chromium: vibrationActuator).
export function install(api) {
	if (!navigator.getGamepads) return {};
	let last = '';
	const round = (v) => Math.round(v * 1000) / 1000;
	api.beforeFrame(() => {
		const pads = [];
		for (const gp of navigator.getGamepads()) {
			if (!gp || !gp.connected) continue;
			pads.push({
				i: gp.index, id: gp.id, std: gp.mapping === 'standard',
				b: gp.buttons.map((b) => round(b.value || (b.pressed ? 1 : 0))),
				a: gp.axes.map(round),
			});
		}
		const json = JSON.stringify(pads);
		if (json === last) return;
		last = json;
		api.send('gamepad', { pads }, 'gamepad');
	});
	api.on('gamepad', (msg) => {
		if (msg.do !== 'rumble') return;
		const gp = navigator.getGamepads()[msg.pad];
		const actuator = gp && gp.vibrationActuator;
		if (actuator && actuator.playEffect) {
			actuator.playEffect('dual-rumble', { duration: msg.ms, strongMagnitude: msg.strong, weakMagnitude: msg.weak }).catch(() => {});
		}
	});
	return {};
}
