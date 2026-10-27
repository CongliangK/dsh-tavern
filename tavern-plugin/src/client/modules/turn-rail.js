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
	let rail = null, frame = 0, allowed = null, accept = null, textTurns = null, turnsKey = "";
	const ticks = new Map();
	function turnOf(mark) {
		const match = /第\s*(\d+)\s*轮/.exec(mark.getAttribute("aria-label") || "");
		return match ? Number(match[1]) : null;
	}
	function hostMarks() {
		return Array.from(scope.querySelectorAll(markSelector)).filter(mark => turnOf(mark) !== null);
	}
	// 宿主的悬浮预览由它自己那根刻度的事件驱动；我们的刻度替它收发同样的指针/焦点事件，
	// 预览面板本身保持可见（见 tavern.css 里 nav[data-dsh-tavern-rail-hidden] [role=tooltip]）。
	function preview(mark, on) {
		try {
			const related = on ? undefined : doc.body;
			const type = on ? "pointermove" : "pointerout";
			if (typeof host.PointerEvent === "function") mark.dispatchEvent(new host.PointerEvent(type, { bubbles: true, relatedTarget: related }));
			if (on && typeof host.FocusEvent === "function") mark.dispatchEvent(new host.FocusEvent("focusin", { bubbles: true }));
		} catch (error) { /* 预览只是锦上添花，宿主改结构时不能挡住跳转 */ }
	}
	// 宿主那一列的条目也来自整档目录，里面混着已经被清空的尝试轮。默认规则只认两类：
	// 正文里真的画出来的轮次（有高度的行），以及还没加载、点了会先拉历史的轮次。
	// 「只上划一小段」的正是前者里的反例——有行、行是零高度，点过去只剩空气。
	function visibleTurns() {
		const visible = new Set();
		for (const row of scope.querySelectorAll("[data-chat-turn], [data-turn]")) {
			const turn = Number(row.getAttribute("data-chat-turn") || row.getAttribute("data-turn"));
			if (!Number.isSafeInteger(turn) || turn <= 0) continue;
			if (row.getBoundingClientRect().height > 0) visible.add(turn);
		}
		return visible;
	}
	function defaultAccept(turn, mark, visible) {
		// 当前所在的那一轮永远留着：读者要能看见自己在第几轮。
		if (mark.getAttribute("aria-current") === "true") return true;
		// 目录里说得出这一轮写了什么的才留：目录两样都空的轮次（只剩系统消息、工具行、
		// 被清空的尝试）没有正文可落，悬浮预览也是空的。
		if (textTurns !== null) {
			if (!textTurns.has(turn)) return false;
			if (/markUnloaded/.test(String(mark.className || ""))) return true;
			return visible.has(turn);
		}
		if (/markUnloaded/.test(String(mark.className || ""))) return true;
		return visible.has(turn);
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
			button.setAttribute("data-mark-kind", /markUnloaded/.test(String(mark.className || "")) ? "unloaded" : "loaded");
			button.className = "dsh-tavern-turn-rail-tick";
			button.setAttribute("aria-label", jumpLabel.replace("{turn}", String(turn)));
			button.setAttribute("data-turn", String(turn));
			button.addEventListener("click", function () { mark.click(); });
			button.addEventListener("pointerenter", function () { preview(mark, true); });
			button.addEventListener("pointerleave", function () { preview(mark, false); });
			button.addEventListener("focus", function () { preview(mark, true); });
			button.addEventListener("blur", function () { preview(mark, false); });
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
	// 行高会随折叠/流式变化，逐帧重扫整份正文太贵：合并到 120ms 一次。
	function schedule() {
		if (frame) return;
		frame = host.setTimeout(function () { frame = 0; sync(); }, 120);
	}
	function sync() {
		if (frame) { host.clearTimeout(frame); frame = 0; }
		const marks = hostMarks();
		const hostNav = marks.length ? marks[0].closest("nav") : null;
		if (hostNav) hostNav.setAttribute(hiddenAttribute, "");
		const pairs = marks.map(mark => ({ mark, turn: turnOf(mark) }));
		const visible = accept !== null || allowed !== null ? null : visibleTurns();
		const turns = pairs
			.filter(pair => accept !== null ? accept(pair.turn) : allowed !== null ? allowed.has(pair.turn) : defaultAccept(pair.turn, pair.mark, visible))
			.map(pair => pair.turn);
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
	// 接受轮次数组、判定函数，或者 { text: Set }（目录里写得出正文的轮次，默认规则的依据）。
	function apply(turns) {
		accept = null;
		allowed = null;
		textTurns = null;
		if (typeof turns === "function") accept = turns;
		else if (turns && !Array.isArray(turns) && typeof turns === "object") {
			if (turns.text && typeof turns.text.has === "function") textTurns = turns.text;
			else if (Array.isArray(turns.turns) && turns.turns.length) allowed = new Set(turns.turns.map(Number));
		} else if (Array.isArray(turns) && turns.length) {
			allowed = new Set(turns.map(Number).filter(turn => Number.isSafeInteger(turn) && turn > 0));
		}
		sync();
	}
	const observer = typeof host.MutationObserver === "function" ? new host.MutationObserver(schedule) : null;
	if (observer) observer.observe(scope, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-label", "aria-current", "class", "style"] });
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
			if (frame) { host.clearTimeout(frame); frame = 0; }
			host.removeEventListener("scroll", onScroll, true);
			host.removeEventListener("resize", onScroll);
			if (frame) { host.clearTimeout(frame); frame = 0; }
			for (const mark of Array.from(scope.querySelectorAll("[" + hiddenAttribute + "]"))) mark.removeAttribute(hiddenAttribute);
			if (rail) rail.remove();
			rail = null; ticks.clear(); allowed = null; accept = null; textTurns = null; turnsKey = "";
		}
	};
}
