# chrome-bridge

把本机 HTTP(S) 流量交给 Chrome 代发：本地起一个代理端口，除本地回环地址外，所有请求都通过 WebSocket 转给 Chrome 扩展，由扩展用 `fetch` 发出。出网能力、Cookie、UA、代理链全部沿用 Chrome 自己的。

适合的场景：本机没有直连出网能力、但 Chrome 有；需要复用浏览器已登录的会话；需要绕过只对浏览器放行的网络策略。

## 组成

| 文件 | 角色 |
| --- | --- |
| `mitmproxy.ts` | bridge 本体。Bun 进程，mockttp 代理（HTTP / HTTPS CONNECT / SOCKS5 共用一个端口）+ WebSocket 服务端 |
| `background.js` | Chrome 扩展 service worker。连 bridge，用 Chrome 的 `fetch` 代发请求，把响应流回 bridge |
| `manifest.json` | MV3 清单，权限 `alarms` + `cookies`，host 权限 `<all_urls>` |
| `123.sh` | 把 bridge CA 追加进系统证书链，并导出 `*_CA_BUNDLE` 系列环境变量 |

```mermaid
flowchart LR
    C["客户端<br/>curl / pip / git / …"] -->|"HTTP · HTTPS CONNECT · SOCKS5<br/>:1080"| P["mockttp<br/>(mitmproxy.ts)"]
    P -->|"WebSocket :8765<br/>协议 v5"| E["background.js<br/>(service worker)"]
    E -->|"fetch"| U["上游站点"]
    P -.->|"WebSocket / 本地回环 / --passthrough<br/>直接转发"| U
```

流量分流：

- **WebSocket** → 直通。`fetch` 转发不了 WS。
- **本地回环地址** → 直通。dev server 不该绕道 Chrome。判定用 mockttp 的 `isLocalhostAddress`，覆盖 `localhost` / `*.localhost` / `127.0.0.0/8` / `::1`。
- **其余 HTTP(S)** → 交给 Chrome。
- **`--passthrough` 命中的域名** → TLS 层裸转发，客户端看到真实证书，不需要信任 bridge 的 CA。这是证书 pinning 应用和 Apple 系统服务的唯一可行路径，代价是这些域名不经过 Chrome，要求本机对其有直连出网能力。

## 运行

```bash
ulimit -n 10240 && bun mitmproxy.ts \
    --port 1080 \
    --ws 127.0.0.1:8765 \
    --ca-dir ~/.chrome-bridge-ca \
    --passthrough "*.apple.com,*.icloud.com"
```

- 文件描述符上限由外部 shell 的 `ulimit` 负责，程序内不调整 `RLIMIT_NOFILE`：macOS 默认 soft limit 只有 256，超过 `kern.maxfilesperproc` 会失败。
- 首次启动在 `--ca-dir` 下生成 2048-bit「Chrome Bridge CA」（`ca.key` + `ca.pem`）。任一文件缺失才重新生成，已存在则直接复用，**不校验有效期或内容**。生成后需要加入系统信任（`123.sh`）。
- 扩展侧：`chrome://extensions` 加载本目录，确认 service worker 日志出现 `[bridge] connected`。
- 客户端把代理指向 `127.0.0.1:1080`。

## 协议 v5

帧格式：`[单行 JSON 头]\n[正文]`。WebSocket 消息本身即边界，没有长度前缀；`JSON.stringify` 不产生裸换行，所以第一个 `\n` 就是头与正文的分界。

| 方向 | 帧类型 | 载荷 |
| --- | --- | --- |
| bridge → 扩展 | `req` | `id` / `method` / `url` / `headers` + 正文 |
| bridge → 扩展 | `cancel` | `id` |
| 扩展 → bridge | `data` | `id` + 正文 |
| 扩展 → bridge | `end` | 二选一：`id` / `status` / `headers`，或 `id` / `msg`（扩展侧失败） |

没有 `head` 帧：bridge 必须攒齐整个 body 才能 resolve，status / headers 提前到达也用不上，统一由 `end` 帧携带，省掉一套「头到了没到」的状态与分支。

心跳是文本帧 `"ping"`，不占帧类型，也不占用二进制帧的编解码路径。协议只用二进制帧，其余文本帧一律忽略。两端互为可信对端（同一台机器、同一条回环 WebSocket），帧只做 JSON 解析，字段形状由协议保证；唯一保留的信任边界是升级时的 `Origin` 检查——它挡的是任意网页，不是本机进程。

## ① 连接期

