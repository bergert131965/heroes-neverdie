/**
 * HeRoes 品牌插件自测。
 *
 * 跑法：
 *   node profile/plugins/brand/selftest-client.mjs
 *
 * 这个插件没有 UI 逻辑可测（两个组件都是无 hook 的纯 svg），所以自测盯的是三件
 * 真正会出错的事：
 *
 *   1. **bundle 能加载**、两个槽位都注册了（只注册一个会让另一个回落成版本号文本）；
 *   2. **尺寸契约**：整行宽度必须落在实测的 216px 品牌行预算内，并接近原资产的 188px。
 *      这条是防止有人「顺手」把字标调大——按 24px 高渲染会到 230.7px，右边徽章会被
 *      `overflow:hidden` 直接裁掉；
 *   3. **资产完整性**：三条 path 都已注入（没有残留占位符）、几何常量与资产一致、
 *      配色只用 currentColor、徽章带 evenodd 挖空、可访问性标记正确。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundleSource = readFileSync(join(here, "client.js"), "utf8");

let failures = 0;
let checks = 0;
const ok = (condition, label) => {
  checks++;
  if (condition) process.stdout.write(`  ok   ${label}\n`);
  else {
    failures++;
    process.stdout.write(`  FAIL ${label}\n`);
  }
};
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, `${label}${a === b ? "" : ` — 实际 ${a}，期望 ${b}`}`);
};

// ── 1. 加载与注册 ──────────────────────────────────────────────────────────
process.stdout.write("\n[1] bundle 加载与槽位注册\n");
const h = (type, props) => ({ type, props: props ?? {} });
let entry;
globalThis.window = { __ModuleLoader__: { load: (value) => { entry = value; } } };
new Function(bundleSource)();
const bundle = entry.factory((name) => {
  if (name === "react/jsx-runtime") return { jsx: h, jsxs: h, Fragment: "Fragment" };
  throw new Error(`unexpected require: ${name}`);
});
const T = bundle.__test;

eq(entry.id, "dsh-desktop-brand", "模块 id");
eq(bundle.inject, ["slots"], "导出 inject");
ok(typeof bundle.apply === "function", "导出 apply");

const registrations = [];
bundle.apply({
  slots: {
    inject: (_name, callback) => callback(),
    register: (options, component) => {
      registrations.push({ options, component });
      return () => {};
    },
  },
});
eq(registrations.length, 3, "三个槽位都注册了（侧栏标记/字标 + 首页 hero 标记）");
eq(
  registrations.map((r) => r.options.name).sort(),
  ["conversation.hero.brand.mark", "sidebar.brand.mark", "sidebar.brand.name"],
  "槽位名正确",
);
eq(registrations.filter((r) => r.options.id === undefined).length, 3, "都不带 id（与官方一致，靠停用官方行让位）");
eq(
  T.HeroBrandMark({ size: 34 }).props.width,
  34,
  "hero 标记按宽度渲染（与官方 HeroFish 的 width:34 约定一致）",
);

// ── 2. 尺寸契约 ────────────────────────────────────────────────────────────
process.stdout.write("\n[2] 尺寸契约（实测预算）\n");
/** 实测：侧栏 280px，品牌行（flex:1 + overflow:hidden 的 button）216px。 */
const BRAND_ROW_BUDGET = 216;
/** 品牌行内部 identity 行的 gap，以及原资产整行宽度。 */
const IDENTITY_GAP = 8;
const ORIGINAL_ROW_WIDTH = 188;

const markWidth = T.MARK_HEIGHT * T.MARK_RATIO;
const rowWidth = markWidth + IDENTITY_GAP + T.NAME_WIDTH;
ok(rowWidth <= BRAND_ROW_BUDGET, `整行 ${rowWidth.toFixed(1)}px 不超品牌行预算 ${BRAND_ROW_BUDGET}px`);
ok(Math.abs(rowWidth - ORIGINAL_ROW_WIDTH) <= 6, `整行 ${rowWidth.toFixed(1)}px 接近原资产 ${ORIGINAL_ROW_WIDTH}px（布局零变化）`);
ok(T.NAME_WIDTH <= BRAND_ROW_BUDGET - 24 - IDENTITY_GAP, `字标 ${T.NAME_WIDTH}px 不超可用上限 ${BRAND_ROW_BUDGET - 24 - IDENTITY_GAP}px`);
// 反例：按原资产的 24px 高渲染会被裁掉——这条把「为什么不能按高度定尺寸」钉住
const naiveWidth = 24 * T.NAME_RATIO;
ok(naiveWidth > BRAND_ROW_BUDGET - 24 - IDENTITY_GAP, `反例成立：按 24px 高渲染会到 ${naiveWidth.toFixed(1)}px，超出可用宽度（会被 overflow:hidden 裁掉徽章）`);

