# chrome-bridge

把本机 HTTP(S) 流量交给 Chrome 代发：本地起一个代理端口，除本地回环地址外，所有请求都通过 WebSocket 转给 Chrome 扩展，由扩展用 `fetch` 发出。出网能力、UA、代理链沿用 Chrome；Cookie 默认来自 Chrome，`https://mirrors.ustc.edu.cn` 还会先把客户端 Cookie 写入 Chrome。

适合的场景：本机没有直连出网能力、但 Chrome 有；需要复用浏览器已登录的会话；需要绕过只对浏览器放行的网络策略。

## 组成

| 文件                        | 角色                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `mitmproxy.ts`            | bridge 本体。Bun 进程，mockttp 代理（HTTP / HTTPS CONNECT / SOCKS5 共用一个端口）+ WebSocket 服务端 |
| `extension/background.js` | Chrome 扩展 service worker。连 bridge，用 Chrome 的 `fetch` 代发请求，把响应流回 bridge           |
| `extension/manifest.json` | MV3 清单，权限 `cookies`，host 权限 `<all_urls>`                                                |
| `assets/cacert.sh`           | 把 bridge CA 追加进系统证书链，并导出 `*_CA_BUNDLE` 系列环境变量                                  |

```mermaid
flowchart LR
    C["客户端<br/>curl / pip / git / …"] -->|"HTTP · HTTPS CONNECT · SOCKS5<br/>:1080"| P["mockttp<br/>(mitmproxy.ts)"]
    P -->|"WebSocket :8765<br/>协议 v5"| E["background.js<br/>(service worker)"]
    E -->|"fetch（默认使用 Chrome Cookie）"| U["上游站点"]
    E -.->|"仅 USTC：客户端 Cookie 写入 jar"| J["Chrome Cookie Store"]
    J -.-> E
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
- 首次启动在 `--ca-dir` 下生成 2048-bit「Chrome Bridge CA」（`ca.key` + `ca.pem`）。任一文件缺失才重新生成，已存在则直接复用，**不校验有效期或内容**。生成后需要加入系统信任（`assets/cacert.sh`）。
- 扩展侧：`chrome://extensions` 加载 `extension/` 目录，确认 service worker 日志出现 `[bridge] connected`。service worker 每次启动都会在顶层执行 `connect()`。
- 客户端把代理指向 `127.0.0.1:1080`。

## 协议 v5

帧格式：`[单行 JSON 头]\n[正文]`。WebSocket 消息本身即边界，没有长度前缀；`JSON.stringify` 不产生裸换行，所以第一个 `\n` 就是头与正文的分界。

| 方向           | 帧类型     | 载荷                                                                         |
| -------------- | ---------- | ---------------------------------------------------------------------------- |
| bridge → 扩展 | `req`    | `id` / `method` / `url` / `headers` + 正文                           |
| bridge → 扩展 | `cancel` | `id`                                                                       |
| 扩展 → bridge | `data`   | `id` + 正文                                                                |
| 扩展 → bridge | `end`    | 二选一：`id` / `status` / `headers`，或 `id` / `msg`（扩展侧失败） |

没有 `head` 帧：bridge 必须攒齐整个 body 才能 resolve，status / headers 提前到达也用不上，统一由 `end` 帧携带，省掉一套「头到了没到」的状态与分支。

心跳是文本帧 `"ping"`，不占帧类型，也不占用二进制帧的编解码路径。协议只用二进制帧，其余文本帧一律忽略。两端默认运行在可信 LAN，帧只做 JSON 解析，字段形状由协议保证。

## ① 连接期

```mermaid
sequenceDiagram
    autonumber
    participant E as background.js (service worker)
    participant W as Bun WS :8765
    participant S as mockttp :1080

    Note over S: 启动：ensureCA 读 ~/.chrome-bridge-ca 下的 ca.key + ca.pem<br/>任一缺失才生成 2048-bit「Chrome Bridge CA」<br/>已存在则直接复用，不校验有效期或内容<br/>三类流量分流：<br/>WebSocket → 直通（fetch 转发不了 WS）<br/>本地回环地址 → 直通（dev server 不该绕道 Chrome）<br/>其余 HTTP(S) → viaChrome<br/>on abort → 499<br/>http2 关闭 / 不记录流量

    E->>W: new WebSocket("ws://127.0.0.1:8765")
    alt upgrade 失败
        W-->>E: 426 websocket only
    else upgrade 成功
        W->>W: current = ws
        W-->>E: open
    end
    Note over W: 新连接会直接覆盖 current；代码不主动关闭旧连接<br/>旧连接之后 close 时也会清空 current 并 failAll

    loop 每 20s
        E->>W: 文本帧 "ping"（仅为保活 SW，bridge 不回应）
    end
    Note over W: maxPayloadLength = 2GB（超限 Bun 直接 1009 断链）<br/>文本帧一律忽略，协议只用二进制帧

    Note over E: service worker 每次启动时顶层 connect()

    E--xW: 连接断开
    W->>W: current = null → failAll → pending 全部 502
    E->>E: ws = null → abort 全部 inflight<br/>1s 后重连
```

