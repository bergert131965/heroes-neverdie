#!/usr/bin/env node
/**
 * Brand patch for the HeRoes NEVERDIE desktop shell.
 *
 * The upstream client bundles are build artifacts that hardcode DeepSeek
 * product identity in places neither the slot system nor the locale API can
 * reach, so this patch rewrites them as anchored literal replacements:
 *
 *   - `dsh-client-ui-layout`        `productTitle` — drives both the OS window
 *     title and `document.title`.
 *   - `dsh-client-ui-conversation`  the home-hero headline, both locales
 *                                   (`探索未至之境` / `Into the Unknown`).
 *   - `dsh-client-ui-settings-models` the first-run notice and the API-key
 *                                   onboarding line, replaced with this shell's
 *                                   own copy. The onboarding line especially
 *                                   must not claim DeepSeek is the only
 *                                   provider: the `dsh-llm-pi-ai`
 *                                   multi-provider adapter is mounted (dormant
 *                                   until settings supply routes).
 *
 * Deliberately NOT patched: `dsh-client-connection`'s web-search sample (not
 * user-visible) and the remaining *descriptive* references to the upstream,
 * which the upstream brand guidelines expressly permit. See `docs/brand.md`.
 *
 * Usage:
 *   node scripts/patch-brand.mjs           # patch + verify
 *   node scripts/patch-brand.mjs --check   # verify only, never writes
 *
 * `npm install` / `npm ci` overwrites `node_modules`, so re-run this after
 * either. Re-running is safe: an already-patched file is reported rather than
 * rewritten, and a file whose anchors no longer match fails loudly instead of
 * being silently half-patched.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");

const NM = "node_modules/@deepseek-ai";

/**
 * Product identity written into the shell. Change these to re-brand.
 * `heroHeadline` is the large line beside the mark on the empty state.
 */
const BRAND = {
	productTitle: "HeRoes NEVERDIE",
	heroHeadlineZh: "英雄永不谢幕",
	heroHeadlineEn: "Heroes Never Die",
};

/**
 * First-run copy, replacing upstream's own preview notice.
 *
 * `\\n\\n` below is intentional: the bundles store these as JS string literals,
 * so the paragraph break has to be the two characters `\` + `n`, not a real
 * newline.
 */
const NOTICE = {
	welcomeTitleZh: "关于 HeRoes NEVERDIE",
	welcomeTitleEn: "About HeRoes NEVERDIE",
	welcomeBodyZh:
		"HeRoes NEVERDIE 是一个基于 DeepSeek Harness（DSH）构建的非官方桌面外壳，会话、设置与凭据与 dsh web / CLI 互通。\\n\\n" +
		"目前仍处早期阶段，我们最想要的是产品层面的反馈：使用中的 bug、交互上的别扭、以及功能建议，都欢迎提过来。上游 DSH 迭代很快，本应用会跟着它的节奏推进——上游一升级，桌面外壳与各项定制会一并适配。\\n\\n" +
		"本项目与 DeepSeek 无隶属关系。",
	welcomeBodyEn:
		"HeRoes NEVERDIE is an unofficial desktop shell built on DeepSeek Harness (DSH). Sessions, settings and credentials are shared with dsh web and the CLI.\\n\\n" +
		"This is early-stage software, and product feedback is what we most want: bug reports, interaction friction and feature ideas are all welcome. Upstream DSH is still evolving quickly, so this shell follows its release cadence — when DSH moves, the shell and its customizations are updated to match.\\n\\n" +
		"Not affiliated with or endorsed by DeepSeek.",
	onboardingDescriptionZh:
		"填入 DeepSeek 官方 API Key 即可开始；也可以稍后在「设置 → 模型」中添加其他提供方（OpenAI 兼容网关、自建服务等）。",
	onboardingDescriptionEn:
		"Enter a DeepSeek API key to start, or add another provider later under Settings → Models (OpenAI-compatible gateways, self-hosted servers, and more).",
};