```mermaid
sequenceDiagram
    autonumber
    participant E as background.js (service worker)
    participant W as Bun WS :8765
    participant S as mockttp :1080

    Note over S: 启动：ensureCA 读 ~/.chrome-bridge-ca 下的 ca.key + ca.pem<br/>任一缺失才生成 2048-bit「Chrome Bridge CA」<br/>已存在则直接复用，不校验有效期或内容<br/>三类流量分流：<br/>WebSocket → 直通（fetch 转发不了 WS）<br/>本地回环地址 → 直通（dev server 不该绕道 Chrome）<br/>其余 HTTP(S) → viaChrome<br/>on abort → 499；on tls-client-error → 仅日志<br/>http2 关闭 / 不记录流量

    E->>W: new WebSocket("ws://127.0.0.1:8765")
    W->>W: Origin 必须以 chrome-extension:// 开头<br/>否则 403（网页无法伪造该 Origin）
    alt upgrade 失败
        W-->>E: 426 websocket only
    else upgrade 成功
        W->>W: data.origin 存入 ws.data
        W->>W: 若 current 存在：failAll(502) 先让旧连接名下的请求失败<br/>（cancel 帧必须发到旧连接上），再 old.close(1000, "replaced")<br/>然后 current = ws
        W-->>E: open
    end

    loop 每 20s
        E->>W: 文本帧 "ping"（仅为保活 SW，bridge 不回应）
    end
    Note over W: idleTimeout 120s（4 个心跳周期）<br/>maxPayloadLength = 2GB（超限 Bun 直接 1009 断链）<br/>perMessageDeflate false<br/>文本帧一律忽略，协议只用二进制帧

    Note over E: 保活兜底：chrome.alarms 每 0.5min → connect<br/>chrome.runtime.onStartup → connect<br/>onopen：backoff 重置为 500ms

    E--xW: 连接断开
    W->>W: ws !== current 的迟到 close 直接 return<br/>否则 current = null → failAll → pending 全部 502
    E->>E: ws !== sock 的迟到 onclose 直接 return（已被新连接替换）<br/>否则 ws = null → abort 全部 inflight → clear<br/>setTimeout(connect, backoff)，backoff = min(×2, 5000ms)
```

只允许扩展连接：普通网页无法伪造 `chrome-extension://` 的 Origin。同一时刻只保留一条连接，新连接会顶掉旧的，旧连接名下的在途请求立即失败而不是等超时。

## ② 请求主路径

