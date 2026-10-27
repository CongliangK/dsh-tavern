// 对话右侧那列刻度（宿主「轮次导航」）：一条 turn/start 一根刻度，失败的尝试、被撤回的输入、
// 被重新生成取代的轮次也各占一根——正文里早就没有它们了，跳过去落不到任何内容。
//
// 宿主按自己的条目索引摆刻度、按条目数算高度，所以「藏掉多余刻度」会在原位留空洞、还会撑出
// 滚动条。这里反过来做：把宿主那列收起来，按会话视图给的 railTurns（正文表面里还有内容的轮次）
// 另画一列等距刻度。点击不重写跳转逻辑，直接转给宿主原来的刻度按钮——它知道「先加载历史再跳」。
function createTurnRailFilter(root, options) {
	const host = (options && options.window) || window;
	const doc = host.document || (root && root.ownerDocument) || document;
	const scope = (root && root.closest && root.closest("[data-conversation-scroll]")) || doc.body || doc.documentElement;
	const markSelector = '[class*="_mark"][aria-label]';
	const hiddenAttribute = "data-dsh-tavern-rail-hidden";
	const label = (options && options.label) || "轮次导航";
	const jumpLabel = (options && options.jumpLabel) || "跳转到第 {turn} 轮";
	const narrow = (options && options.narrow) || 900;
	let rail = null, frame = 0, allowed = null, turnsKey = "";
	const ticks = new Map();
	function turnOf(mark) {
		const match = /第\s*(\d+)\s*轮/.exec(mark.getAttribute("aria-label") || "");
		return match ? Number(match[1]) : null;
	}
	function hostMarks() {
		return Array.from(scope.querySelectorAll(markSelector)).filter(mark => turnOf(mark) !== null);
	}
	function build(turns, marks) {
		const box = doc.createElement("nav");
		box.className = "dsh-tavern-turn-rail";
		box.setAttribute("aria-label", label);
		ticks.clear();
		for (const turn of turns) {
			const mark = marks.find(item => turnOf(item) === turn);
			if (!mark) continue;
			const button = doc.createElement("button");
			button.type = "button";
			button.className = "dsh-tavern-turn-rail-tick";
			button.setAttribute("aria-label", jumpLabel.replace("{turn}", String(turn)));
			button.setAttribute("data-turn", String(turn));
			button.addEventListener("click", function () { mark.click(); });
			ticks.set(turn, button);
			box.appendChild(button);
		}
		return box;
	}
	function mirror(marks) {
		let active = null;
		for (const mark of marks) {
			if (mark.getAttribute("aria-current") === "true") { active = turnOf(mark); break; }
		}
		for (const [turn, button] of ticks) {
			if (turn === active) button.setAttribute("data-active", "");
			else button.removeAttribute("data-active");
		}
	}
	// 宿主刻度居中在会话视口里；我们的列跟着同一块区域走，窗口变化时重算。
	function place() {
		if (!rail) return;
		const rect = scope.getBoundingClientRect();
		const visible = rect.width > narrow && rect.height > 96;
		rail.hidden = !visible;
		if (!visible) return;
		rail.style.right = Math.max(0, Math.round(host.innerWidth - rect.right)) + 12 + "px";
		rail.style.top = Math.round(rect.top + rect.height / 2) + "px";
	}
	function schedule() {
		if (frame) return;
		const next = function () { frame = 0; sync(); };
		frame = host.requestAnimationFrame ? host.requestAnimationFrame(next) : host.setTimeout(next, 16);
	}
	function sync() {
		if (frame) { host.cancelAnimationFrame ? host.cancelAnimationFrame(frame) : host.clearTimeout(frame); frame = 0; }
		const marks = hostMarks();
		const hostNav = marks.length ? marks[0].closest("nav") : null;
		if (hostNav) hostNav.setAttribute(hiddenAttribute, "");
		const present = marks.map(turnOf);
		const turns = allowed === null ? present : present.filter(turn => allowed.has(turn));
		const key = turns.join(",");
		if (key !== turnsKey) {
			turnsKey = key;
			if (rail) rail.remove();
			rail = turns.length ? build(turns, marks) : null;
			if (rail) doc.body.appendChild(rail);
		}
		if (rail) {
			mirror(marks);
			place();
		}
	}
	// 视图里没有这一栏、或者还是空表（会话刚打开、表面还没挂上）时不筛：宁可多几根刻度，
	// 也不要凭空藏掉能跳的轮次。真正的筛选等视图给出非空的 railTurns 再开始。
	function apply(turns) {
		const list = Array.isArray(turns) ? [...new Set(turns.map(Number).filter(turn => Number.isSafeInteger(turn) && turn > 0))].sort((left, right) => left - right) : [];
		allowed = list.length ? new Set(list) : null;
		sync();
	}
	const observer = typeof host.MutationObserver === "function" ? new host.MutationObserver(schedule) : null;
	if (observer) observer.observe(scope, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-label", "aria-current"] });
	const resize = typeof host.ResizeObserver === "function" ? new host.ResizeObserver(schedule) : null;
	if (resize) resize.observe(scope);
	const onScroll = function () { schedule(); };
	host.addEventListener("scroll", onScroll, true);
	host.addEventListener("resize", onScroll);
	return {
		apply: apply,
		sync: sync,
		dispose: function () {
			if (observer) observer.disconnect();
			if (resize) resize.disconnect();
			host.removeEventListener("scroll", onScroll, true);
			host.removeEventListener("resize", onScroll);
			if (frame) { host.cancelAnimationFrame ? host.cancelAnimationFrame(frame) : host.clearTimeout(frame); frame = 0; }
			for (const mark of Array.from(scope.querySelectorAll("[" + hiddenAttribute + "]"))) mark.removeAttribute(hiddenAttribute);
			if (rail) rail.remove();
			rail = null; ticks.clear(); allowed = null; turnsKey = "";
		}
	};
}
