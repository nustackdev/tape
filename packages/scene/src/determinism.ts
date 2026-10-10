// Determinism. An app that mints ids in the browser (time + randomness)
// would mint different ones in the replay than in the take, and the server
// frames would then name things the replayed app never made. So the take and
// the replay share their randomness and their clock:
//
// - Math.random and crypto draw from one seeded generator. Every recorded
//   event notes how many draws came before it, and the replay jumps there, so
//   a stray call in between can't shift everything after it.
// - Date.now and new Date() are pinned while an input event is handled, and
//   the event notes that time, so the replay handles it at the same moment.
//
// Both run in the recorder's inject script too, as source text. Keep them
// self-contained: no imports, nothing from module scope.

export interface Randomness {
	/** Draws so far. */
	draws(): number;
	/** Put the generator at `n` draws from the seed. */
	seek(n: number): void;
}

export function installRandom(win: Window & typeof globalThis, seed: number): Randomness {
	// mulberry32
	const gen = (s: number) => {
		let a = s >>> 0;
		return () => {
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	};
	let next = gen(seed);
	let n = 0;
	const random = () => {
		n++;
		return next();
	};
	const seek = (target: number) => {
		if (target < n) {
			next = gen(seed);
			n = 0;
		}
		while (n < target) random();
	};
	win.Math.random = random;
	const fill = <T extends ArrayBufferView | null>(arr: T): T => {
		if (!arr) return arr;
		const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (random() * 256) | 0;
		return arr;
	};
	const uuid = () => {
		const b = fill(new Uint8Array(16));
		b[6] = ((b[6] as number) & 0x0f) | 0x40;
		b[8] = ((b[8] as number) & 0x3f) | 0x80;
		const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
		return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
	};
	try {
		Object.defineProperty(win.crypto, "getRandomValues", { value: fill, configurable: true });
		Object.defineProperty(win.crypto, "randomUUID", { value: uuid, configurable: true });
	} catch {}
	return { draws: () => n, seek };
}

/** Route Date.now and new Date() through `clock`. Everything else of Date stays. */
export function installClock(win: Window & typeof globalThis, clock: () => number): void {
	const Real = win.Date;
	const TapeDate = function (this: unknown, ...args: unknown[]) {
		if (!new.target) return new Real(clock()).toString();
		return args.length
			? new (Real as unknown as new (...a: unknown[]) => Date)(...args)
			: new Real(clock());
	} as unknown as DateConstructor;
	Object.defineProperties(TapeDate, Object.getOwnPropertyDescriptors(Real));
	Object.defineProperty(TapeDate, "now", { value: clock, configurable: true, writable: true });
	TapeDate.prototype.constructor = TapeDate;
	win.Date = TapeDate;
}
