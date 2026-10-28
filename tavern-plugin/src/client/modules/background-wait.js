function backgroundWaitMessage(progress, now) {
    if (!progress || now - progress.startedAt < 60000) return "";
    const plugin = progress.plugin ? "插件「" + progress.plugin + "」正在结算。" : "";
    return plugin + backgroundPhaseMessage(progress, now);
}
function backgroundPhaseMessage(progress, now) {
    if (progress.phase === "model") {
        return now - progress.lastProgressAt < 15000
            ? "模型仍在输出思考、正文或工具参数，后台任务尚未完成。可以继续等待或停止后台；已生成的正文会保留。"
            : "正在等待模型 API 的有效输出。连续 5 分钟没有有效输出会停止并报错；也可以现在停止后台，保留已生成的正文。";
    }
    return progress.phase === "tool"
        ? "正在执行后台工具或等待人物卡变量处理。若长时间没有完成，可以停止后台；已生成的正文会保留。"
        : "正在准备后台请求。若长时间没有完成，可以停止后台；已生成的正文会保留。";
}
function TavernBackgroundWait(props) {
    const [progress, setProgress] = React.useState(null);
    const [now, setNow] = React.useState(Date.now);
    const active = props.activity?.busy || props.activity?.phase === "pending";
    React.useEffect(function () {
        let disposed = false, loading = false;
        setProgress(null);
        if (!active) return;
        async function refresh() {
            setNow(Date.now());
            if (loading) return;
            loading = true;
            try {
                const result = await rpc("getBackgroundProgress", {}, props.sessionId);
                if (!disposed) setProgress(result.progress);
            } catch (_) { /* Existing task status and stop controls remain usable. */ }
            finally { loading = false; }
        }
        void refresh();
        const timer = window.setInterval(refresh, 5000);
        return function () { disposed = true; window.clearInterval(timer); };
    }, [active, props.sessionId, props.activity?.operationId]);
    const message = backgroundWaitMessage(progress || {phase:"preparing",startedAt:props.activity?.updatedAt || now}, now);
    if (!active || !message) return null;
    return React.createElement("div", {className:"dsh-tavern-status-section", role:"status"},
        React.createElement("p", null, message),
        React.createElement(TavernStopBackgroundAction, {sessionId:props.sessionId}));
}
const BACKGROUND_RUN_TASKS = { settlement: "变量结算", ledger: "手动记账", candidate: "生成选项", "worldbook-filter": "世界书预筛", "style-reference": "文风联想", "stage-director": "舞台导演", phone: "手机", "character-design": "人物设计", subagent: "子任务", edit: "编辑" };
const BACKGROUND_RUN_STATUS = { queued: "排队中", running: "运行中", completed: "完成", failed: "失败", cancelled: "已取消" };
function backgroundRunName(run) {
    return run.task === "plugin" ? "插件「" + (run.plugin || "未知") + "」" : BACKGROUND_RUN_TASKS[run.task] || run.task;
}
function backgroundRunSeconds(run, now) {
    const from = run.startedAt || run.queuedAt, to = run.endedAt || now;
    return Math.max(0, Math.round((to - from) / 1000)) + " 秒";
}
// Every background run of this game since the server started: what runs, what waits, what failed.
function TavernBackgroundRuns(props) {
    const [runs, setRuns] = React.useState([]);
    const [now, setNow] = React.useState(Date.now);
    React.useEffect(function () {
        let disposed = false, loading = false;
        setRuns([]);
        async function refresh() {
            if (loading) return;
            loading = true;
            try {
                const result = await rpc("getBackgroundRuns", {}, props.sessionId);
                if (!disposed) { setRuns(Array.isArray(result.runs) ? result.runs : []); setNow(Date.now()); }
            } catch (_) { /* The list is diagnostic; the rest of the panel stays usable. */ }
            finally { loading = false; }
        }
        void refresh();
        const timer = window.setInterval(refresh, 4000);
        return function () { disposed = true; window.clearInterval(timer); };
    }, [props.sessionId]);
    if (!runs.length) return null;
    const h = React.createElement;
    const count = status => runs.filter(run => run.status === status).length;
    const summary = [["running", "运行"], ["queued", "排队"], ["failed", "失败"]].filter(([status]) => count(status)).map(([status, label]) => label + " " + count(status)).join(" · ") || "无运行中的任务";
    return h("section", { className: "dsh-tavern-status-section dsh-tavern-background-runs", "aria-label": "后台任务" },
        h("details", null,
            h("summary", null, h("span", { className: "dsh-tavern-status-label" }, "后台任务"), h("span", { className: "dsh-tavern-background-runs-summary" }, summary)),
            h("ol", null, runs.map(run => h("li", { key: run.id, className: "dsh-tavern-background-run " + run.status, title: run.error || undefined },
                h("span", { className: "dsh-tavern-background-run-name" }, backgroundRunName(run)),
                h("span", null, BACKGROUND_RUN_STATUS[run.status] || run.status),
                h("span", null, (run.turn ? "第 " + run.turn + " 轮 · " : "") + (run.lane === "resident" ? "常驻" : "临时") + (run.model ? " · " + run.model : "") + " · " + backgroundRunSeconds(run, now)),
                run.error ? h("span", { className: "dsh-tavern-background-run-error" }, run.error) : null)))));
}