bridge 与扩展各维持一条连接。WebSocket 不校验来源，默认监听范围内的网络可信。

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
    Note over P,V: 请求体在进入 viaChrome 前已全量读入内存

    V->>V: current 未 OPEN → 502「Chrome 扩展未连接」
    V->>V: forwardable(rawHeaders)：按 Connection 列出的字段逐个删，<br/>再删逐跳头（connection / keep-alive / transfer-encoding /<br/>te / trailer / upgrade）和 proxy-* 头
    V->>V: new Pending（method、chunks 空、resolve）<br/>pending.set(req.id, p)
    Note over P,V: 每个请求一个独立 Pending，按 req.id 索引<br/>扩展侧 handle 不 await，多请求在 Chrome 里并发 fetch
    V->>E: req 帧（t "req"，id、method、url、headers）+ body

    E->>E: onmessage → 切头/正文 → 按 head.t 分派 handle() 或 abort()
    E->>E: inflight.set(id, AbortController)
    E->>E: canRedirect = GET / HEAD<br/>new Headers(req.headers)
    alt URL origin 是 https://mirrors.ustc.edu.cn
        E->>E: 拆分客户端 Cookie 头<br/>逐项 chrome.cookies.set（Path=/，Secure）
    else 其他 origin
        E->>E: 不写入客户端 Cookie
    end
    Note over E: fetch 会忽略 Cookie / Host / Origin / Sec-* 等禁止头；UA 使用 Chrome 自己的<br/>请求 Cookie 来自 Chrome jar；USTC 是唯一会先同步客户端 Cookie 的例外
    E->>U: fetch(url, method, headers,<br/>GET/HEAD 不带 body，其他方法带 body,<br/>credentials include, cache no-store, signal)
    Note over E,U: redirect 未设置 → 默认 follow，重定向在 Chrome 内部完成<br/>GET / HEAD 命中 resp.redirected 时，把终点 URL 还原成一次 302 交还客户端<br/>其余方法 Chrome 已重发过 body，只能直接给终点响应<br/>中间跳的 Set-Cookie 仍然丢失
    U-->>E: 终点 status + 流式 body（resp.url 为最终 URL）

    loop ReadableStream 异步迭代返回的每个 chunk（大小由流决定，非固定分块）
        E->>P: data 帧（t "data"，id）+ chunk
        P->>P: chunks.push(body)
    end
    Note over E: HEAD / 204 / 205 / 304 的 resp.body 按规范为 null，不发 data 帧

    E->>P: end 帧（t "end"，id、status、headers + cookieHeaders，无 msg 表示成功）
    Note over E: cookieHeaders：chrome.cookies.getAll(resp.url) 转成 set-cookie<br/>查的是终点 URL 的 jar，让 curl -c 能存下会话
    P->>P: complete()：status / headers 直接采信（扩展是可信对端）
    Note over P: 头同样走 forwardable 过滤<br/>最终用 rawHeadersToObject 转回 mockttp 的 headers 对象<br/>同名头合并成数组，多个 set-cookie 因此能全部保留
    P->>P: Buffer.concat(chunks)<br/>剥逐跳头 + 删 content-encoding<br/>content-length：204 / 205 / 304 删除；HEAD 沿用上游声明值；其余用 rawBody.length
    Note over P: 上游 content-length 是压缩后大小，Chrome fetch 给的是解压后 body<br/>两者必然不符，所以普通响应按拼接后的 rawBody.length 重算；HEAD 沿用上游声明值
    P->>P: finish()：resolve → pending.delete
    Note over P,C: 整个响应在 bridge 内存里攒齐后才一次性写给客户端<br/>客户端在 end 帧到达前收不到任何字节，没有增量下发<br/>这是设计取舍，不是能力限制（mockttp 本身支持流式下发）
    P-->>C: status + body（显式 content-length，避免关 socket 时不发 TLS close_notify 导致 Rust 客户端报错）
