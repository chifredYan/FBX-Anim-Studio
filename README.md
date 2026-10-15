# FBX Anim Studio

**语言 / Language：[简体中文](README.md) · [English](README.en.md)**

> 浏览器端的 FBX 骨骼动画查看、微调与导出工具：导入 FBX（含外置贴图）→ 归一化 / 居中 / 定朝向 → 播放逐帧检查 → 导出 PNG 序列、GIF 与骨骼 JSON。纯前端零安装，另附一条 Godot 命令行管线，无需 Blender / FBX SDK。
>
> A browser-based FBX skeletal animation inspector & exporter. Pure frontend, no install, no build step.



![Version](https://img.shields.io/badge/version-1.1.0-blue.svg)

![License](https://img.shields.io/badge/license-MIT-green.svg)

![Python](https://img.shields.io/badge/python-3.10%2B-blue.svg)

![three.js](https://img.shields.io/badge/three.js-r160-000000.svg)

![Godot](https://img.shields.io/badge/godot-4.7-478cbf.svg)

![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)

**当前版本：v1.1.0** — 变更记录见 [CHANGELOG.md](CHANGELOG.md)

## 目录

- [项目简介](#项目简介)
- [功能特性](#功能特性)
- [界面截图](#界面截图)
- [快速开始](#快速开始)
- [使用指南](#使用指南)
- [输出数据格式](#输出数据格式)
- [项目结构](#项目结构)
- [技术要点](#技术要点)
- [环境要求](#环境要求)
- [已知限制](#已知限制)
- [License](#license)

---

## 项目简介

本仓库包含**两条互相独立的 FBX 动画提取管线**，产物约定一致（同样的朝向语义、同样的 `bones.json` 格式）：

| 管线                          | 入口                 | 渲染方式                    | 适用场景                        |
| --------------------------- | ------------------ | ----------------------- | --------------------------- |
| **FBX Anim Studio**（网页版，推荐） | 本仓库根目录 | three.js + WebGL        | 人工检查、逐帧微调、单条/少量动画导出；零安装     |
| **fbx-anim-tool**（命令行版）     | `fbx_anim_tool.py` | Godot 4.7 + Vulkan 离屏渲染 | 无人值守批量提取、只要骨骼数据 / 序列图 / GIF |

典型工作流：网页版里把取景、朝向、缩放调到满意 → 用命令行管线把同一套参数批量跑完整个角色库。

---

## 功能特性

### FBX Anim Studio（网页版）

- **导入即用**：按钮或拖拽导入 FBX；贴图是外置 PNG（如 Mixamo 的 `Maria *_0.png`）时一并上传即可挂到材质上
- **自动归一化**：加载时统一缩放到 1.75 m 高，厘米单位的 Mixamo 模型同样处理；跨模型相机、网格、关节球尺寸一致
- **朝向自动判定**：统计所有 `Left*` / `Right*` 骨骼的世界空间 X 分布，自动识别角色自身 forward 是 +Z 还是 −Z，四个朝向选项因此都是**精确的 90° 整数倍**
- **仿 Autodesk FBX Review 的视角**：选 left / right / front / back 时进入绝对水平视角（俯仰角 0，地平线穿过画面中心），旋转被关闭以保证任何时候都是标准侧视 / 正视；「自由」模式恢复完整轨道旋转
- **取景框**：视口里的橙色方框即导出画面的实际范围，固定在世界原点、随缩放实时改变大小
- **逐帧播放**：空格播放 / 暂停，`←` `→` 逐帧，时间轴点击 / 拖动跳帧，fps 12–60 可选
- **消除位移 / 人物居中**：原地播放（x/z 钉回基准、保留垂直起伏）；逐帧把人物钉在画面正中，序列不漂移
- **四类导出**：单帧 PNG、PNG 序列 ZIP（含 `meta.json`）、GIF、骨骼 JSON
- **Godot 动画导出**：一键生成 Godot 原生 Animation 资源（`.tres`），挂到 AnimationPlayer 即可播放
- **背景可控**：绿 / 白预设、纯透明（PNG 保留 alpha）、自定义色盘；GIF 透明走专用调色板索引，硬边抠图
- **固定机位取景**：序列导出先用第 0 帧标定机位（骨骼粗对准 + 像素质心迭代收敛），整个序列共用，帧间相机纹丝不动

### fbx-anim-tool（命令行版）

- **一条命令**出全套产物：`bones.json` + 30 fps PNG 序列 + GIF + 缩略图 contact sheet + **Godot Animation 资源（`animation.tres`）**
- **原生 .tres**：在 Godot 内用真实骨架直接生成，数值完全精确（`--no-tres` 关闭）
- **只要骨骼数据**：`--no-render --no-gif` 秒级完成
- **朝向 / 镜头独立**：`--facing` 只旋转模型，`--cam` 固定世界镜头方向
- **原地播放**：默认把髋骨位置轨道 x/z 归零（保留 y），跑步循环原地播放
- **GIF 帧率精确**：按理想累积时间轴分配增量延时，实测 30.00 fps（24 / 60 fps 同样精确）

---

## 界面截图

![网页版界面](docs/app-ui.png)

四条朝向对比（front / left / right / back，均为精确 90°）：

![朝向对比](docs/facing.png)

命令行管线产物 —— 30 fps 循环 GIF 与缩略图网格：

![动画 GIF](docs/animation.gif)

![缩略图网格](docs/contact-sheet.png)

网页版导出的 1024×1024 透明背景序列帧（Maria Run）：

![导出帧样例](docs/export-frame.png)

---

## 快速开始

### 方式一：网页版（推荐）

```bash
python -m http.server 8799
# 浏览器打开 http://127.0.0.1:8799/
```

Windows 也可以直接双击 `start.bat`（自动起服务并打开浏览器）。

> ES module 在 `file://` 下会被浏览器拦截，必须走 http。所有依赖已本地化到 `vendor/`，**离线可用**。

### 方式二：命令行版

```bash
# 最常用：从 FBX 生成 left 朝向的 GIF + 骨骼数据
python fbx_anim_tool.py "D:\Downloads\3D 动作人物模型\Maria\Maria Run.fbx" -o output/run --sheet
```

输出到 `output/run/`：

| 文件                  | 内容                                      |
| ------------------- | --------------------------------------- |
| `bones.json`        | 每帧 65 根骨骼的 local / global TRS（四元数 xyzw） |
| `animation.tres`    | Godot 4.3+ Animation 资源，可直接挂 AnimationPlayer |
| `frame_0000.png` …  | 30 fps 逐帧画面                             |
| `animation.gif`     | 30 fps 循环 GIF                           |
| `meta.json`         | 动画名、帧数、骨骼表、朝向、可用 clip 列表                |
| `contact_sheet.png` | 缩略图网格，快速肉眼校验（`--sheet` 开启）              |

依赖 Godot 可执行文件，默认路径用环境变量覆盖：

```bash
export FBXAT_GODOT="E:\AI\Godot_v4.7.2-stable_mono_win64\Godot_v4.7.2-stable_mono_win64_console.exe"
export FBXAT_HOST_PROJECT="D:\path\to\any\godot\project"
```

---

## 使用指南

### 网页版

**导入与贴图**

1. 点「导入 FBX」或把 `.fbx` 直接拖进视口。模型自动归一化到 1.75 m、落地居中、面朝左。
2. 贴图是外置 PNG 时点「上传贴图」一起选上（如 `Maria Idle_0.png` ~ `Maria Idle_2.png`）；已内嵌贴图则无需操作。
3. 日志栏会打出「朝向检测」与「单位归一化」结果，可据此确认导入是否符合预期。

**播放与检查**

- 空格播放 / 暂停，`←` `→` 逐帧；时间轴点击 / 拖动跳帧。
- 「骨骼:开」显示骨架线与关节小球，可直接在视口点球选中骨骼（左侧骨架树联动高亮）。
- 「消除位移」（默认关）：去掉动画里人物向前走 / 跑的位移，让他原地做动作；垂直起伏保留。关闭时导出的骨骼 JSON 会带上真实走位。
- 「人物居中」（默认开）：逐帧把人物钉在画面正中，导出的 GIF / PNG 序列不会左右漂移。

**取景与朝向**

- **缩放**：滚轮或工具栏滑块；滑块聚焦后 `←` / `→` 微调 0.01，`Shift+←/→` 粗调 0.1，双击回默认。**导出按当前缩放取景**，默认 0.60×。
- **取景框**（默认开）：橙色方框内 = 导出画面的实际范围。框固定在世界原点不随动作晃动，随缩放实时改变大小。
- **朝向**：left / right / front / back（默认 left）。相机固定不动，只旋转模型：
  | 选项    | 角色朝向（屏幕坐标）          |
  | ----- | ------------------- |
  | front | 正对镜头（+Z）            |
  | left  | 正面逆时针 90° → 屏幕左（−X） |
  | right | 正面顺时针 90° → 屏幕右（+X） |
  | back  | 背对镜头（−Z）            |
- 选四个方向时进入**绝对水平视角**（相机与注视点等高、俯仰角 0），旋转关闭（拖动 = 平移，滚轮 = 缩放）；选「自由」恢复轨道旋转。`⟲ 复位视角` 拉回标准水平位并把缩放复位为 0.60×。

**导出**

| 按钮      | 产物                                       |
| ------- | ---------------------------------------- |
| 单帧 PNG  | 当前帧，分辨率可选（256 / 512 / 768 / 1024 / 2048） |
| 序列 ZIP  | 全部帧 PNG + `meta.json`，fflate 打包          |
| GIF     | GIF89a + LZW 编码，帧延时按累积时间轴分配（30 fps 精确）   |
| 骨骼 JSON | 每帧每骨 local + global TRS（与命令行工具同约定）       |
| Godot 动画 | Godot 4.3+ Animation 资源（`.tres`），见下文      |

- 背景色：绿 / 白预设 + 棋盘格「纯透明」+ 自定义色盘，对 PNG（单帧 / 序列）和 GIF 均生效。
- 纯透明模式：PNG 保留 alpha 通道；GIF 走透明索引（255 号槽专用，纯黑不会被误抠）。
- 导出自动隐藏骨骼小球与骨架线；纯透明模式下同时隐藏地面。
- 取景策略：**人物居中开**时整个序列共用第 0 帧标定的机位（帧间不抖）；**关**时机位固定在世界原点，人物按真实走位穿过画面；**单帧 PNG** 对当前帧做完整取景迭代，人物精确落在画面正中。

**Godot 动画（.tres）**——把当前 clip 转成 Godot 原生 Animation 资源，拷进 Godot 工程即可用：

- 轨道：每骨 position / rotation / scale 三条，路径 `Skeleton3D:<骨名>`；骨名按 Godot 导入后的约定转换（`mixamorig:Hips` → `mixamorig_Hips`）；全程未变化的轨道塌缩为首尾两帧，控制文件体积
- 单位：位置按 FBX 原始单位 → 米换算（×0.01，与 Godot 的 FBX 导入一致）；旋转原样透传——three.js 与 Godot 同为右手系、Y-up、四元数 xyzw
- 用法：

  ```gdscript
  var lib := AnimationLibrary.new()
  lib.add_animation("idle", load("res://maria_idle_anim.tres"))
  $AnimationPlayer.add_animation_library("", lib)
  $AnimationPlayer.play("idle")
  ```

- 精度：Godot 回环实测（挂到导入的 Maria 骨架播放后读回位姿）与源数据差 ≤ 0.35 mm / ≤ 0.11°，残差来自两个引擎对 FBX 关键帧的插值精度，肉眼不可辨；要完全精确请用命令行版（在 Godot 内用真实骨架直接生成）
- 前提：FBX 为厘米单位（Mixamo 等）。米制的 FBX 需调整 `app.js` 里的 `FBX_CM_TO_M`

**批量导出（命令行驱动页面）**

把一堆 FBX 按同一套参数批量出序列图，不用手动点：

```bash
# 1) 页面服务（工具本体）      :8799
python -m http.server 8799
# 2) 写盘接收服务（绕过浏览器取消 blob 下载）  :8800
python save_server.py
# 3) 批量跑（可传入任意 FBX 目录，默认 Maria 目录）
bash batch_export.sh "D:/Downloads/3D 动作人物模型/Maria"
```

产物：每个 FBX 一个同名子文件夹，内含 `Maria_Run_f0000.png` …（1024×1024 RGBA 透明）。  
`export_via_receiver.js` 是页内渲染脚本（逐帧 `renderFrameAt` → POST 到接收服务写盘），改分辨率 / 背景 / 缩放就在开头那几行；它由无头浏览器 CLI 驱动，可替换为 Playwright 等任意自动化方案。

### 命令行版

```bash
# 只要骨骼数据，不渲染（最快）
python fbx_anim_tool.py model.fbx -o out --no-render --no-gif

# 指定 clip 与分辨率
python fbx_anim_tool.py model.fbx -a mixamorig_walk --facing left -W 1024 -H 1024

# 60 fps、无限循环
python fbx_anim_tool.py model.fbx --fps 60 --loop 0

# 保留原动画的根位移（默认钉住髋骨，让跑步循环原地播放）
python fbx_anim_tool.py model.fbx --no-in-place

# 不要 Godot 动画资源（默认产出 animation.tres）
python fbx_anim_tool.py model.fbx --no-tres
```

`--facing` 决定角色面朝方向（配合 `--cam side` 即为侧身镜头）：

| 值          | 模型 yaw | 效果           |
| ---------- | ------ | ------------ |
| `left`（默认） | +90°   | 侧身，**面朝画面左** |
| `right`    | −90°   | 侧身，面朝画面右     |
| `front`    | 0°     | 正面朝向镜头       |
| `back`     | 180°   | 背面           |
| 任意数字       | 该角度    | 自定义微调        |

镜头方向 `--cam`：`side`（默认）/ `front` / `three_quarter`。两者互相独立——镜头是世界固定方向，`--facing` 只旋转模型。

**单独使用 GIF 合成器**（不依赖 Godot）：

```bash
python make_gif.py path/to/frames --fps 30 --bg "#17171c" --sheet
```

---

## 输出数据格式

`bones.json`（网页版「骨骼 JSON」与命令行版同约定）：

```jsonc
{
  "animation": "mixamorig_run",
  "fps": 30.0,
  "frame_count": 18,
  "bone_count": 65,
  "facing_yaw_deg": 90.0,
  "convention": {
    "handedness": "left-handed (Godot)",
    "rotation": "quaternion xyzw",
    "pose_space": "bone-local, parent-relative to FBX bone rest"
  },
  "frames": [
    {
      "frame": 0,
      "time": 0.0,
      "local":  [ { "name": "mixamorig_Hips", "t": [x,y,z], "r": [x,y,z,w], "s": [x,y,z] } ],
      "global": [ { "name": "mixamorig_Hips", "t": [x,y,z], "r": [x,y,z,w] } ]
    }
  ]
}
```

`local` 是父级相对位姿，适合喂给引擎的骨骼驱动；`global` 是世界位姿，适合直接做 IK 或碰撞定位（v1.1.0 起 `local` 为真实的父骨相对位姿——此前 three.js FBXLoader 的孪生节点结构导致导出全为单位值）。`bone_names` 给出索引 → 骨骼名的映射。PNG 序列的 `meta.json` 额外记录背景色（`background` 字段）、分辨率与帧数。

---

## 项目结构

```
FBX-Anim-Studio/
├── index.html                # 界面与全部样式（含操作信息栏贴底布局）
├── app.js                    # 网页版主逻辑：加载 / 播放 / 取景 / 导出
├── gifenc.js                 # GIF89a + LZW 编码器
├── start.bat                 # Windows 一键启动（起服务 + 开浏览器）
├── WEBAPP.md                 # 网页版详细文档
├── vendor/                   # three.js r160 及 addons，全本地化
│   ├── three.module.js
│   ├── controls/OrbitControls.js
│   ├── loaders/FBXLoader.js
│   └── libs/fflate.module.js
├── fbx_anim_tool.py          # 命令行版入口（Python 编排）
├── make_gif.py               # PNG 序列 → GIF 合成器（仅依赖 Pillow）
├── godot_project/            # 命令行版依赖的 Godot 工程（GDScript 提取器）
│   └── tools/                # anim_extractor.gd / run_extract.gd / run_extract.tscn
├── save_server.py            # 批量导出用的 CORS 写盘接收服务（:8800）
├── export_via_receiver.js    # 页内逐帧渲染并 POST 写盘的脚本
├── batch_export.sh           # 批量导出驱动脚本
├── clear_outputs.py          # 清理导出产物的小工具
├── diag_center.js            # 取景居中诊断脚本
├── docs/                     # README 用的截图与样例产物
├── input/ output/            # 示例输入与产物（.gitignore，不入库）
├── README.md / README.en.md  # 中英双语项目介绍（顶部互相切换）
├── CHANGELOG.md              # 更新日志（Keep a Changelog + semver）
├── .gitignore
├── .gitattributes
├── LICENSE                   # MIT
└── README.md
```

---

## 技术要点

- **渲染与解析**：three.js r160（`vendor/` 本地化 + importmap），FBXLoader 解析骨架与 AnimationPlayer，OrbitControls 驱动相机；fflate 在浏览器内打包 ZIP
- **单位归一化**：加载时统一缩放到 1.75 m，相机 / 网格 / 关节球尺寸跨模型一致
- **朝向自动检测**：统计所有 `Left*` / `Right*` 骨骼世界空间 X 分布判定角色自身 forward，四个朝向因此是精确 90° 整数倍
- **固定机位取景**：序列导出用第 0 帧标定机位（骨骼粗对准 + 像素质心迭代收敛），全序列共享——帧间相机不动，画面不抖；单帧导出则对当前帧完整迭代
- **原地播放**：采样第 0 帧记录根位置基准，之后每帧把根骨与模型根节点的 x/z 钉回基准（y 保留）
- **缩放模型**：`zoom = 标准取景距离 / 当前相机距离`，滚轮、滑块、导出三方共享同一数值；取景框按 `2·d·tan(fov/2)` 计算世界尺寸并朝向相机（billboard）
- **GIF 编码**：中点切分量化 256 色 + LZW（含 4096 表满重置），帧延时按累积时间取整避免累积误差；透明 GIF 保留 255 号索引专用于透明
- **Godot 离屏渲染**：`--headless` 使用 dummy 渲染器，`get_image()` 只会返回空，因此命令行版以最小窗口（64×64，置于屏幕外）+ Vulkan 后端运行，SubViewport 负责离屏出图
- **批量导出链路**：页内逐帧渲染 → POST 到本机接收服务写盘，绕过无头浏览器取消 blob 下载的问题；git-bash 不展开 `[012]` 括号 glob，贴图按 `_0/_1/_2` 显式列举并忽略大小写
- **Godot 回环自检**：`godot_project/tools/roundtrip_test.gd` 可把任意 `.tres` 挂到已导入该 FBX 的骨架上播放并读回位姿，用于验证导出是否正确

---

## 环境要求

| 管线   | 要求                                                                        |
| ---- | ------------------------------------------------------------------------- |
| 网页版  | 任意现代浏览器（Chrome / Edge / Firefox）；Python 3 仅用于起静态服务（或任意静态服务器）；无需 Node、无需构建 |
| 命令行版 | Python 3.10+、Pillow、Godot 4.x（需 Vulkan 与真实 GPU）                           |

---

## 已知限制

- **命令行版必须真实 GPU**：Godot 的 dummy 渲染器无法离屏出图，虚拟机 / 无 GPU 环境不可用（网页版走 WebGL，无此限制）
- **外部 FBX 首次导入 Godot 较慢**：15 MB FBX 约需 1–3 分钟；已导入过的可用 `--no-import` 跳过
- **批量导出依赖无头浏览器 CLI**：`batch_export.sh` 调用 `agent-browser`，可替换为 Playwright 等任意自动化方案（页内脚本 `export_via_receiver.js` 不变）
- **ES module 不能 `file://` 直开**：网页版必须经 http 访问
- **GIF 无半透明**：透明导出为硬边抠图，半透明边缘请用 PNG

---

## License

本项目基于 [MIT License](LICENSE) 开源。
