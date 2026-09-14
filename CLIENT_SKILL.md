# CLIENT_SKILL.md · wechat-relay 客户端使用手册

面向调用方（人工或 Agent）的 relay 接口完整用法。服务端语义以 [docs/PROTOCOL.md](docs/PROTOCOL.md) 为准；本文件是可操作的客户端视角文档。个人 Claude 技能（`~/.claude/skills/wechat-relay/SKILL.md`）与本文件保持同步。

## 配置

```bash
WECHAT_RELAY_URL    # 如 https://relay.example.com（必须 HTTPS；loopback 除外）
WECHAT_RELAY_TOKEN  # ≥32 随机字节（Base64 ≥43 字符或 Hex ≥64 字符）
```

未配置时提示用户设置，不要猜测或硬编码。Token 绝不写入文件、日志或对话正文。

## 认证

- 除 `/v1/health` 外所有接口带 `Authorization: Bearer $WECHAT_RELAY_TOKEN`
- **只发一种**认证头；同时发 Bearer 和 X-Relay-Token 会被拒绝

## 一、草稿链路（4 条写/读接口）

| 接口 | 用途 | 要点 |
|---|---|---|
| `POST /v1/ready` | 推送前必做 | 返回 `{"ready":true}` 才继续 |
| `POST /wechat/material/add_material?type=image` | 上传封面永久素材 | multipart；返回 `media_id` |
| `POST /wechat/media/uploadimg` | 上传正文图片 | multipart，≤1MB；返回 `mmbiz.qpic.cn` URL（`http://` 强制改 `https://`） |
| `POST /wechat/draft/add` | 创建草稿 | **必须**带 `Idempotency-Key`（随机 UUID；不放标题/正文等敏感值） |
| `POST /wechat/draft/get` | 回读核验 | body `{"media_id":"..."}` |

草稿链路的 HTML 自检、幂等冲突处理等细节见 PROTOCOL.md「Idempotency」一节与 SKILL.md。

## 二、数据复盘链路（6 条只读统计接口）

全部为 `POST + application/json`，body **恰为**两个日期字段：

```json
{"begin_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD"}
```

### 日期规则（relay 转发前 fail-closed 拦截，不会消耗上游配额）

1. 两个字段必须是真实日历日期（`2026-02-30` 拒绝）
2. `begin_date ≤ end_date`；除 `getbizsummary` 外全部要求 `begin_date == end_date`（单日）；`getbizsummary` 跨度 ≤ 30 天
3. `end_date` 必须早于**北京时间今天**（微信当日无数据）
4. 违规错误码：`invalid_json_shape` / `invalid_date_format` / `date_span_not_supported` / `date_not_finalized`（均 400）

### 接口语义

| 接口 | 单日语义 | 数据起点 | 返回要点 |
|---|---|---|---|
| `getarticletotaldetail` | **发表日** | 2025-11-01 | **复盘首选**：每篇文章标题、`content_url` 永久链接、阅读/分享/在看/点赞/留言数/收藏/赞赏/阅读后关注/完读率/平均时长/跳出位置；`detail_list` 按日给出发表后 30 天内的逐日增量 |
| `getbizsummary` | 汇总日（可 30 天连查） | 2025-11-01 | 账号级日概览：阅读/分享/点赞/留言/收藏人数、发布篇数 |
| `getarticleread` | 统计日 | 2025-11-01 | 每篇当日阅读人数 + 8 渠道细分（`read_user_source`）；**无 title**，靠 `msgid` 关联 |
| `getarticleshare` | 统计日 | 2025-11-01 | 每篇当日分享人数；**无 title** |
| `getarticlesummary` | 统计日 | 2014-12-01 | 旧接口（官方已停止维护，仍可用）：每篇当日阅读/原文页/分享/收藏汇总；互动总量 <3 的文章不返回 |
| `getarticletotal` | 群发日 | 2014-12-01 | 旧接口：每篇发表后 7 天内逐日**累计**数据（与 detail 的逐日增量语义不同） |

### 推荐查询模式

```bash
# 复盘某天的发表（核心）：D=发表日
curl -s -X POST "$WECHAT_RELAY_URL/wechat/datacube/getarticletotaldetail" \
  -H "Authorization: Bearer $WECHAT_RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"begin_date":"2026-09-01","end_date":"2026-09-01"}'

# 账号近 30 天概览
curl -s -X POST "$WECHAT_RELAY_URL/wechat/datacube/getbizsummary" \
  -H "Authorization: Bearer $WECHAT_RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"begin_date":"2026-08-15","end_date":"2026-09-13"}'
```

注意事项：

- **8 点前查昨日可能返回上游 `errcode 61503`（数据未就绪）**——等几小时重查，不是 relay 故障
- 想看某天**所有历史文章**的表现：该日期不是它们的发表日，`getarticletotaldetail` 查不到；用旧接口按统计日查，或逐个发表日轮询 detail
- `msgid` 格式为 `msg_data_id_index`：前半段可直接作留言接口的 `msg_data_id`（多图文第 N 篇从 1 计）
- 渠道细分 `scene_desc`：全部/公众号消息/聊天会话/朋友圈/公众号主页/其他/推荐/搜一搜
- 常见上游错误码：`61500` 日期格式、`61501` 日期范围、`61503` 数据未就绪、`45009` 超调用额度、`40001/40014/42001` token 失效（relay 已自动换 token 重试一次）

## 安全红线

- Token、AppSecret、media_id 不进仓库、不进日志、不打进对话正文
- relay URL 必须 HTTPS（`localhost/127.0.0.1/::1` 除外）
- 只有 `draft/add` 接受 `Idempotency-Key`，其余 9 条微信接口发了即 400
- relay 没有群发、发布接口；发布永远在公众号后台人工完成
- 统计接口只读：relay 不落库、不缓存，重复调用消耗的是微信 datacube 配额
