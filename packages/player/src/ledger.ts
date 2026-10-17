// The send ledger. What the app sent on each socket, against what the take
// says it sent, so the executor can hand over a reply only once the app asked
// for it.
//
// Sends match by content, not by position. An app that sends two messages
// from two async paths set off by one input (a render's effect and a click
// handler) sends them in either order, depending on how busy the machine is;
// both orders are the same session.
//
// A send the take never made is counted, not failed. It has no reply in the
// log to hold back, so it can't make data run ahead of the app, and apps send
// such messages for reasons the log can't order: an effect that subscribed to
// popstate a moment earlier or later than in the take echoes a navigation the
// recorded one never saw. A send the take did make and the replay never does
// is what holds the take, and fails it after its deadline.

export class SendLedger {
	/** Per socket: how many of each hash the take still has to see sent. */
	private due = new Map<number, Map<number, number>>();
	/** Per socket: how many of each hash the app sent that no entry has claimed yet. */
	private sent = new Map<number, Map<number, number>>();
	/** Sends the take never made, and the first and the latest of them, described. */
	extra = 0;
	firstExtra: string | null = null;
	lastExtra: string | null = null;

	/** `sends`: every send entry of the take, as [socket, hash]. */
	constructor(sends: Iterable<[socket: number, hash: number]>) {
		for (const [s, h] of sends) bump(this.at(this.due, s), h, 1);
	}

	private at(m: Map<number, Map<number, number>>, s: number) {
		let x = m.get(s);
		if (!x) {
			x = new Map();
			m.set(s, x);
		}
		return x;
	}

	/** The app sent a message hashing to `h` on socket `s`. `what` describes it, for the report. */
	note(s: number, h: number, what: () => string) {
		const sent = this.at(this.sent, s);
		const have = (sent.get(h) ?? 0) + 1;
		if (have > (this.at(this.due, s).get(h) ?? 0)) {
			// Not one the take is waiting for: it claims nothing.
			this.extra++;
			this.lastExtra = `socket ${s}: ${what()}`;
			this.firstExtra ??= this.lastExtra;
			return;
		}
		sent.set(h, have);
	}

	/** The app has sent what the entry for (`s`, `h`) waits for. */
	has(s: number, h: number): boolean {
		return (this.at(this.sent, s).get(h) ?? 0) > 0;
	}

	/** The entry for (`s`, `h`) is applied: that send is accounted for. */
	claim(s: number, h: number) {
		bump(this.at(this.sent, s), h, -1);
		bump(this.at(this.due, s), h, -1);
	}
}

function bump(m: Map<number, number>, k: number, by: number) {
	const n = (m.get(k) ?? 0) + by;
	if (n <= 0) m.delete(k);
	else m.set(k, n);
}
