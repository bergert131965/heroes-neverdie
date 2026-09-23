# HeRoes 品牌（desktop profile 自有插件）

把侧栏左上那块官方 `DeepSeek Harness` 换成 HeRoes，接管两个品牌槽位：

| 槽位 | 资产 | viewBox | 宽高比 | 渲染尺寸 |
| --- | --- | --- | --- | --- |
| `sidebar.brand.mark` | 标记（方框挖空 + 两根竖条） | `0 0 560 484` | 1.157 | 20.0 × 17.3 |
| `sidebar.brand.name` | 字标 `HeRoes` + 反白徽章 `[NEVER DIE]` | `0 -15.3779 149.7071 15.5771` | 9.611 | 159.6 × 16.6 |

整行 20.0 + 间隙 8 + 159.6 = **187.6px**，与原资产的 188px 一致——**布局零变化**。

## 文件

| 文件 | 角色 |
|---|---|
| `client-host.js` | Host 半：空的热座（入口契约需要） |
| `client.js` | Browser 半：两条资产内联为 path 字符串 + 两个占用者 |
| `package.json` | 双面包声明（`main` + `dsh.client`） |
| `selftest-client.mjs` | 自测：槽位注册、尺寸契约、资产完整性、组件渲染 |

挂载位置是 `profile/cordis.patch.yml`：一个 `insert` 行加一条顶层覆盖行。

```yaml
# 必须停用官方品牌行，否则两个占用者会抢同一个 single 槽位
- id: ui-brand-official
  disabled: true

- insert:
    - id: brand
      name: ./plugins/brand/client-host.js
```

## 为什么必须停用官方那一行

`@deepseek-ai/dsh-client-ui-brand-official` 注册时**没有带 `id`**，所以槽位文档里那条
「reusing a shipped id puts you in THAT cell and replaces it」的覆盖路径用不上；而两个槽位都是
`kind: "single"`（渲染取 `entriesOfSlot(key)[0]`），两个占用者会**抢**，谁先不确定。

停用之后**两个槽位会一起回落**：标记回落成壳自带的鱼形，字标回落成本地构建版本号文本。
所以本插件**必须同时注册两个**——只换一个，另一个会变成版本号。

## 尺寸不是拍的，是实测量出来的

1440 宽窗口下（`probe/brand-metrics-probe.js` 实测）：

| 项 | 实测 |
| --- | --- |
| 侧栏 | 280px |
| 品牌行（`flex:1` + **`overflow-x: hidden`** 的 `<button>`） | **216px**，x 从 16 起 |
| identity 行 | `gap: 8px`，**`height: 24px`（写死）** |
| 标记槽 | `flex:none`，**不可压缩** |
| 字标槽可用上限 | **184px**（216 − 24 标记 − 8 间隙） |
| 原资产整行 | 188px |

**关键结论：字标必须按宽度定尺寸，不能按高度。** 新字标宽高比 9.611，若照原资产那样按
24px 高渲染会到 **230.7px**，超出 184px，右端的 `NEVER DIE` 徽章会被 `overflow:hidden`
**直接裁掉**（不是换行，是切掉）。所以 `NAME_WIDTH = 159.6` 定死宽度，高度由比例推出。

自测里专门放了一条**反例断言**钉住这件事：按 24px 高渲染必然超出可用宽度。

反过来的一个小权衡：字标高度从 24 降到 16.6，但**观感并没有变小**——新 viewBox 是紧裁的
（15.577 高、无降部），16.6px 高时字面约 16px；旧 viewBox 是 24 高但含降部与行距，字面也
就 16–17px。

## 配色

两条资产**只用 `currentColor`**，所以明暗主题自动反色，不需要额外 token：

- 标记的方框靠 `fill-rule="evenodd"` 挖空（外框 + 内框两条子路径）。
- 徽章同样是 evenodd 挖空——**这是一个真挖空**，不是「反色底色 + 反色文字」。好处是不依赖
  `--dsw-alias-label-primary-inverted` 之类的 token；代价是挖空处透出**背后**颜色，所以 hover
  时徽章内的字会染上 hover 底色（与官方原本的观感接近）。

`probe/` 与自测都断言了「没有硬编码颜色、没有 style 块」。

## 可访问性

侧栏那个品牌容器是一个 `<button>`，而官方两个 svg 都带 `aria-hidden="true"` —— 于是这个
按钮**没有可访问名**。这里改成：标记保持 `aria-hidden`（它是装饰），字标用
`role="img"` + `aria-label="HeRoes NEVER DIE"`，按钮因此有了名字。

## 资产来源与再生成

两条资产的 path 数据是**从 SVG 文件灌入**的，不是手抄：先用占位符
（`__MARK_PATH__` / `__NAME_PATH__` / `__BADGE_PATH__`）写 `client.js`，再用脚本从
`mark.svg` / `wordmark.svg` 读出 `d` 替换。自测里有「没有残留占位符」和「三条 path 互不
相同」两条断言兜底。

`wordmark.svg` 里**不含标记**（它的 path#1 与 `wordmark-text-only.svg` 内容一致，path#2 才是
徽章），所以字标槽不会重复出现标记。`wordmark-text-only.svg` 是「`HeRoes` 但去掉徽章」——
如果哪天想要更大的字（去掉徽章后宽高比 5.142，可以按 24px 高渲染、仅 123px 宽），换那张即可。

## 可调项

只有两个常量，都在 `client.js` 顶部：

- `MARK_HEIGHT = 17.3` —— 标记高度（原资产 17.66）。想把标记调大/调小改这一个。
- `NAME_WIDTH = 159.6` —— 字标宽度。上限 184；调大会挤掉右侧余量，超过就裁徽章。

## 自测

```bash
cd heroes-neverdie
node profile/plugins/brand/selftest-client.mjs
```

33 项断言。除常规的注册与渲染检查，重点是两组契约：

- **尺寸契约**：整行 ≤ 216px 且 ≈188px；字标 ≤ 184px；外加那条「按 24px 高渲染必然被裁」的反例。
- **资产完整性**：无残留占位符、三条 path 非空且互不相同、viewBox 与宽高比自洽、只用
  `currentColor`、徽章带 evenodd、可访问性标记正确。

真机验证口径（`probe/brand-metrics-probe.js`）：在隔离环境里量 `viewBoxes`、两槽位 rect、
`identity` 行宽度，并用「`overflow:hidden` 祖先的右边界 − 字标右边界」判断是否被裁。
实测结果：标记 20×17、字标 160×17、整行 188px、`overhangRight = -28`（还有 28px 余量，未裁切）。

启动后要看到效果需要**重启 App**（桌面端没有客户端 HMR）。