```mermaid
sequenceDiagram
    autonumber
    participant C as 客户端 (curl)
    participant P as mockttp :1080
    participant V as viaChrome
    participant E as background.js
    participant U as 上游站点

    C->>P: CONNECT + TLS（信任 bridge CA）
    P->>V: CompletedRequest（已解密，req.id 由 mockttp 分配，body 已是完整 Buffer）
    Note over P,V: 请求体在进入 viaChrome 前已全量读入内存<br/>所以 500MB 的告警是在吃完内存之后才发出的

    V->>V: 回环检测：含 x-bridge-hop → 508
    V->>V: current 未 OPEN → 502「Chrome 扩展未连接」<br/>请求体超过 500MB → 仅告警，照常转发
    V->>V: forwardable(rawHeaders)：按 Connection 列出的字段逐个删，<br/>再删逐跳头（connection / keep-alive / transfer-encoding /<br/>te / trailer / upgrade）、proxy-* / x-bridge-* 前缀、HTTP/2 伪头
    V->>V: new Pending（chunks 空，size 0，seen 为当前时间）<br/>pending.set(req.id, p)
    Note over P,V: 每个请求一个独立 Pending，按 req.id 索引<br/>扩展侧 handle 不 await，多请求在 Chrome 里并发 fetch
    V->>E: req 帧（t "req"，id、method、url、headers）+ body
    Note over V: send 返回 false（socket 非 OPEN 或抛错）→ 502「发送到扩展失败」

    E->>E: onmessage → 切头/正文 → 按 head.t 分派 handle() 或 abort()
    E->>E: inflight.set(id, AbortController)<br/>hasBody = body 非空 且 method 不是 GET / HEAD
    E->>E: new Headers(req.headers)，强制 set x-bridge-hop 1<br/>禁止头（Cookie / Host / Origin / Sec-*）由 fetch 忽略<br/>UA 用 Chrome 自己的
    Note over E: 客户端传来的 Cookie 头被 fetch 当禁止头丢弃<br/>真正的 cookie 全部来自 credentials include + Chrome 的 cookie jar
    E->>U: fetch(url, method, headers, body, credentials include, cache no-store, signal)
    Note over E,U: redirect 未设置 → 默认 follow，重定向在 Chrome 内部完成<br/>GET / HEAD 命中 resp.redirected 时，把终点 URL 还原成一次 302 交还客户端<br/>其余方法 Chrome 已重发过 body，只能直接给终点响应<br/>中间跳的 Set-Cookie 仍然丢失
    U-->>E: 终点 status + 流式 body（resp.url 为最终 URL）

    loop 每个 reader.read() 返回的 chunk（大小由流决定，非固定分块）
        E->>E: drain()：bufferedAmount 超过 8MB 时每 10ms 轮询等待<br/>连接已断则抛错，不再白读剩余 body
        E->>P: data 帧（t "data"，id）+ chunk
        P->>P: p.size += len；超过 500MB → 仅告警一次（不中断）<br/>chunks.push(body)；p.seen = now
    end
    Note over E: HEAD / 204 / 205 / 304 的 resp.body 按规范为 null，不发 data 帧

    E->>P: end 帧（t "end"，id、status、headers + cookieHeaders，无 msg 表示成功）
    Note over E: cookieHeaders：chrome.cookies.getAll(resp.url) 转成 set-cookie<br/>查的是终点 URL 的 jar，让 curl -c 能存下会话<br/>非 http(s) 查询失败则返回空
    P->>P: complete()：status / headers 直接采信（扩展是可信对端）
    Note over P: 头同样走 forwardable 过滤<br/>最终用 rawHeadersToObject 转回 mockttp 的 headers 对象<br/>同名头合并成数组，多个 set-cookie 因此能全部保留
    P->>P: declared = 原 content-length（改头前取）<br/>剥逐跳头 + 删 content-encoding<br/>content-length：204 / 205 / 304 删除；HEAD 用 declared 或 "0"；其余用实际 size
    Note over P: 上游 content-length 是压缩后大小，Chrome fetch 给的是解压后 body<br/>两者必然不符，所以不能透传，只能按 p.size 重算
    P->>P: finish()：pending.delete → resolve<br/>单 chunk 直接复用，多 chunk 才 concat
    Note over P,C: 整个响应在 bridge 内存里攒齐后才一次性写给客户端<br/>客户端在 end 帧到达前收不到任何字节，没有增量下发<br/>这是设计取舍，不是能力限制（mockttp 本身支持流式下发）
    P-->>C: status + body（显式 content-length，避免关 socket 时不发 TLS close_notify 导致 Rust 客户端报错）
```

## ③ 错误与取消

所有终态都走 `finish()`：`pending.get(id) !== p` 时直接 return，天然幂等。超时由单个 1s 扫描器统一判定（`p.seen` 超过 60s），没有 per-request 定时器——每收一帧重置 timer 会让大响应产生上千次定时器创建/销毁。

```mermaid
sequenceDiagram
    autonumber
    participant C as 客户端
    participant P as bridge
    participant E as 扩展

    Note over P: 所有终态都走 finish()：pending.get(id) !== p 时直接 return，天然幂等<br/>超时由单个 1s 扫描器统一判定（p.seen 超过 60s），无 per-request 定时器

    alt 60s 未收到任何帧
        P->>E: cancel 帧
        P-->>C: 504「扩展响应超时（60s）」
    else 客户端先断开（mockttp abort 事件）
        P->>E: cancel 帧
        P-->>C: 499「客户端已断开」（连接已断，实际只留日志）
    else 扩展 fetch 抛错（resp 未拿到）
        E->>P: end 帧 + msg「fetch 失败：…」
        P-->>C: 502「扩展 fetch 失败：msg」
    else 扩展读到一半断流（resp 已拿到）
        E->>P: end 帧 + msg「上游已回 N，已发 X 字节后失败」
        P-->>C: 502「上游已回 N，已收 X 字节后失败（msg）」
    else 扩展收到 cancel 帧
        P->>E: cancel 帧
        E->>E: ac.abort()；catch 里 signal.aborted 为真则不再回报 end
    else 扩展连接断开 / 被新连接替换
        P->>P: failAll：pending 全部 502
        P->>E: cancel 帧
    else 扩展侧 drain() 发现 socket 已断
        E->>E: 抛错 → handle 的 catch → send end + msg<br/>但 socket 已断，send 返回 false<br/>实际由 bridge 的 failAll 兜底
    else SIGINT / SIGTERM
        P->>P: 全部 pending 503「bridge 正在关闭」<br/>server.stop() → wsServer.stop(true) → exit(0)
    end
```

