/**
 * 置顶 / 挂起 —— desktop profile 自有插件的 host 半。
 *
 * 这个插件只有浏览器半有活干：标记按会话键存在浏览器 localStorage 里，既不需要
 * host 路由、投影，也不需要凭据，所以 host 半的 `apply` 是空的。
 *
 * 它之所以必须存在，是因为入口契约：`dsh-client-modules` 靠「从模块位置向上找最近
 * 的 package.json」读取 `dsh.client` 声明来组合浏览器 bundle，而 Loader 行必须指向
 * 一个真实可解析的主入口（manifest 的 `main`）。文件名与 `main` 保持完全一致，
 * 让 Loader 行、清单、bundle 三者对齐（同目录 usage-panel 的实测约束 #3）。
 * @module dsh-desktop-profile/plugins/pinned
 */
const name = "pinned";

/** 没有任何 host 侧依赖：状态全在浏览器。 */
const inject = [];

/**
 * 空的热座：不注册服务、不注册路由。
 * @param ctx - host 侧插件上下文。
 */
function apply(ctx) {
  ctx.logger?.info?.("pinned: browser-only surface (no host routes)");
}

export { apply, inject, name };
