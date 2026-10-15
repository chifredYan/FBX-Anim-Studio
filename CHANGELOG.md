# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)与 [Keep a Changelog](https://keepachangelog.com/zh-CN/) 规范。

## [1.1.0] - 2026-10-15

### 新增 — Godot 动画导出（.tres）

两条管线均可直接产出 **Godot 4.3+ 原生 Animation 资源**，Godot 工程拿来即用：

- **网页版**：导出区新增「Godot 动画」按钮。每骨 position / rotation / scale 三条轨道，路径 `Skeleton3D:<骨名>`；骨名转换为 Godot 导入约定（`mixamorig:Hips` → `mixamorig_Hips`）；位置按 FBX 原始单位 → 米换算（×0.01），旋转透传；全程未变化的轨道塌缩为首尾两帧以控制体积
- **命令行版**：默认产出 `animation.tres`（`--no-tres` 关闭）。在 Godot 内用真实骨架直接生成，数值完全精确
- **批量导出**：`export_via_receiver.js` 随 PNG 序列一并产出 `<base>_anim.tres`
- 用法：`AnimationLibrary` + `add_animation_library` 挂到任意同名骨架的 AnimationPlayer（README 有示例）
- 自检工具：`godot_project/tools/roundtrip_test.gd` 可把任意 `.tres` 挂到已导入的骨架上读回位姿

### 修复

- **`bones.json` 的 local TRS 全为单位值**：three.js FBXLoader 会为每根骨头建一对孪生节点——动画挂在外层「动画节点」上，而 `Skeleton.bones` 里是同名内层节点且 local 恒为 identity（世界矩阵正常，所以渲染与 global 导出一直是对的）。导出改读孪生节点的 local；修复后与命令行版逐帧比对：四元数角度差 ≤ 0.11°、位置差 ≤ 0.35mm（两引擎插值精度）、缩放零差
- **「消除位移」失效**：原地播放此前钉的是内层 identity 节点，改钉孪生节点后生效

### 验证

- Godot 回环测试：网页版与命令行版生成的 `.tres` 挂到导入的 Maria 骨架播放，195 条轨道全部解析到真实骨骼；读回位姿与源数据一致（静态骨零误差，髋骨 0.05° = float32 精度极限）

## [1.0.0] - 2026-10-15

首个公开发布版本，包含两条互相独立的 FBX 动画提取管线，产物约定一致（朝向语义、`bones.json` 格式相同）。

### 新增 — FBX Anim Studio（网页版）

- 浏览器内导入 FBX（按钮或拖拽），外置贴图 PNG 可一并上传挂载
- 加载时单位归一化到 1.75 m，厘米级 Mixamo 模型同样处理
- 朝向自动判定：统计 `Left*` / `Right*` 骨骼世界空间 X 分布识别角色自身 forward，四个朝向为精确 90° 整数倍
- 仿 Autodesk FBX Review 的绝对水平视角（选方向时锁定旋转），「自由」模式恢复轨道旋转
- 取景框实时预览导出范围（固定世界原点，随缩放变化）
- 逐帧播放：空格 / `←` `→` / 时间轴点按拖动，fps 12–60
- 消除位移与人物居中两个开关，序列导出不漂移
- 缩放 0.25×–4×（默认 0.60×），滚轮 / 滑块 / 导出三方共享
- 四类导出：单帧 PNG、PNG 序列 ZIP（含 `meta.json`）、GIF、骨骼 JSON
- 背景可控：绿 / 白预设、纯透明（PNG 保 alpha，GIF 走专用透明索引）、自定义色盘
- 固定机位取景：第 0 帧标定机位（像素质心迭代收敛）全序列共享，帧间不抖
- 操作信息栏贴底布局，随浏览器高度自动伸缩

### 新增 — fbx-anim-tool（命令行版）

- 一条命令产出 `bones.json` + 30 fps PNG 序列 + GIF + 缩略图 contact sheet
- `--no-render --no-gif` 仅提取骨骼数据；`--facing` / `--cam` 朝向与镜头独立可配
- 原地播放（髋骨 x/z 归零、保留 y），GIF 帧延时按累积时间轴分配（实测 30.00 fps）
- `make_gif.py` 可独立使用（仅依赖 Pillow）
- Godot 4.7 + Vulkan 离屏渲染，无需 Blender / FBX SDK

### 新增 — 工程化

- MIT License
- `.gitignore`（导出产物与第三方 FBX 模型不入库）
- 中英双语 README（`README.md` / `README.en.md`，顶部互相切换）
- 批量导出链路：`save_server.py` 接收服务 + `export_via_receiver.js` 页内脚本 + `batch_export.sh` 驱动
- 代码内版本号：网页版 `VERSION`（app.js，界面与导出元数据可见）、命令行版 `__version__`（`--version` 可查，写入 `meta.json`）

[1.1.0]: https://github.com/chifredYan/FBX-Anim-Studio/releases/tag/v1.1.0
[1.0.0]: https://github.com/chifredYan/FBX-Anim-Studio/releases/tag/v1.0.0