「上游已响应但正文断了」和「根本没连上」的区别只能由扩展拼进 `msg`：只有它知道上游状态码和已发字节数。

## ④ Pending 状态机

```mermaid
stateDiagram-v2
    direction LR
    [*] --> Streaming: viaChrome 建 Pending 并 set(req.id)
    Streaming --> Streaming: data 帧（size 累加，超 500MB 只告警）
    Streaming --> Done: end 帧无 msg（携带 status 与 headers）
    Streaming --> Failed: end 帧带 msg（扩展侧失败，文案由扩展拼好）
    Streaming --> Failed: 超时 / cancel / 断线

    Done --> [*]: complete() → forwardable 过滤 + 重算 content-length → rawHeadersToObject → resolve
    Failed --> [*]: textReply(code) → resolve

    note right of Streaming
        p.seen 每收一帧刷新
        1s 扫描器统一判 60s 超时
        没有 head 帧，所以只有一个在途状态
    end note
```

## 关键取舍与已知限制

**响应整块缓冲。** bridge 必须攒齐整个 body 才能 resolve，客户端在 `end` 帧到达前收不到任何字节。这是为了让「没有 head 帧」这套简化协议成立，不是能力限制——mockttp 本身支持流式下发。超过 500MB（请求体、响应体各自）只打一条 `[size]` 告警，不中断：拒绝会让大文件传输直接失败，而内存占用在整块缓冲这个设计下本来就无法靠上限挡住。

**大小告警发生在吃完内存之后。** 请求体在进入 `viaChrome` 前已被 mockttp 全量读入内存，所以 500MB 的告警只能提示、不能挡住内存占用。`maxBodySize` 故意不设：它超限时清空 body 而不报错，大请求会被静默变成空 body。

**`content-length` 必须重算。** 上游声明的是压缩后大小，Chrome `fetch` 给的是解压后 body，两者必然不符。桥接后 `content-encoding` 也被删掉。同时必须显式写回 `content-length`：callback 返回 headers 时 mockttp 会调 `dropDefaultHeaders()`，把 Node 默认的 `content-length` / `transfer-encoding` 一起删掉；此时若不再写回，body 只能靠关闭连接界定，而 mockttp 关闭 socket 时不发 TLS `close_notify`，rustls / hyper 会直接报 `peer closed connection without sending TLS close_notify`（pixi、uv、pip 全部中招）。`curl` 按 RFC 7230 §3.3.3 用 EOF 兜底，所以只有 Rust 客户端会失败。

**Cookie 只能单向。** 客户端传来的 `Cookie` 头被 `fetch` 当禁止头丢弃，真正的 cookie 全部来自 `credentials: include` + Chrome 的 cookie jar。反方向上，扩展用 `chrome.cookies.getAll(resp.url)` 把终点 URL 的 cookie 转成 `set-cookie` 回传，`curl -c` 才能存下会话。

**重定向只对 GET / HEAD 可见。** `redirect` 未设置，默认 follow，重定向在 Chrome 内部完成；扩展看到 `resp.redirected` 就把终点 URL 还原成一次 302 交还客户端，客户端自己跟完剩下的跳。其余方法（POST 等）Chrome 已经重发过 body，原始状态码是 301/302/303 还是 307/308 无从得知，编一个会让客户端选错方法，只能直接给终点响应。任何情况下中间跳的 `Set-Cookie` 都拿不到。`redirect: "manual"` 是死路：service worker 里只给 opaqueredirect（status 0、无 header）。

**回环检测是固定头名。** 扩展强制 `x-bridge-hop: 1`，bridge 见到该头即判 508（Chrome 的代理指向了 bridge 本身）。客户端自己带这个头会被误判，换随机名可解，但保持固定名更简单。

**`--passthrough` 要求直连出网。** 透传由 Bun 进程直接连上游，不走 Chrome。若本机只靠 Chrome 出网，透传会 `ECONNREFUSED`，反而不如不解密。

**TLS 失败原因在 Bun 下基本不可信。** mockttp 的 `getCauseFromError` 靠正则匹配 Node 的错误文案（`alert unknown ca` / `ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE`），Bun 给的是 OpenSSL 常量名（`TLSV1_ALERT_UNKNOWN_CA`），一条都对不上，于是「客户端不信任 CA」全被归成 `unknown`；TLS 1.3 的 alert 还是加密的，Bun 只能看到 `BAD_PACKET_LENGTH`。排查时：`reset` / `closed` 是客户端一个 alert 都没发就掐断连接，装 CA 永远解决不了，得往 pinning 或非 HTTP 协议上查。
