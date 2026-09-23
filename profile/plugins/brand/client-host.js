/**
 * HeRoes 品牌 —— desktop profile 自有插件的 host 半。
 *
 * 这个插件只做浏览器侧的事：往侧栏的两个品牌槽位注册标记与字标。没有 host 路由、
 * 没有投影、没有凭据，所以 `apply` 是空的。
 *
 * 它必须存在，是因为入口契约：`dsh-client-modules` 靠「从模块位置向上找最近的
 * package.json」读取 `dsh.client` 声明来组合浏览器 bundle，而 Loader 行必须指向一个
 * 真实可解析的主入口（manifest 的 `main`）。文件名与 `main` 保持一致。
 * @module dsh-desktop-profile/plugins/brand
 */
const name = "brand";

/** 没有任何 host 侧依赖。 */
const inject = [];

/**
 * 空的热座。
 * @param ctx - host 侧插件上下文。
 */
function apply(ctx) {
  ctx.logger?.info?.("brand: browser-only surface (no host routes)");
}

export { apply, inject, name };
