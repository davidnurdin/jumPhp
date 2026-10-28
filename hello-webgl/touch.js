// On-screen controls for phones and tablets: a d-pad and A / B / START buttons that send real keyboard
// events, so the game (SDL) receives exactly the keys of its config/input.yaml.
// Shown only on touch screens. Keys of the buttons: game.yaml `touch: {a: Space, b: Escape, start: Return}`.
// Options (all optional, the defaults keep the classic d-pad):
//   pad: stick       a floating joystick instead of the d-pad: touch anywhere on the left half of the screen and
//                    slide (8 directions, diagonals included: walk + jump with one thumb); a short tap there
//                    without sliding is a mouse click on the game
//   select: P        a 4th small button (SELECT) next to START
//   labels: {a: JUMP, b: FIRE, start: START, select: PAUSE, rotate: 'TURN YOUR PHONE'}   texts
//   fullscreen: false   do not go fullscreen (and landscape) at the first tap (jumphp.js)
// A landscape game held upright asks the player to turn the phone (tap: play anyway).
(function () {
	'use strict';

	// key name -> [keyCode, key, code]: SDL's emscripten port reads keyCode
	const KEYS = {
		Left: [37, 'ArrowLeft', 'ArrowLeft'], Up: [38, 'ArrowUp', 'ArrowUp'],
		Right: [39, 'ArrowRight', 'ArrowRight'], Down: [40, 'ArrowDown', 'ArrowDown'],
		Space: [32, ' ', 'Space'], Return: [13, 'Enter', 'Enter'], Escape: [27, 'Escape', 'Escape'],
		Backspace: [8, 'Backspace', 'Backspace'], Tab: [9, 'Tab', 'Tab'], P: [80, 'p', 'KeyP'],
	};
	for (let c = 65; c <= 90; c++) {
		const l = String.fromCharCode(c);
		KEYS[l] ??= [c, l.toLowerCase(), 'Key' + l];
	}
	const held = {};

	function send(type, name) {
		const k = KEYS[name];
		if (!k) return;
		const e = new KeyboardEvent(type, { key: k[1], code: k[2], bubbles: true, cancelable: true });
		Object.defineProperty(e, 'keyCode', { get: () => k[0] });
		Object.defineProperty(e, 'which', { get: () => k[0] });
		(document.getElementById('canvas') || window).dispatchEvent(e);
	}

	function key(name, down) {
		held[name] = (held[name] || 0) + (down ? 1 : -1);
		if (down && held[name] === 1) send('keydown', name);
		if (!down && held[name] <= 0) { held[name] = 0; send('keyup', name); }
	}

	// a mouse click on the canvas at a page position (SDL reads the position from the move, then the button)
	function click(x, y) {
		const canvas = document.getElementById('canvas');
		if (!canvas) return;
		const opts = { clientX: x, clientY: y, screenX: x, screenY: y, button: 0, bubbles: true, cancelable: true };
		canvas.dispatchEvent(new MouseEvent('mousemove', opts));
		canvas.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1 }, opts)));
		setTimeout(() => canvas.dispatchEvent(new MouseEvent('mouseup', Object.assign({ buttons: 0 }, opts))), 80);
	}

	// floating joystick: the left half of the screen; the touch point is the centre, the slide gives the directions
	function stick() {
		const DEAD = 18, MAX = 50;
		const zone = document.createElement('div');
		zone.style.cssText = 'position:fixed;z-index:5;left:0;top:0;width:45%;height:100%;touch-action:none;-webkit-user-select:none;user-select:none;';
		const base = document.createElement('div');
		base.style.cssText = 'position:fixed;z-index:5;width:120px;height:120px;margin:-60px 0 0 -60px;border-radius:50%;pointer-events:none;'
			+ 'border:2px solid rgba(255,255,255,.35);background:rgba(255,255,255,.08);left:90px;top:calc(100% - 110px);';
		const knob = document.createElement('div');
		knob.style.cssText = 'position:absolute;width:52px;height:52px;left:34px;top:34px;border-radius:50%;'
			+ 'background:rgba(255,255,255,.35);border:2px solid rgba(255,255,255,.6);';
		base.appendChild(knob);
		document.body.appendChild(zone);
		document.body.appendChild(base);
		zone.restX = 90;
		zone.base = base;
		let id = null, cx = 0, cy = 0, t0 = 0, moved = false, dirs = {};
		const setDirs = (next) => {
			for (const d of ['Left', 'Right', 'Up', 'Down']) {
				if (!!next[d] !== !!dirs[d]) key(d, !!next[d]);
			}
			dirs = next;
		};
		const move = (x, y) => {
			let dx = x - cx, dy = y - cy;
			const len = Math.hypot(dx, dy);
			if (len > DEAD) moved = true;
			if (len > MAX) { dx = dx * MAX / len; dy = dy * MAX / len; }
			knob.style.transform = `translate(${dx}px,${dy}px)`;
			const next = {};
			if (len > DEAD) {
				const a = Math.atan2(dy, dx) * 180 / Math.PI; // 8 sectors of 45 degrees
				if (a > -67.5 && a < 67.5) next.Right = true;
				if (a > 112.5 || a < -112.5) next.Left = true;
				if (a < -22.5 && a > -157.5) next.Up = true;
				if (a > 22.5 && a < 157.5) next.Down = true;
			}
			setDirs(next);
		};
		const end = (e) => {
			if (e.pointerId !== id) return;
			e.preventDefault();
			id = null;
			knob.style.transform = '';
			base.style.left = zone.restX + 'px';
			base.style.top = 'calc(100% - 110px)';
			setDirs({});
			// a short tap without sliding is not for the joystick: a click on the game under it (menus, buttons)
			if (!moved && e.type === 'pointerup' && performance.now() - t0 < 350) click(cx, cy);
		};
		zone.addEventListener('pointerdown', (e) => {
			if (id !== null) return;
			e.preventDefault();
			id = e.pointerId;
			zone.setPointerCapture?.(id);
			cx = e.clientX; cy = e.clientY;
			t0 = performance.now();
			moved = false;
			base.style.left = cx + 'px';
			base.style.top = cy + 'px';
			move(cx, cy);
		});
		zone.addEventListener('pointermove', (e) => { if (e.pointerId === id) { e.preventDefault(); move(e.clientX, e.clientY); } });
		zone.addEventListener('pointerup', end);
		zone.addEventListener('pointercancel', end);
		return zone;
	}

	// "turn your phone" over the game while the phone is upright (when the orientation lock is not possible)
	function rotateHint(text) {
		const hint = document.createElement('div');
		hint.style.cssText = 'position:fixed;inset:0;z-index:20;display:none;flex-direction:column;align-items:center;'
			+ 'justify-content:center;gap:28px;background:rgba(0,0,0,.88);color:#fff;font:bold 18px monospace;'
			+ 'text-align:center;padding:16px;touch-action:none;';
		const phone = document.createElement('div');
		phone.style.cssText = 'width:44px;height:76px;border:4px solid #fff;border-radius:8px;animation:jumphp-rotate 2s ease-in-out infinite;';
		const label = document.createElement('div');
		label.textContent = text;
		hint.append(phone, label);
		const css = document.createElement('style');
		css.textContent = '@keyframes jumphp-rotate{0%,20%{transform:rotate(0)}60%,100%{transform:rotate(-90deg)}}';
		document.head.appendChild(css);
		document.body.appendChild(hint);
		const portrait = matchMedia('(orientation: portrait)');
		let dismissed = false;
		const update = () => { hint.style.display = portrait.matches && !dismissed ? 'flex' : 'none'; };
		portrait.addEventListener?.('change', () => { dismissed = false; update(); });
		hint.addEventListener('pointerup', (e) => {
			e.preventDefault();
			window.JumPHP?.fullscreen?.(); // Android: fullscreen + landscape lock
			dismissed = true;
			update();
		});
		update();
	}

	function button(label, name, style) {
		const b = document.createElement('div');
		b.textContent = label;
		b.style.cssText = 'position:fixed;z-index:6;display:flex;align-items:center;justify-content:center;user-select:none;'
			+ 'background:rgba(255,255,255,.18);border:2px solid rgba(255,255,255,.45);color:#fff;font:bold 16px monospace;'
			+ 'touch-action:none;-webkit-user-select:none;' + style;
		const down = (e) => { e.preventDefault(); b.style.background = 'rgba(255,255,255,.4)'; key(name, true); };
		const up = (e) => { e.preventDefault(); b.style.background = 'rgba(255,255,255,.18)'; key(name, false); };
		b.addEventListener('pointerdown', down);
		b.addEventListener('pointerup', up);
		b.addEventListener('pointercancel', up);
		b.addEventListener('pointerleave', (e) => { if (e.buttons) up(e); });
		document.body.appendChild(b);
		return b;
	}

	function start() {
		if (!matchMedia('(pointer: coarse)').matches) return;
		const cfg = Object.assign({ a: 'Space', b: 'Escape', start: 'Return' }, (window.JUMPHP_GAME || {}).touch || {});
		const labels = Object.assign({ a: 'A', b: 'B', start: 'START', select: 'SELECT' }, cfg.labels || {});
		const game = window.JUMPHP_GAME || {};
		if ((game.width || 16) > (game.height || 9)) rotateHint(labels.rotate || 'TURN YOUR PHONE');
		let zone = null;
		if (cfg.pad === 'stick') {
			zone = stick();
		} else {
			const s = 'width:56px;height:56px;border-radius:12px;';
			button('◀', 'Left', s + 'left:16px;bottom:78px;');
			button('▶', 'Right', s + 'left:136px;bottom:78px;');
			button('▲', 'Up', s + 'left:76px;bottom:138px;');
			button('▼', 'Down', s + 'left:76px;bottom:18px;');
		}
		const r = 'width:68px;height:68px;border-radius:50%;';
		const small = labels.a.length > 2 || labels.b.length > 2 ? 'font-size:12px;' : '';
		const a = button(labels.a, cfg.a, r + small);
		const b = button(labels.b, cfg.b, r + small);
		const pill = 'padding:6px 12px;border-radius:8px;font-size:12px;';
		const pills = [];
		if (cfg.select) pills.push(button(labels.select, cfg.select, pill));
		pills.push(button(labels.start, cfg.start, pill));
		const canvas = document.getElementById('canvas');
		// the SOUND / FULLSCREEN toolbar would sit under the A / B buttons: at the top
		const toolbar = document.getElementById('toolbar');
		const set = (el, css) => Object.assign(el.style, { left: 'auto', right: 'auto', top: 'auto', bottom: 'auto', transform: 'none' }, css);
		const place = () => {
			// the black bands beside the game (landscape phones): the buttons go there, never over the picture
			const c = canvas ? canvas.getBoundingClientRect() : null;
			const band = c ? Math.min(c.left, innerWidth - c.right) : 0;
			if (band >= 72) {
				const w = Math.round(band);
				set(a, { right: (w - 68) / 2 + 'px', bottom: '28px' });
				set(b, { right: (w - 68) / 2 + 'px', bottom: '112px' });
				let y = 8;
				if (toolbar) {
					// in the left band, one button per row
					set(toolbar, { left: '8px', top: '8px', width: (w - 16) + 'px', flexDirection: 'column' });
				}
				pills.forEach((p) => {
					set(p, { right: '0px', top: y + 'px', width: (w - 32) + 'px', margin: '0 8px', textAlign: 'center' });
					y += p.offsetHeight + 8;
				});
				if (zone) {
					zone.style.width = w + 'px';
					zone.restX = w / 2;
					zone.base.style.left = zone.restX + 'px';
				}
				return;
			}
			pills.forEach((p) => Object.assign(p.style, { width: '', margin: '' }));
			if (toolbar) set(toolbar, { right: '8px', top: '8px', width: '', flexDirection: '' });
			if (zone) {
				zone.style.width = '45%';
				zone.restX = 90;
				zone.base.style.left = '90px';
			}
			set(a, { right: '20px', bottom: '40px' });
			set(b, { right: '104px', bottom: '24px' });
			// bottom centre; on narrow (portrait) screens the bottom is full: top left
			const narrow = innerWidth < 600;
			let x = 8;
			pills.forEach((p, i) => {
				if (narrow) {
					set(p, { top: '8px', left: x + 'px' });
					x += p.offsetWidth + 8;
				} else {
					const shift = pills.length === 1 ? '-50%' : (i === 0 ? '-110%' : '10%');
					set(p, { bottom: '12px', left: '50%', transform: `translateX(${shift})` });
				}
			});
		};
		place();
		addEventListener('resize', place);
		document.addEventListener('fullscreenchange', () => setTimeout(place, 100));
		if (window.ResizeObserver && canvas) new ResizeObserver(place).observe(canvas);
	}

	window.JumPHPTouch = { start, key };
})();
