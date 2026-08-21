# Docker Compose 部署(配合宿主机 nginx-proxy-manager)

本路线假设:服务器上已运行 nginx-proxy-manager(NPM)并由它负责域名、证书与 TLS 终止;
relay 容器只监听宿主机 `127.0.0.1:18794`,由 NPM 反代对外。compose 文件中没有也不需要 Caddy。

完整的手动 systemd + Ubuntu 24.04 部署(含 Tailscale Serve / Caddy 两条边缘路线)见
[DEPLOY_UBUNTU_24_04.md](DEPLOY_UBUNTU_24_04.md)。

## 0. 网络模型(重要)

relay 有两层 loopback 强制:

1. `HOST` 只允许 `127.0.0.1` / `::1`(`src/config.js`);
2. handler 拒绝非 loopback 对端连接(`src/server.js`,403 `non_loopback_peer`)。

因此 **relay 容器必须使用 `network_mode: host`**(docker-compose.yaml 已如此配置)。
docker bridge NAT 下所有请求都会被 403 拒绝。

同理,**NPM 也必须以 host 网络运行**(或原生安装在宿主机上)。如果 NPM 跑在
bridge 网络 + 端口映射模式下,它无法访问宿主机的 `127.0.0.1`;若改用宿主桥 IP
(如 `172.17.0.1`)作为上游,会被 relay 的 loopback 对端校验拒绝。

## 1. 准备

- Docker Engine + Compose v2(`docker compose version` 可用)
- 宿主机上已有 host 网络的 nginx-proxy-manager,80/443 已放行,18794 不对外
- 已加入微信公众号后台 IP 白名单的固定出口 IPv4

## 2. 配置环境

```bash
cp .env.example .env
# 生成 RELAY_TOKEN(至少 32 字节熵,44+ 字符):
openssl rand -base64 48
```

编辑 `.env`,填入三项必填值:

```dotenv
WECHAT_APP_ID=<公众号 AppID>
WECHAT_APP_SECRET=<公众号 AppSecret>
RELAY_TOKEN=<openssl 生成的随机值>
```

其余键留空即用内置默认值。`.env` 已被 gitignore,不要提交、不要粘贴到工单或聊天里。
compose 中 `HOST`/`PORT`/`DB_PATH`/`NODE_OPTIONS` 由 `environment:` 固定,
即使 `.env` 里这几项为空也不会生效错误值。

### 境内服务器加速(可选)

境内访问 `deb.debian.org` / `registry.npmjs.org` / Docker Hub 可能极慢。构建期源可在
`.env` 中覆盖(compose 会作为 build args 传入):

```dotenv
# Debian apt 源(清华 TUNA;也可用 mirrors.aliyun.com 等)
APT_MIRROR=mirrors.tuna.tsinghua.edu.cn
# npm 源(npmmirror)
NPM_REGISTRY=https://registry.npmmirror.com
```

基础镜像(`node:22-slim`)拉取慢则配置 Docker daemon 的 registry mirror:
编辑 `/etc/docker/daemon.json` 后 `systemctl restart docker`:

```json
{
  "registry-mirrors": ["https://docker.m.daocloud.io"]
}
```

(镜像加速地址时效性强,失效时自行更换可用的 mirror。)

## 3. 启动

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=50
```

容器内以非 root `node` 用户运行(entrypoint 用 gosu 降权),SQLite 数据落在
bind mount 的 `./data/`。健康检查走公开的 `/v1/health`。

## 4. 本地验证

```bash
curl --fail --silent --show-error http://127.0.0.1:18794/v1/health
# 认证就绪检查(令牌走 stdin,不进 shell 历史):
curl --fail --silent --show-error --config - <<EOF
url = "http://127.0.0.1:18794/v1/ready"
header = "Authorization: Bearer ${RELAY_TOKEN}"
EOF
```

`/v1/ready` 会校验 SQLite 与微信凭据/IP 白名单就绪状态,失败时看结构化日志,
不要放宽日志去打印头部、请求体或密钥。

## 5. 配置 nginx-proxy-manager

在 NPM 中新建 Proxy Host:

- Domain Names: 你的 relay 域名(证书由 NPM 申请/续期)
- Scheme: `http`,Forward Hostname: `127.0.0.1`,Forward Port: `18794`
- 关闭 Caching;WebSocket 支持不需要打开
- 如启用了访问列表可按需叠加,但不要移除 relay 自身的 Bearer 认证

注意两点:

1. **NPM 的 nginx `client_max_body_size` 必须 ≥ relay 的媒体路由体积上限**
   (默认 `MAX_MEDIA_BODY_BYTES=20MiB`,最大可调 32MiB)。超限时 NPM 会在到达
   relay 之前直接返回 413。
2. relay 忽略 `X-Forwarded-*` 头,认证与限流都以 Bearer token 为准,
   在 NPM 之后仍然有效。

防火墙:只暴露 SSH(按你的策略)与 NPM 的 80/443;18794 仅 loopback 可达
(`ss -ltnp` 确认)。

## 6. 更新与回滚

```bash
git fetch --all --prune
git checkout <已审查的版本>
docker compose up -d --build
```

回滚:checkout 回旧版本重新 `up -d --build`。SQLite 状态在 `./data/`,
升级前备份它即可;不要把数据库拷进 Git,也不要为了重试而删除/改写幂等记录,
除非已人工对账过对应的微信草稿状态。

## 7. 卸载

```bash
docker compose down
```

`./data/` 不会被删除,确认不再需要后手动清除。