/** Every intentional change, as anchored literal replacements. */
const targets = [
	{
		file: `${NM}/dsh-client-ui-layout/lib/client.js`,
		patches: [
			{
				name: "productTitle (window title + document.title)",
				from: `const productTitle = "DeepSeek Harness";`,
				to: `const productTitle = ${JSON.stringify(BRAND.productTitle)};`,
			},
		],
	},
	{
		file: `${NM}/dsh-client-ui-conversation/lib/client.js`,
		patches: [
			{
				name: "hero.headline (zh)",
				from: `"hero.headline": "探索未至之境"`,
				to: `"hero.headline": ${JSON.stringify(BRAND.heroHeadlineZh)}`,
			},
			{
				name: "hero.headline (en)",
				from: `"hero.headline": "Into the Unknown"`,
				to: `"hero.headline": ${JSON.stringify(BRAND.heroHeadlineEn)}`,
			},
		],
	},
	{
		file: `${NM}/dsh-client-ui-settings-models/lib/client.js`,
		patches: [
			{
				name: "welcomeTitle (zh)",
				from: `welcomeTitle: "内测声明"`,
				to: `welcomeTitle: "${NOTICE.welcomeTitleZh}"`,
			},
			{
				name: "welcomeTitle (en)",
				from: `welcomeTitle: "Internal Testing Notice"`,
				to: `welcomeTitle: "${NOTICE.welcomeTitleEn}"`,
			},
			{
				name: "welcomeBody (zh)",
				from: `welcomeBody: "DeepSeek Harness 目前的 0.1 版本仍处在面向 Harness 开发者进行测试的阶段，还有许多地方需要持续改进和打磨，希望听取广大开发者的反馈建议。预计 DeepSeek Harness 的核心插件以及基础 API 都会在接下来的一段时间内快速迭代、持续演化。\\n\\n我们期待与全球开发者一起，在开源、开放、可复用、可组合的基础设施之上，共同探索智能上限。欢迎全球 Harness 开发者加入 DSH 插件生态。"`,
				to: `welcomeBody: "${NOTICE.welcomeBodyZh}"`,
			},
			{
				name: "welcomeBody (en)",
				from: `welcomeBody: "DeepSeek Harness 0.1 remains in testing for Harness developers. Many areas need further improvement, and we welcome feedback from the developer community. DeepSeek Harness's core plugins and foundational APIs will continue to evolve rapidly over the coming months.\\n\\nWe look forward to exploring the limits of intelligence with developers around the world, building on open-source, open, reusable, and composable infrastructure. We welcome Harness developers everywhere to join the DSH plugin ecosystem."`,
				to: `welcomeBody: "${NOTICE.welcomeBodyEn}"`,
			},
			{
				name: "onboardingDescription (zh)",
				from: `onboardingDescription: "配置 DeepSeek 官方模型，即可开始使用。"`,
				to: `onboardingDescription: "${NOTICE.onboardingDescriptionZh}"`,
			},
			{
				name: "onboardingDescription (en)",
				from: `onboardingDescription: "Configure the official DeepSeek provider to start building."`,
				to: `onboardingDescription: "${NOTICE.onboardingDescriptionEn}"`,
			},
		],
	},
];

let failed = false;

for (const target of targets) {
	const path = join(root, target.file);
	if (!existsSync(path)) {
		console.log(`missing        ${target.file}`);
		console.log("               -> not installed; run `npm ci` first");
		failed = true;
		continue;
	}

	let text = readFileSync(path, "utf8");
	const notes = [];
	let wrote = false;

	for (const patch of target.patches) {
		const hasFrom = text.includes(patch.from);
		const hasTo = text.includes(patch.to);

		if (hasTo && !hasFrom) {
			notes.push(`already  ${patch.name}`);
			continue;
		}
		if (!hasFrom && !hasTo) {
			notes.push(`ANCHOR MISSING  ${patch.name}`);
			failed = true;
			continue;
		}
		if (hasFrom && hasTo) {
			notes.push(`AMBIGUOUS  ${patch.name} (old and new both present)`);
			failed = true;
			continue;
		}
		const first = text.indexOf(patch.from);
		if (text.indexOf(patch.from, first + 1) >= 0) {
			notes.push(`AMBIGUOUS  ${patch.name} (anchor appears more than once)`);
			failed = true;
			continue;
		}
		if (checkOnly) {
			notes.push(`WOULD PATCH  ${patch.name}`);
			failed = true;
			continue;
		}
		text = `${text.slice(0, first)}${patch.to}${text.slice(first + patch.from.length)}`;
		wrote = true;
		notes.push(`patched  ${patch.name}`);
	}

	if (wrote && !checkOnly) writeFileSync(path, text);

	const state = wrote ? "patched" : checkOnly ? "checked" : "unchanged";
	const bytes = statSync(path).size;
	console.log(`${state.padEnd(14)}${target.file}`);
	for (const note of notes) console.log(`               - ${note}`);
	console.log(`               ${bytes} bytes`);
}

if (failed) {
	console.log("\nbrand patch NOT clean (see WOULD PATCH / ANCHOR MISSING / AMBIGUOUS above)");
	process.exit(1);
}
console.log(`\nbrand patch OK (${checkOnly ? "verified" : "applied"})`);
