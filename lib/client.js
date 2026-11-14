// dsh-session-rotate — 浏览器端（只有一个东西：水位）
//
// 右下角一个小胶囊，显示「水位 38%」——就是当前会话离轮换门槛走了多少。
// 点一下立刻刷新，鼠标停在上面看细节（最近多少、峰值多少、阈值多少）。
// 不做拖动、不做设置页、不读模型，每 30 秒问一次宿主那条本机路由。
window.__ModuleLoader__.load({
	id: "dsh-session-rotate",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const API = "/api/session-rotate";
		const POLL_MS = 30000;
		const ID = "dsh-rotate-meter";

		const NUM = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "?");

		function el(tag, css, text) {
			const node = document.createElement(tag);
			if (css) node.style.cssText = css;
			if (text != null) node.textContent = text;
			return node;
		}

		function mount() {
			if (typeof document === "undefined" || !document.body) return null;
			if (document.getElementById(ID)) return null; // 已经挂过

			const root = el("div",
				"position:fixed;right:18px;bottom:238px;z-index:2147482900;display:flex;align-items:center;gap:6px;" +
				"padding:4px 9px;border-radius:999px;cursor:pointer;user-select:none;" +
				"background:var(--dsw-surface-1,rgba(28,28,30,.86));color:var(--dsw-text-primary,inherit);" +
				"border:1px solid var(--dsw-border-default,rgba(127,127,127,.26));" +
				"box-shadow:0 6px 18px rgba(0,0,0,.22);backdrop-filter:blur(8px);" +
				"font-size:10px;line-height:1;letter-spacing:.02em;font-variant-numeric:tabular-nums;");
			root.id = ID;

			const dot = el("span", "width:5px;height:5px;border-radius:50%;background:rgba(127,127,127,.6);flex:0 0 auto;");
			const label = el("span", "white-space:nowrap;", "水位 …");
			root.appendChild(dot);
			root.appendChild(label);
			document.body.appendChild(root);

			let timer = null;
			let dead = false;

			function paint(data) {
				if (!data || !data.current) {
					dot.style.background = "rgba(127,127,127,.6)";
					label.textContent = "水位 ?";
					root.title = "读不到：宿主路由 /api/session-rotate 没响应（插件可能没起来）";
					return;
				}
				const c = data.current;
				const pct = Math.round((c.pressure / data.rotateTokens) * 100);
				const approx = c.accurate ? "" : "≈";
				label.textContent = pct >= 100 ? "该换车了" : "水位 " + approx + (pct < 1 ? "<1" : pct) + "%";
				if (pct >= 100) dot.style.background = "var(--dsw-color-danger,#f85149)";
				else if (pct >= 75) dot.style.background = "var(--dsw-color-warning,#d29922)";
				else dot.style.background = "var(--dsw-color-success,#2ea043)";
				root.title = [
					"最近一次请求 " + NUM(c.tokens) + " tokens",
					"历史峰值 " + NUM(c.peak) + " tokens",
					"门槛 " + NUM(data.rotateTokens) + "（提醒线 " + NUM(data.warnTokens) + "）",
					"换车还剩 " + NUM(Math.max(0, data.rotateTokens - c.pressure)) + " tokens",
					"会话 " + c.sessionId,
					c.accurate ? "" : "日志正在写，这次是按字节粗估（≈）",
					data.enabled ? "" : "插件是关着的",
					data.dryRun ? "dry-run：只记日志不真换" : "",
				].filter(Boolean).join("\n");
			}

			async function poll() {
				if (dead) return;
				try {
					const r = await fetch(API, { headers: { accept: "application/json" } });
					const text = await r.text();
					let j = null;
					try { j = JSON.parse(text); } catch { throw new Error("宿主返回的不是 JSON（HTTP " + r.status + "）"); }
					paint(j);
				} catch (e) {
					paint(null);
				}
			}

			root.addEventListener("click", () => { poll(); });
			root.style.transition = "opacity .2s";

			poll();
			timer = setInterval(poll, POLL_MS);

			return () => {
				dead = true;
				if (timer) clearInterval(timer);
				root.remove();
			};
		}

		// 加载顺序：客户端模块可能比 DOM 就绪早，所以重试几次
		function ensureMount(tries) {
			if (mount()) return;
			if (tries > 0) setTimeout(() => ensureMount(tries - 1), 500);
		}

		function apply(ctx) {
			ensureMount(40);
			// 宿主那边的路由由 host 半边提供；这里只管画。
		}

		exports.apply = apply;
		exports.inject = [];
		exports.__internals = { ensureMount };
		return module.exports;
	},
});
