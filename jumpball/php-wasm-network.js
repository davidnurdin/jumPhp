/*
 * php-wasm-network: the browser side of PHP's network connections (window.PhpWasmNetwork).
 *
 * The php-wasm engine calls it through the wasmnet extension (ext/wasmnet + js/library_wasmnet.js); PHP uses
 * PhpWasmNetwork\WasmConnection. It can also be used from JavaScript directly (same API).
 *
 * One connection = one WebSocket to the relay server (protocol: php/src/Protocol.php) and, with the 'webrtc'
 * transport, one RTCPeerConnection per other peer of the room, with two DataChannels: 'r' reliable + ordered,
 * 'u' unreliable + unordered (no retransmission: like UDP). The newcomer of a room makes the offers; the
 * relay carries the signalling, and every message to a peer that isn't (yet) reachable directly.
 *
 * Events are queued until PHP polls them: {type, from, data: Uint8Array} (types: php/src/Event.php).
 */
(function (global) {
	'use strict';

	const EV = { OPEN: 1, CLOSE: 2, ERROR: 3, ROOM: 4, PEER_JOIN: 5, PEER_LEAVE: 6, MESSAGE: 7, PEER_TRANSPORT: 8, HOST: 9, PONG: 10 };
	const BROADCAST = 255;
	const MAX_MESSAGE = 65536;
	const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
	const DIRECT_TIMEOUT = 10000;   // ms to open the DataChannels, then the peer stays on the relay
	const encoder = new TextEncoder();
	const bytes = (s) => encoder.encode(typeof s === 'string' ? s : JSON.stringify(s));

	class Connection {
		constructor(url, options) {
			this.options = options || {};
			this.webrtc = this.options.transport === 'webrtc' && typeof RTCPeerConnection !== 'undefined';
			this.iceServers = this.options.iceServers || DEFAULT_ICE;
			this.queue = [];
			this.peers = new Map();      // peer id -> {pc, r, u, direct, chain, timer}
			this.me = -1;
			this.members = new Set();    // the other peers of the room
			this.pings = new Map();
			this.pingId = 1000000;
			this.closedState = false;
			this.ws = new WebSocket(url);
			this.ws.binaryType = 'arraybuffer';
			this.ws.onopen = () => {
				this.push(EV.OPEN);
				// keeps the connection alive (the server drops silent clients; browsers can't send WS pings)
				this.keepAlive = setInterval(() => this.text({ t: 'ping', id: 0 }), 15000);
			};
			this.ws.onclose = (e) => this.closed(e.reason || 'connection closed (' + e.code + ')');
			this.ws.onerror = () => this.push(EV.ERROR, -1, bytes({ code: 'connection', message: "can't reach " + url }));
			this.ws.onmessage = (e) => {
				if (typeof e.data === 'string') {
					this.onControl(e.data);
				} else {
					const all = new Uint8Array(e.data);
					if (all.length) this.push(EV.MESSAGE, all[0], all.slice(1));
				}
			};
		}

		push(type, from = -1, data = new Uint8Array(0)) {
			this.queue.push({ type, from, data });
			if (this.queue.length > 10000) this.queue.splice(0, this.queue.length - 10000);   // nobody polls
		}

		text(message) {
			if (this.ws.readyState !== WebSocket.OPEN) return false;
			this.ws.send(JSON.stringify(message));
			return true;
		}

		control(message) {
			if (message.t === 'ping') this.pings.set(message.id, performance.now());
			if (message.t === 'leave' || message.t === 'create' || message.t === 'join' || message.t === 'quick' || message.t === 'watch') {
				this.dropPeers();
				this.members.clear();
			}
			if (!this.text(message)) this.push(EV.ERROR, -1, bytes({ code: 'not-open', message: 'not connected' }));
			return true;
		}

		onControl(json) {
			let m;
			try { m = JSON.parse(json); } catch (e) { return; }
			switch (m.t) {
				case 'hello':
					// STUN / TURN of the server (short-lived credentials), unless the page chose its own
					if (Array.isArray(m.ice) && m.ice.length && !this.options.iceServers) this.iceServers = DEFAULT_ICE.concat(m.ice);
					break;
				case 'room':
					this.me = m.peer;
					this.members = new Set(m.peers);
					this.push(EV.ROOM, -1, bytes(json));
					if (this.webrtc) for (const peer of m.peers) this.connectPeer(peer, true);
					break;
				case 'peer-join':
					this.members.add(m.peer);
					this.push(EV.PEER_JOIN, m.peer);
					break;
				case 'peer-leave':
					this.members.delete(m.peer);
					this.dropPeer(m.peer);
					this.push(EV.PEER_LEAVE, m.peer);
					break;
				case 'host':
					this.push(EV.HOST, m.peer);
					break;
				case 'error':
					this.push(EV.ERROR, -1, bytes(json));
					break;
				case 'pong': {
					const start = this.pings.get(m.id);
					this.pings.delete(m.id);
					if (start !== undefined && m.id !== 0) this.push(EV.PONG, -1, bytes({ ms: Math.round((performance.now() - start) * 10) / 10 }));
					break;
				}
				case 'signal':
					if (this.webrtc && m.data) this.signal(m.from, m.data);
					break;
			}
		}

		// ---------------------------------------------------------------- WebRTC

		connectPeer(id, initiator) {
			if (this.peers.has(id)) return this.peers.get(id);
			// iceTransportPolicy 'relay': through TURN only (tests, or to hide the players' addresses from each other)
			const pc = new RTCPeerConnection({ iceServers: this.iceServers, iceTransportPolicy: this.options.iceTransportPolicy || 'all' });
			const peer = { pc, r: null, u: null, direct: false, chain: Promise.resolve(), timer: 0 };
			this.peers.set(id, peer);
			pc.onicecandidate = (e) => { if (e.candidate) this.text({ t: 'signal', to: id, data: { candidate: e.candidate.toJSON() } }); };
			pc.onconnectionstatechange = () => {
				if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.setDirect(id, false);
			};
			const bind = (channel) => {
				channel.binaryType = 'arraybuffer';
				peer[channel.label] = channel;
				channel.onopen = () => { if (peer.r && peer.r.readyState === 'open') this.setDirect(id, true); };
				channel.onclose = () => this.setDirect(id, false);
				channel.onmessage = (e) => {
					const data = typeof e.data === 'string' ? encoder.encode(e.data) : new Uint8Array(e.data);
					this.push(EV.MESSAGE, id, data);
				};
			};
			if (initiator) {
				bind(pc.createDataChannel('r', { ordered: true }));
				bind(pc.createDataChannel('u', { ordered: false, maxRetransmits: 0 }));
				peer.chain = peer.chain.then(async () => {
					await pc.setLocalDescription(await pc.createOffer());
					this.text({ t: 'signal', to: id, data: { sdp: pc.localDescription.toJSON() } });
				}).catch((e) => console.warn('[php-wasm-network] offer', e));
			} else {
				pc.ondatachannel = (e) => bind(e.channel);
			}
			// a peer that can't be reached directly (native PHP, strict NAT without TURN): stays on the relay
			peer.timer = setTimeout(() => { if (!peer.direct) this.dropPeer(id); }, DIRECT_TIMEOUT);
			return peer;
		}

		signal(from, data) {
			const peer = this.connectPeer(from, false);
			const pc = peer.pc;
			peer.chain = peer.chain.then(async () => {
				if (data.sdp) {
					await pc.setRemoteDescription(data.sdp);
					if (data.sdp.type === 'offer') {
						await pc.setLocalDescription(await pc.createAnswer());
						this.text({ t: 'signal', to: from, data: { sdp: pc.localDescription.toJSON() } });
					}
				} else if (data.candidate) {
					await pc.addIceCandidate(data.candidate);
				}
			}).catch((e) => console.warn('[php-wasm-network] signal', e));
		}

		setDirect(id, direct) {
			const peer = this.peers.get(id);
			if (!peer || peer.direct === direct) return;
			peer.direct = direct;
			this.push(EV.PEER_TRANSPORT, id, bytes(direct ? 'webrtc' : 'relay'));
			if (!direct) this.dropPeer(id);
		}

		dropPeer(id) {
			const peer = this.peers.get(id);
			if (!peer) return;
			this.peers.delete(id);
			clearTimeout(peer.timer);
			try { peer.pc.close(); } catch (e) { /* already closed */ }
		}

		dropPeers() {
			for (const id of [...this.peers.keys()]) this.dropPeer(id);
		}

		// ---------------------------------------------------------------- data

		/** data: Uint8Array; to: a peer id or BROADCAST. */
		send(data, to, reliable) {
			if (this.ws.readyState !== WebSocket.OPEN || data.length > MAX_MESSAGE) return false;
			if (!this.webrtc || this.peers.size === 0) return this.relay(data, to);
			if (to !== BROADCAST) {
				return this.direct(to, data, reliable) || this.relay(data, to);
			}
			// broadcast: directly to the peers we can reach; through the relay to the others (one relay
			// broadcast when nobody is reached directly)
			const relayed = [];
			for (const id of this.members) {
				if (!this.direct(id, data, reliable)) relayed.push(id);
			}
			if (relayed.length === 0) return true;
			if (relayed.length === this.members.size) return this.relay(data, BROADCAST);
			for (const id of relayed) this.relay(data, id);
			return true;
		}

		direct(id, data, reliable) {
			const peer = this.peers.get(id);
			if (!peer || !peer.direct) return false;
			const channel = reliable ? peer.r : (peer.u && peer.u.readyState === 'open' ? peer.u : peer.r);
			if (!channel || channel.readyState !== 'open') return false;
			try {
				channel.send(data);
				return true;
			} catch (e) {
				return false;
			}
		}

		relay(data, to) {
			const frame = new Uint8Array(data.length + 1);
			frame[0] = to;
			frame.set(data, 1);
			this.ws.send(frame);
			return true;
		}

		state() {
			if (this.closedState) return 3;
			return [0, 1, 2, 3][this.ws.readyState];
		}

		close() {
			this.dropPeers();
			try { this.ws.close(); } catch (e) { /* closed */ }
			this.closed('closed');
		}

		closed(reason) {
			if (this.closedState) return;
			this.closedState = true;
			clearInterval(this.keepAlive);
			this.dropPeers();
			this.push(EV.CLOSE, -1, bytes(reason));
		}
	}

	const connections = new Map();
	let nextHandle = 1;

	const api = {
		version: 1,
		EVENTS: EV,
		BROADCAST,
		/** Returns a handle (> 0). options: JSON string or object {transport: 'ws'|'webrtc', iceServers}. */
		connect(url, options) {
			const opts = typeof options === 'string' ? (options ? JSON.parse(options) : {}) : (options || {});
			if (!opts.iceServers && api.defaults.iceServers) opts.iceServers = api.defaults.iceServers;
			const handle = nextHandle++;
			connections.set(handle, new Connection(url, opts));
			return handle;
		},
		control(handle, message) {
			const c = connections.get(handle);
			return c ? c.control(typeof message === 'string' ? JSON.parse(message) : message) : false;
		},
		send(handle, data, to = BROADCAST, reliable = true) {
			const c = connections.get(handle);
			if (typeof data === 'string') data = encoder.encode(data);
			return c ? c.send(data, to, reliable) : false;
		},
		/** The next event, left in the queue (the wasm side sizes its buffer, then shift()). */
		peek(handle) {
			const c = connections.get(handle);
			return c && c.queue.length ? c.queue[0] : null;
		},
		shift(handle) {
			const c = connections.get(handle);
			const event = c ? c.queue.shift() : null;
			if (c && c.closedState && c.queue.length === 0) connections.delete(handle);
			return event;
		},
		/** Every queued event (JavaScript use). */
		poll(handle) {
			const events = [];
			let event;
			while ((event = api.shift(handle))) events.push(event);
			return events;
		},
		state(handle) {
			const c = connections.get(handle);
			return c ? c.state() : 3;
		},
		close(handle) {
			const c = connections.get(handle);
			if (c) c.close();
		},
		/**
		 * The path to each direct peer: {peer: {local, remote, rtt}} where local / remote are the ICE candidate
		 * types in use ('host', 'srflx': through a NAT with STUN, 'relay': through TURN) and rtt in ms.
		 */
		async stats(handle) {
			const c = connections.get(handle);
			const out = {};
			if (!c) return out;
			for (const [id, peer] of c.peers) {
				if (!peer.direct) continue;
				const report = await peer.pc.getStats();
				let pair = null;
				report.forEach((s) => { if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = s; });
				if (!pair) continue;
				const type = (cid) => { const s = report.get(cid); return s ? s.candidateType : '?'; };
				out[id] = { local: type(pair.localCandidateId), remote: type(pair.remoteCandidateId),
					rtt: pair.currentRoundTripTime !== undefined ? Math.round(pair.currentRoundTripTime * 1000) : null };
			}
			return out;
		},
		/** Defaults for every connection, e.g. PhpWasmNetwork.defaults.iceServers = [{urls: 'turn:...', ...}]. */
		defaults: {},
	};
	global.PhpWasmNetwork = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
