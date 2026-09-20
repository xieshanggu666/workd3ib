# 🛡️ 灾害应急指挥与救援资源调度平台

基于 **Vue 3 + Vite + 高德地图 JS API v2.0** 的应急指挥演示系统。

## 功能特性

- **高德地图核心交互**
  - 受灾范围叠加（`Polygon`）、事件覆盖物（`Marker` 脉冲气泡）、人口密度热力图层（`Heatmap`）
  - 多类事件（洪涝/地震/火灾/山体滑坡/台风）按严重等级区分样式
  - 内建地图控件（缩放/比例尺/鹰眼）
- **事件管理**：搜索、类型/等级/状态筛选、事件详情、处置状态流转、处置时间线
- **资源调度**：多个资源库/救援点库存，拖拽式派发物资到受灾点，自动在地图绘制派发路线、估算距离与到达时间（直线 × 路网折算的演示算法）
- **指挥大屏**：在报事件、等级分布、今日派发、受影响群众等实时统计，支持「实时模拟」自动刷新数据
- **多灾情场景**：预置多种 mock 场景（典型洪涝、汛期多点并发），一键切换

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 准备高德 key —— 复制样板文件为 .env 并填入自己的 key
copy .env.example .env
#   编辑 .env：
#   VITE_AMAP_KEY=你自己的高德key
#   （可选）VITE_AMAP_SECURITY_CODE=你的jscode安全密钥

# 3. 启动开发服务器
npm run dev
# 打开 http://localhost:5173
```

> 仓库已通过 `.gitignore` 忽略 `.env`，key 不会进入版本库。`.env.example` 为公开样板。

## 项目结构

```
disaster-command/
├── .env.example          # 环境变量样板（git 提交）
├── .gitignore            # 忽略 node_modules / .env / dist 等
├── vite.config.js
├── index.html
└── src/
    ├── main.js           # 入口
    ├── App.vue           # 三栏布局（事件 / 地图 / 调度+详情）
    ├── style.css
    ├── config/
    │   └── amap.js       # 高德 Loader 封装 + 读 .env key
    ├── mock/
    │   └── data.js       # 灾情场景 / 事件 / 资源库 mock 数据
    ├── store/
    │   └── command.js    # Pinia 全局状态、派发与流转逻辑
    └── components/
        ├── CommandHeader.vue   # 顶栏 + 场景切换 + 大屏统计
        ├── EventList.vue       # 左侧事件列表 + 筛选
        ├── MapBoard.vue        # 高德地图渲染层（Polygon/Heatmap/Marker/路线）
        ├── DispatchPanel.vue   # 资源调度面板 + 资源库库存 + 在途派发
        └── EventDetail.vue     # 事件详情 + 状态流转 + 时间线
```

## 后续可扩展方向

- 实时预警推送（WebSocket / SSE 模拟）
- 多级权限与账号体系（RBAC）
- 资源库存与供应联动、自动补货
- 历史事件复盘与回放
- 实时数据接口接入（替换 mock）
- 天气 / 地质灾害图层叠加
- 移动端指挥适配

## ⚠️ 安全提示

高德 key 直接写在前端 `.env` 中构建进产物，是**公开可见**的，且有每日调用配额。
- 仅适合本地开发 / 个人演示。
- 部署到生产或公开服务前，请替换为**限定域名**的正式 key，或通过**服务端代理**调用 Web 服务 API。
- 切勿将 `.env` 提交到公开仓库。