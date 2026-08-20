# Telegram Web（自托管 Web 版 Telegram）

基于 Telegram 官方开源 Web 客户端 [Telegram Web K (tweb)](https://github.com/morethanwords/tweb) 定制。

浏览器直连 Telegram 官方服务器（MTProto 协议），无需任何后端服务；登录、聊天、语音视频通话等全部在浏览器内完成。

**本仓库与 Telegram Desktop (tdesktop) 的功能对齐，唯一差异：去掉了通讯录（地址簿）功能**，其余功能与原版一致：

- 💬 私聊、群组、超级群组、频道、Saved Messages、收藏夹
- 🗂 聊天文件夹、归档、固定、置顶、静音、未读统计
- ✏️ 消息编辑/删除/转发/引用/回复/定时发送、草稿、搜索（全局+聊天内）
- 😀 贴纸、自定义表情、GIF、图片/视频/文件/语音消息/视频圆消息
- 🗳 投票、测验、表情回复（含 Premium 自定义）、话题（Forum）、故事
- 📞 语音通话、视频通话、群组语音聊天（WebRTC）
- 🎨 主题、聊天背景、夜间模式、外观自定义、动态效果开关
- 🔒 两步验证、登录设备管理、隐私设置、Passkey
- 🤖 Bot 支持、Web App 支持、星币/星礼、Premium 特性
- 👥 群组成员管理、管理员、权限、邀请链接、频道广告收入统计等
- ⬇️ **受限频道媒体下载到 NAS**：禁止下载/禁止保存的频道里的图片、视频、GIF、语音消息、故事，均可一键下载，文件直接保存到 NAS 挂载目录（基于 [Telegram Media Downloader](https://github.com/Neet-Nestor/Telegram-Media-Downloader) GPLv3，保存逻辑改为 NAS 后端）

> 说明：与所有官方 Web 客户端相同，「私密对话（Secret Chat）」不支持——这是 Telegram 官方 Web 版的平台限制。

## 一键部署（绿联 NAS / 任意 Docker 主机）

镜像由 GitHub Actions 自动构建并推送到 GHCR：

```
ghcr.io/mogvl/telegram-web:latest      # Web 前端
ghcr.io/mogvl/telegram-web-dl:latest   # NAS 下载接收服务
```

### 方式一：绿联 NAS Docker 应用（推荐）

1. 打开绿联 NAS 的 **Docker** 应用 → **Compose / 项目**
2. 新建项目，粘贴下面的 `docker-compose.yaml` 内容（或直接上传该文件）
3. 项目名随意（如 `telegram-web`），点击**部署**即可
4. 浏览器打开 `http://<NAS-IP>:8080`

`docker-compose.yaml` 完整内容：

```yaml
services:
  telegram-web:
    image: ghcr.io/mogvl/telegram-web:latest
    container_name: telegram-web
    ports: ["8080:80"]
    environment:
      - TZ=Asia/Shanghai
    restart: unless-stopped
    depends_on:
      - telegram-web-dl

  # 接收网页里的媒体下载并写入 NAS 卷
  # 受限频道下载的图片/视频/语音/故事会保存到 <项目目录>/downloads/
  # 如需指定 NAS 绝对路径，把下面 - ./downloads 改成例如：
  #   - /volume1/docker/telegram-web:/data/downloads
  telegram-web-dl:
    image: ghcr.io/mogvl/telegram-web-dl:latest
    container_name: telegram-web-dl
    environment:
      - TZ=Asia/Shanghai
      - DOWNLOAD_DIR=/data/downloads
    volumes:
      - ./downloads:/data/downloads
    restart: unless-stopped
```

### 方式二：SSH 命令行

```bash
# 把 docker-compose.yaml 放到 NAS 上任意目录，然后：
docker compose up -d
# 或者手动拉取运行：
docker run -d --name telegram-web --restart unless-stopped -p 8080:80 ghcr.io/mogvl/telegram-web:latest
```

### 方式三：本地构建镜像

```bash
docker compose up -d --build
```

### 配置

- 端口：默认 `ports: ["8080:80"]`，如需改端口修改 `docker-compose.yaml` 中 `ports` 数组里的数字（如 `["5000:80"]`）
- 域名 + HTTPS：在绿联 NAS 反向代理或路由器上把域名转发到该端口即可（客户端对 HTTP/HTTPS 无要求）

### 构建自定义（可选）

镜像内支持通过构建参数覆盖页面标题与分享链接（需本地构建时才生效）：

```bash
docker build --build-arg TWEB_TITLE="My Telegram" -t telegram-web .
```

## 登录与使用

打开页面后选择 **手机号登录 / 扫码登录** 即可，与 web.telegram.org 完全一致。如网络环境无法直连 Telegram 服务器，可在「设置 → 连接」中配置 MTProto 代理服务器。

## 开发

```bash
pnpm install
pnpm start          # 开发服务器 :8080（热更新）
pnpm build          # 生产构建 → dist/
pnpm test           # 单元测试 (Vitest)
pnpm lint           # oxlint
pnpm typecheck      # tsc --noEmit
```

## CI / CD

`.github/workflows/ci.yml`：

- 每次 push / PR：安装依赖 → 类型检查 → lint → 单元测试 → 生产构建
- 推送 master：额外构建 Docker 镜像并推送至 GHCR（`latest` + commit SHA 双标签）

## 免责声明

本项目是 [tweb](https://github.com/morethanwords/tweb)（Telegram 官方 Web K 客户端）的定制衍生版本，基于 **GPL-3.0** 许可证发布（见 [LICENSE](LICENSE)）。"Telegram" 名称与品牌归 Telegram FZ-LLC 所有。

- 上游源码：https://github.com/morethanwords/tweb
- 官方在线版：https://web.telegram.org/k/