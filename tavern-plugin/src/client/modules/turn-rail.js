// 对话右侧那列刻度（宿主「轮次导航」）：一条 turn/start 一根刻度，失败的尝试、被撤回的输入、
// 被重新生成取代的轮次也各占一根，正文里早就没有它们了，跳过去落不到任何内容上。
//
// 宿主的刻度条目由它自己的对话节点算出来，客户端改不了条目本身；能改的是画出来的那一列。
// tavern 的会话视图给出 railTurns（正文表面里还有内容的轮次），这里按刻度 aria-label 里的
// 轮次号把其余的藏起来——批量重试不再把整列刻度撑满，留下的每一根都点得到东西。
function createTurnRailFilter(root, options) {
	const host = (options && options.window) || window;
	const scope = (root && root.closest && root.closest("[data-conversation-scroll]")) || (root && root.ownerDocument) || document;
	const markSelector = '[class*="_mark"][aria-label]';
	const applied = new WeakMap();
	let allowed = null;
	let frame = 0;
	function turnOf(mark) {
		const match = /第\s*(\d+)\s*轮/.exec(mark.getAttribute("aria-label") || "");
		return match ? Number(match[1]) : null;
	}
	function sync() {
		if (frame) { host.cancelAnimationFrame(frame); frame = 0; }
		const marks = Array.from(scope.querySelectorAll(markSelector));
		for (const mark of marks) {
			const turn = turnOf(mark);
			const hidden = allowed !== null && turn !== null && !allowed.has(turn);
			if (applied.get(mark) === hidden) continue;
			applied.set(mark, hidden);
			if (hidden) mark.setAttribute("data-dsh-tavern-rail-hidden", "");
			else mark.removeAttribute("data-dsh-tavern-rail-hidden");
		}
	}
	function schedule() {
		if (frame) return;
		frame = host.requestAnimationFrame(function () { frame = 0; sync(); });
	}
	// 视图里没有这一栏（旧服务端）时不筛：宁可多几根刻度，也不要凭空藏掉能跳的轮次。
	function apply(turns) {
		allowed = Array.isArray(turns) ? new Set(turns.map(Number).filter(turn => Number.isSafeInteger(turn) && turn > 0)) : null;
		sync();
	}
	const observer = typeof host.MutationObserver === "function" ? new host.MutationObserver(schedule) : null;
	if (observer) observer.observe(scope, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-label", "class"] });
	return {
		apply: apply,
		sync: sync,
		dispose: function () {
			if (observer) observer.disconnect();
			if (frame) host.cancelAnimationFrame(frame);
			frame = 0;
			for (const mark of Array.from(scope.querySelectorAll('[data-dsh-tavern-rail-hidden]'))) mark.removeAttribute("data-dsh-tavern-rail-hidden");
			allowed = null;
		}
	};
}
