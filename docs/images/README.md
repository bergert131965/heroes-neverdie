# 截图与配图

| 文件 | 用途 | 尺寸 |
|---|---|---|
| `main-light.png` | README 主图：浅色主题主界面 | 2880×1736 |
| `main-dark.png` | README 折叠区：深色主题 | 2880×1736 |
| `welcome.png` | README 折叠区：首启声明 | 2880×1736 |
| `social-preview.png` | **Settings → Social preview** 用（分享链接时的卡片图） | 1280×640 |

## ⚠️ 截图必须用隔离的 `DSH_HOME`

界面会渲染**真实的工作区与会话列表**。用你自己的 `~/.dsh` 截图，会把真实会话标题
（工作内容、项目名、甚至客户信息）永久写进公开仓库。

正确做法：

```sh
DSH_HOME=$(mktemp -d) npm start
```

这样出来的是空状态：`暂无会话` / `选择工作区开始`。截完把临时目录删掉即可。

`main-light.png` / `main-dark.png` 是按下面这套隔离环境生成的——既没有弹窗、也没有真实会话：

```sh
H=$(mktemp -d)
cat > "$H/settings.yaml" <<'EOF'
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1   # 跳过首启声明
ui-theme:
  preference: dark                      # 深色版改这里
EOF
# 配一个凭据可以让「添加一个 API Key」引导不出现
cp ~/.dsh/.credentials.yaml "$H/" && chmod 600 "$H/.credentials.yaml"
DSH_HOME="$H" npm start
```

> 用完记得删掉那个临时目录——里面有你的 API 凭据副本。

## 自动化截图（可选）

`npm run selftest` 会调用 `webContents.capturePage()`，把一张截图写到 userData 的
`selftest.png`。缺点是它只在探针跑完后抓一帧，**抓不到需要交互才会出现的界面**
（用量面板、置顶、过程行折叠）。那几张目前只能手动拍。

## 重新生成社交预览图

`social-preview.png` 是用 Pillow 合成的：深色底 + 左侧强调条 + `build/icon.png` +
主界面截图（圆角 + 细边框）。改版式时注意：

- 尺寸固定 **1280×640**（GitHub 的推荐比例，2:1）
- 文字用系统字体渲染
- 主图右对齐、垂直居中，宽度占约一半
