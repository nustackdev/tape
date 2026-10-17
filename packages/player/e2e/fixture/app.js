// A tiny app on a websocket: asks the server on a click, after a delay, and
// shows the answer; routes on a link. Notes what happened, for the test.
window.__events = [];
const note = (k) => window.__events.push(k);
const out = document.getElementById("out");
const url = new URL("/ws", location.href);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
const ws = new WebSocket(url);
// A stream ("b:<n>" frames) is drawn the way a framework does it: each frame
// queues a render a task later, and one render draws all that came before it.
// Each render costs a few ms, so a replay that gives every frame a render of its
// own pays for hundreds.
window.__burst = { n: 0, order: true, renders: 0 };
const renders = new MessageChannel();
let queued = false;
renders.port1.onmessage = () => {
	queued = false;
	const end = performance.now() + 3;
	while (performance.now() < end) {}
	window.__burst.renders++;
	out.textContent = `frames ${window.__burst.n}`;
};
ws.onmessage = (e) => {
	const d = String(e.data);
	if (d.startsWith("b:")) {
		const b = window.__burst;
		if (Number(d.slice(2)) !== b.n) b.order = false;
		b.n++;
		if (!queued) {
			queued = true;
			renders.port2.postMessage(null);
		}
		return;
	}
	note(`got:${d}`);
	out.textContent = d;
};
document.getElementById("ask").addEventListener("click", () => {
	// Two sends from one click, the order the take had them in reversed: a ping at
	// once, the question later. Both are the same session.
	ws.send("ping");
	// The app takes its time: the answer must not arrive before the question.
	setTimeout(() => {
		note("sent");
		ws.send("ask");
	}, 400);
});
document.getElementById("go").addEventListener("click", (e) => {
	e.preventDefault();
	history.pushState({ n: 1 }, "", "/two");
	note("nav");
});