// ── 3. 资产完整性 ──────────────────────────────────────────────────────────
process.stdout.write("\n[3] 资产完整性\n");
ok(!/__[A-Z_]+__/.test(bundleSource), "没有残留的占位符");
for (const [name, value] of [["MARK_PATH", T.MARK_PATH], ["NAME_PATH", T.NAME_PATH], ["BADGE_PATH", T.BADGE_PATH]]) {
  ok(typeof value === "string" && value.length > 100 && value.startsWith("M"), `${name} 已注入且像一条路径（${value.length} 字符）`);
}
eq(T.MARK_VIEW_BOX, "0 0 560 484", "标记 viewBox 与资产一致");
eq(T.NAME_VIEW_BOX, "0 -15.3779 149.7071 15.5771", "字标 viewBox 与资产一致");
ok(Math.abs(T.MARK_RATIO - 560 / 484) < 1e-9, "标记宽高比与 viewBox 自洽（1.157）");
ok(Math.abs(T.NAME_RATIO - 149.7071 / 15.5771) < 1e-9, "字标宽高比与 viewBox 自洽（9.611）");
ok(new Set([T.MARK_PATH, T.NAME_PATH, T.BADGE_PATH]).size === 3, "三条 path 互不相同（字标里不含标记，不会重复出现）");
ok(!/fill="(?!currentColor|none)/.test(bundleSource), "配色只用 currentColor / none，没有硬编码颜色");
ok(!/<style/.test(bundleSource), "没有 style 块");

// ── 4. 组件渲染 ────────────────────────────────────────────────────────────
process.stdout.write("\n[4] 组件渲染\n");
const inspect = (node, path, problems) => {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((child, index) => inspect(child, `${path}[${index}]`, problems));
    return;
  }
  if (!("type" in node)) return;
  if (node.type === undefined || node.type === null) problems.push(`${path}: type 为 ${String(node.type)}`);
  const children = node.props === undefined ? undefined : node.props.children;
  if (children !== undefined) inspect(children, `${path}.children`, problems);
};
for (const [label, component, props] of [["BrandMark", T.BrandMark, { size: 24 }], ["BrandMark（无 props）", T.BrandMark, {}], ["BrandName", T.BrandName, {}]]) {
  const problems = [];
  let tree;
  try {
    tree = component(props);
  } catch (error) {
    problems.push(`抛出异常：${error instanceof Error ? error.message : String(error)}`);
  }
  if (tree !== undefined) inspect(tree, label, problems);
  ok(problems.length === 0, `${label} 渲染无异常${problems.length === 0 ? "" : ` — ${problems.join("; ")}`}`);
}

const mark = T.BrandMark({ size: 24 });
eq(mark.props.viewBox, T.MARK_VIEW_BOX, "标记用资产的 viewBox");
eq(mark.props["aria-hidden"], "true", "标记对读屏隐藏（装饰性）");
ok(Math.abs(mark.props.width - T.MARK_HEIGHT * T.MARK_RATIO) < 1e-9, "标记宽度按高度×比例算");eq(mark.props.children.props.fillRule, "evenodd", "标记的方框靠 evenodd 挖空");

const name = T.BrandName({});
eq(name.props.viewBox, T.NAME_VIEW_BOX, "字标用资产的 viewBox");
eq(name.props.role, "img", "字标是可访问图像（外层品牌 button 才有名字）");
ok(typeof name.props["aria-label"] === "string" && name.props["aria-label"].length > 0, `字标有 aria-label：${String(name.props["aria-label"])}`);
eq(name.props.children.length, 2, "字标两条 path：文字 + 徽章");
eq(name.props.children[1].props.fillRule, "evenodd", "徽章靠 evenodd 挖空（因此不需要额外的反色 token）");

process.stdout.write(`\n${failures === 0 ? "全部通过" : "存在失败"}：${checks - failures}/${checks}\n`);
if (failures > 0) process.exit(1);