```

## ③ 错误与取消

所有 bridge 侧终态都走 `finish()`：先 resolve，再从 `pending` 删除请求。

```mermaid
sequenceDiagram
    autonumber
    participant C as 客户端
    participant P as bridge
    participant E as 扩展

    alt 客户端先断开（mockttp abort 事件）
        P->>E: cancel 帧
        P-->>C: 499「客户端已断开」（连接已断，实际只留日志）
    else 扩展 fetch 或响应读取抛错
        E->>P: end 帧 + msg = String(error)
        P-->>C: 502「chrome-bridge: {msg}」
    else 扩展收到 cancel 帧
        E->>E: ac.abort()<br/>catch 见 signal.aborted，不再回报 end
    else 扩展连接断开
        P->>P: current = undefined<br/>failAll：pending 全部 502
        Note over P: current 已清空，fail() 尝试发送的 cancel 不会发出
    else SIGINT / SIGTERM
        P->>P: 全部 pending 503「bridge 正在关闭」<br/>server.stop() → wsServer.stop(true)
    end
```

扩展把 `fetch` 或响应流读取抛出的异常直接 `String(error)` 后放入 `msg`；协议不单独携带失败阶段、上游状态码或已发送字节数。

## ④ Pending 状态机

```mermaid
stateDiagram-v2
    direction LR
    [*] --> Streaming: viaChrome 建 Pending 并 set(req.id)
    Streaming --> Streaming: data 帧（size 累加）
    Streaming --> Done: end 帧无 msg（携带 status 与 headers）
    Streaming --> Failed: end 帧带 msg（扩展侧失败，文案由扩展拼好）
    Streaming --> Failed: 客户端 abort / 扩展断线 / 进程退出

    Done --> [*]: complete() → forwardable 过滤 + 重算 content-length → rawHeadersToObject → resolve
    Failed --> [*]: textReply(499 / 502 / 503) → resolve

    note right of Streaming
        没有 head 帧，所以只有一个在途状态
    end note
```

## 关键取舍与已知限制

**响应整块缓冲。** bridge 必须攒齐整个 body 才能 resolve，客户端在 `end` 帧到达前收不到任何字节。这是为了让「没有 head 帧」这套简化协议成立，不是能力限制——mockttp 本身支持流式下发。`maxBodySize` 故意不设：它超限时清空 body 而不报错，大请求会被静默变成空 body。

**`content-length` 必须重算。** 上游声明的是压缩后大小，Chrome `fetch` 给的是解压后 body，两者必然不符。桥接后 `content-encoding` 也被删掉。同时必须显式写回 `content-length`：callback 返回 headers 时 mockttp 会调 `dropDefaultHeaders()`，把 Node 默认的 `content-length` / `transfer-encoding` 一起删掉；此时若不再写回，body 只能靠关闭连接界定，而 mockttp 关闭 socket 时不发 TLS `close_notify`，rustls / hyper 会直接报 `peer closed connection without sending TLS close_notify`（pixi、uv、pip 全部中招）。`curl` 按 RFC 7230 §3.3.3 用 EOF 兜底，所以只有 Rust 客户端会失败。

**Cookie 默认单向，USTC 镜像例外。** `fetch` 会忽略客户端直接传入的 `Cookie` 头，请求 cookie 默认来自 `credentials: include` + Chrome 的 cookie jar。仅当请求 origin 严格等于 `https://mirrors.ustc.edu.cn` 时，扩展会先按 `;` 拆分客户端 Cookie，并用 `chrome.cookies.set` 写入 Chrome（`Path=/`、`Secure`），再发起请求；其他站点不会导入。反方向上，扩展用 `chrome.cookies.getAll(response.url)` 把终点 URL 的 cookie 转成 `set-cookie` 回传，`curl -c` 才能存下会话。

**重定向只对 GET / HEAD 可见。** `redirect` 未设置，默认 follow，重定向在 Chrome 内部完成；扩展看到 `resp.redirected` 就把终点 URL 还原成一次 302 交还客户端，客户端自己跟完剩下的跳。其余方法（POST 等）Chrome 已经重发过 body，原始状态码是 301/302/303 还是 307/308 无从得知，编一个会让客户端选错方法，只能直接给终点响应。任何情况下中间跳的 `Set-Cookie` 都拿不到。`redirect: "manual"` 是死路：service worker 里只给 opaqueredirect（status 0、无 header）。

**`--passthrough` 要求直连出网。** 透传由 Bun 进程直接连上游，不走 Chrome。若本机只靠 Chrome 出网，透传会 `ECONNREFUSED`，反而不如不解密。
