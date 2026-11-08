#!/usr/bin/env bun
/**
 * chrome-bridge：本地代理（HTTP / HTTPS CONNECT / SOCKS5 共用一个端口），
 * 除本地回环地址（直接转发）外，所有 HTTP(S) 请求都交给 Chrome 扩展用 fetch 发出。
 * 配合 background.js（协议 v5）使用。
 *
 *   ulimit -n 10240 && bun --prefer-offline mitmproxy.ts [--port 1080] [--ws 127.0.0.1:8765] [--ca-dir ~/.chrome-bridge-ca] [--passthrough "*.apple.cn,*.apple.com,*.icloud.com"]
 *
 * 文件描述符上限由外部 shell 的 ulimit 负责，程序内不再调整 RLIMIT_NOFILE：
 * macOS 默认 soft limit 只有 256，且超过 kern.maxfilesperproc 会失败，用 `ulimit -n 10240` 自行抬高。
 *
 * 结构：① 参数 ② 帧编解码 ③ 扩展通道 ④ CA 证书 ⑤ 接线 ⑥ 退出。
 * 通道只吃 mockttp.CompletedRequest、只吐 mockttp 的回调结果，两边靠类型对接，互不依赖内部实现。
 * 头全程用 mockttp 的 RawHeaders（[[name, value], ...]）：不经 Headers 归一化，大小写、重复、顺序原样保留。
 */
import * as mockttp from "mockttp@4.6.5";
import { findRawHeader, rawHeadersToObject } from "mockttp@4.6.5/dist/util/header-utils";
import { isLocalhostAddress } from "mockttp@4.6.5/dist/util/ip-utils";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ServerWebSocket } from "bun";

// ================================================================ ① 参数

const { values: opt } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        port: { type: "string", short: "p", default: "1080" },
        ws: { type: "string", default: "127.0.0.1:8765" },
        "ca-dir": {
            type: "string",
            default: join(homedir(), ".chrome-bridge-ca"),
        },
        // 不做 MITM、直接透传的域名，逗号分隔。透传的 TLS 由 Bun 直连上游，客户端看到真实证书，
        // 因此不需要信任 bridge 的 CA——这正是证书 pinning 应用和 Apple 系统服务需要的。
        // 代价：这些域名的流量不经过 Chrome，要求本机对这些域名有直接出网能力。
        passthrough: { type: "string", default: "" },
    },
});

function die(msg: string): never {
    console.error(msg);
    process.exit(1);
}

function toPort(s: string, name: string): number {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1 || n > 65535) die(`无效的 ${name}: ${s}`);
    return n;
}

const PORT = toPort(opt.port, "--port");

// --ws 只接受 host:port；URL.parse 对缺主机名、非数字端口、越界端口一律返回 null
const wsUrl = URL.parse(`ws://${opt.ws}`);
if (!wsUrl?.port) die(`无效的 --ws（需要 host:port）: ${opt.ws}`);
const WS_HOST = wsUrl.hostname.replace(/^\[|\]$/g, ""); // Bun.serve 不接受带方括号的 IPv6
const WS_PORT = toPort(wsUrl.port, "--ws");

const TIMEOUT_MS = 60_000;
const CA_DIR = opt["ca-dir"];
// 超过这个大小只告警，不拒绝：响应必须整块攒齐才能 resolve，越大越可能把内存吃满
const MAX_MB = 500;
const MAX = MAX_MB * 1024 * 1024;
// 单帧上限不跟 MAX 挂钩：不拒绝大 body 之后，一个几百 MB 的响应可能就是一帧。
// 取 2GB 是 Bun 接受的整数值，且不会预分配内存。shortcut: 单帧超过 2GB 仍会被 Bun 以 1009 断开。
const MAX_FRAME = 2 ** 31 - 1;

// 透传域名：一条 --passthrough 里用逗号分隔，省得命令行写一长串
const PASSTHROUGH = opt.passthrough
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// ================================================================ ② 帧编解码

/**
 * 协议 v5，与 background.js 的 pack/unpack 一一对应。
 * 帧格式：[单行 JSON 头]\n[正文]。WebSocket 消息本身已经是边界，不需要长度前缀；
 * JSON.stringify 不产生裸换行，所以第一个 \n 就是头与正文的分界。
 * 心跳是文本帧 "ping"：不占帧类型，也不占用二进制帧的编解码路径。
 *
 * 没有 head 帧：bridge 必须攒齐整个 body 才能 resolve，status/headers 提前到达也用不上，
 * 统一由 end 帧携带，省掉一套「头到了没到」的状态与分支。
 */

/** bridge -> 扩展 */
type ToExt =
    | {
          t: "req";
          id: string;
          method: string;
          url: string;
          headers: [string, string][];
      }
    | { t: "cancel"; id: string };

/** 扩展 -> bridge。扩展是可信对端，unpack 只保证 JSON 可解析，字段形状由协议保证。 */
type FromExt =
    | { t: "data"; id: string } // 正文在帧体里
    | { t: "end"; id: string; status: number; headers: [string, string][] }
    | { t: "end"; id: string; msg: string }; // 扩展侧失败，文案由扩展拼好

function pack(head: ToExt, body?: Uint8Array): Buffer {
    const h = Buffer.from(`${JSON.stringify(head)}\n`);
    return body?.length ? Buffer.concat([h, body]) : h;
}

function unpack(b: Buffer): { head: FromExt; body: Buffer } | null {
    const i = b.indexOf(10);
    if (i < 0) return null;
    try {
        return {
            head: JSON.parse(b.subarray(0, i).toString("utf8")) as FromExt,
            body: b.subarray(i + 1),
        };
    } catch {
        return null;
    }
}

// ================================================================ ③ 扩展通道

type Reply = mockttp.requestSteps.CallbackResponseMessageResult;
type WS = ServerWebSocket<{ origin: string }>;

/** 一次在途请求：扩展回来的 data 帧攒在这里，end 帧时一次性交给 mockttp */
interface Pending {
    id: string;
    method: string;
    url: string;
    chunks: Buffer[];
    size: number;
    seen: number; // 最后一帧的时间戳，超时扫描用
    resolve: (r: Reply) => void;
}

// 同一时刻只保留一条连接，pending 天然属于 current：连接一换，里面的请求全部作废
let current: WS | null = null;
const pending = new Map<string, Pending>();

// 回环标记头：扩展发出的 fetch 又回到 bridge 时靠它识别。
// 客户端自己带这个头会被当成回环（508），这是已知误判，换随机名可解，但保持固定名更简单。
const HOP = "x-bridge-hop";

function textReply(statusCode: number, message: string): Reply {
    // 必须显式给 content-length，原因见 complete()：少了 framing 头只能靠 EOF 定界，Rust 客户端会报错
    const rawBody = Buffer.from(`chrome-bridge: ${message}\n`);
    return {
        statusCode,
        headers: {
            "content-type": "text/plain; charset=utf-8",
            "content-length": String(rawBody.length),
        },
        rawBody,
    };
}

/** 发送一帧；连接不可用时返回 false，不抛（关闭中的 socket 上 send 会抛） */
function send(head: ToExt, body?: Uint8Array): boolean {
    const ws = current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    try {
        ws.send(pack(head, body));
        return true;
    } catch (e) {
        console.error(`[ws]    发送 ${head.t} 帧失败：${(e as Error).message}`);
        return false;
    }
}

/** 结束一次在途请求：清 pending、resolve。幂等，成功失败都走这里 */
function finish(p: Pending, r: Reply) {
    if (pending.get(p.id) !== p) return;
    pending.delete(p.id);
    p.resolve(r);
}

function warnLarge(what: string, size: number, url: string) {
    console.warn(`[size]  ${what} ${(size / 1024 / 1024).toFixed(1)} MB 超过 ${MAX_MB} MB：${url}`);
}

/** 失败：先让扩展中止对应的 fetch，再给客户端一个错误响应。已结束的请求直接跳过。 */
function fail(id: string, why: string, code: number) {
    const p = pending.get(id);
    if (!p) return;
    send({ t: "cancel", id });
    finish(p, textReply(code, why));
}

/** 连接没了：它的在途请求全部失败，别等超时 */
function failAll(why: string, code: number) {
    for (const id of pending.keys()) fail(id, why, code);
}

// 单一定时器统一扫超时：每收一帧重置 timer 会让大响应产生上千次定时器创建/销毁。
// 1s 粒度，超时最多晚 1s 触发。
setInterval(() => {
    const now = Date.now();
    for (const p of pending.values())
        if (now - p.seen > TIMEOUT_MS) fail(p.id, `扩展响应超时（${TIMEOUT_MS / 1000}s）`, 504);
}, 1000);

// 只对代理这一跳有意义的头；其余禁止设置的头由浏览器的 fetch 自动忽略。
// 必须覆盖 RFC 7230 §6.1 的完整逐跳头集合：漏掉 transfer-encoding 时，客户端发来的
// chunked 请求会把该头原样转给 Chrome 的 fetch——而 mockttp 已经把 chunked 解码成
// 连续 body，再声明 chunked 会让 fetch 按分块语法解析明文，请求体被截断或直接失败。
const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
]);

/**
 * 一份头能不能转给下一跳：剥掉逐跳头、Connection 头里逐个列出的字段名（RFC 7230 §6.1 第 2 段）、
 * proxy-* / x-bridge-* 前缀、HTTP/2 伪头。
 * 必须先读 Connection 再过滤，否则它自己的值会先消失。
 */
function forwardable(raw: [string, string][]): [string, string][] {
    const drop = new Set(HOP_BY_HOP);
    for (const [k, v] of raw)
        if (k.toLowerCase() === "connection")
            for (const n of v.split(",")) drop.add(n.trim().toLowerCase());
    return raw.filter(([k]) => {
        const n = k.toLowerCase();
        return (
            !drop.has(n) &&
            !n.startsWith("proxy-") &&
            !n.startsWith("x-bridge-") &&
            !n.startsWith(":")
        );
    });
}

// RFC 9110 不允许带 body 的状态码，补 content-length 反而会误导客户端
const NO_BODY_STATUS = new Set([204, 205, 304]);

/** 扩展回来的 end 帧：攒好的 body + 头变成 mockttp 的响应 */
function complete(p: Pending, status: number, pairs: [string, string][]) {
    // 扩展发来的是解压后的正文，上游的 framing 头必须重算，不能原样透传
    const out = forwardable(pairs).filter(([k]) => {
        const n = k.toLowerCase();
        return n !== "content-length" && n !== "content-encoding";
    });

    // content-length 必须显式写回：callback 返回了 headers 时 mockttp 会调 dropDefaultHeaders()，
    // 把 content-length / transfer-encoding 一起删掉（mockttp 4.6.5 的 writeResponseFromCallback）。
    // 两个 framing 头都没了，Node 只能置 Connection: close 并用 EOF 定界。
    // EOF 定界本身不可靠：hyper/rustls 要求先收到 TLS close_notify 才认 EOF，否则报
    // "peer closed connection without sending TLS close_notify"（pixi、uv、pip 全部中招）。
    // curl 按 RFC 7230 §3.3.3 用 EOF 兜底，所以只有 Rust 客户端会失败。
    // 无 body 的状态码不补；HEAD 用上游声明的值（非数字会让 writeHead 抛错，故先校验），其余按实际字节数。
    if (!NO_BODY_STATUS.has(status)) {
        const declared =
            p.method === "HEAD" ? findRawHeader(pairs, "content-length")?.[1] : undefined;
        out.push([
            "content-length",
            declared && /^\d+$/.test(declared) ? declared : String(p.size),
        ]);
    }

    // 单块（绝大多数响应）直接复用，省掉一次整块拷贝；多块才 concat，带上总长度省掉它自己再遍历一遍
    const rawBody = p.chunks.length === 1 ? p.chunks[0] : Buffer.concat(p.chunks, p.size);

    finish(p, {
        statusCode: status,
        headers: rawHeadersToObject(out), // 同名头合并成数组，多个 set-cookie 不互相覆盖
        rawBody,
    });
}

function onFrame(head: FromExt, body: Buffer) {
    const p = pending.get(head.id);
    if (!p) return; // 已结束或已取消的请求

    if (head.t === "end") {
        return "msg" in head
            ? finish(p, textReply(502, head.msg))
            : complete(p, head.status, head.headers);
    }

    p.size += body.length;
    if (p.size > MAX && p.size - body.length <= MAX) warnLarge("响应体", p.size, p.url);
    // 实测 Bun 不复用消息缓冲（每条消息独立 ArrayBuffer），可直接持有视图，省掉一次整块 memcpy
    p.chunks.push(body);
    p.seen = Date.now();
}

/** 把请求交给扩展，等它把响应流回来。id 直接用 mockttp 分配的 req.id。 */
function viaChrome(req: mockttp.CompletedRequest): mockttp.MaybePromise<Reply> {
    // 扩展发出的 fetch 又回到了这里：Chrome 或系统代理指向了 bridge 本身
    if (findRawHeader(req.rawHeaders, HOP)) {
        console.error(`[loop]  ${req.method} ${req.url}：Chrome 的代理指向了 bridge 本身`);
        return textReply(508, "检测到回环：Chrome 的代理指向了 bridge 本身");
    }

    if (current?.readyState !== WebSocket.OPEN) return textReply(502, "Chrome 扩展未连接");

    const body = req.body.buffer;
    if (body.byteLength > MAX) warnLarge("请求体", body.byteLength, req.url);

    return new Promise<Reply>((resolve) => {
        const p: Pending = {
            id: req.id,
            method: req.method,
            url: req.url,
            chunks: [],
            size: 0,
            seen: Date.now(),
            resolve,
        };
        pending.set(req.id, p);
        const head: ToExt = {
            t: "req",
            id: req.id,
            method: req.method,
            url: req.url,
            headers: forwardable(req.rawHeaders),
        };
        if (!send(head, body)) finish(p, textReply(502, "发送到扩展失败"));
    });
}

/** 只接受扩展连接的 WebSocket 服务 */
const wsServer = Bun.serve({
    hostname: WS_HOST,
    port: WS_PORT,
    fetch(req, server) {
        // 这道 Origin 检查不是防本机进程（本机进程本来就什么都能做），而是挡住任意网页：
        // WebSocket 没有同源限制，任何站点都能连 ws://127.0.0.1 顶掉扩展、接管全部代理流量。
        // 网页无法伪造 chrome-extension:// 的 Origin，三行换掉这个洞，留着。
        const origin = req.headers.get("origin") ?? "";
        if (!origin.startsWith("chrome-extension://")) {
            console.warn(`[ws]    拒绝：origin=${origin || "-"}`);
            return new Response("forbidden\n", { status: 403 });
        }
        if (server.upgrade(req, { data: { origin } })) return;
        return new Response("websocket only\n", { status: 426 });
    },
    websocket: {
        maxPayloadLength: MAX_FRAME, // 超限时 Bun 直接以 1009 断开连接，所以给足
        perMessageDeflate: false,
        idleTimeout: 120, // 扩展每 20 秒发一次心跳
        open(ws: WS) {
            // 先让旧连接名下的请求失败再切换：cancel 帧要发到旧连接上
            if (current) {
                failAll("扩展连接被新连接替换", 502);
                current.close(1000, "replaced");
            }
            current = ws;
            console.log(`[ws]    Chrome 扩展已连接：${ws.data.origin}`);
        },
        message(ws: WS, msg: string | Buffer) {
            if (ws !== current) return; // 被替换的连接上残留的帧
            if (typeof msg === "string") return; // 文本帧只有心跳 "ping"，不回应
            const f = unpack(msg); // 已是 Buffer，body 直接是视图，不复制
            if (f) onFrame(f.head, f.body);
        },
        close(ws: WS) {
            if (ws !== current) return;
            current = null;
            console.log("[ws]    Chrome 扩展已断开");
            failAll("Chrome 扩展已断开", 502);
        },
    },
});

// ================================================================ ④ CA 证书

async function ensureCA(dir: string) {
    const keyPath = join(dir, "ca.key");
    const certPath = join(dir, "ca.pem");
    if (!existsSync(keyPath) || !existsSync(certPath)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const { key, cert } = await mockttp.generateCACertificate({
            subject: {
                commonName: "Chrome Bridge CA",
                organizationName: "chrome-bridge",
            },
            bits: 2048, // generateCACertificate 的默认值，显式写出以防上游变动
        });
        writeFileSync(keyPath, key, { mode: 0o600 });
        writeFileSync(certPath, cert, { mode: 0o644 });
        console.log(`[ca]    已重新生成 CA：${certPath}（需要加入信任）`);
    }
    return { keyPath, certPath };
}

// ================================================================ ⑤ 接线

const { keyPath, certPath } = await ensureCA(CA_DIR);

const server = mockttp.getLocal({
    https: {
        keyPath,
        certPath,
        // 命中的域名不解密，裸 TCP 转发给上游：客户端看到的是真实证书，不需要信任 bridge 的 CA。
        // 这是 pinning 应用（WhatsApp 等）和 Apple 系统服务的唯一可行路径。
        // 注意：透传由 Bun 进程直接连上游，要求本机对这些域名有直连出网能力；
        // 若本机只靠 Chrome 出网，透传会 ECONNREFUSED，反而不如不解密。
        // 空数组与不传等价（mockttp 内部 `list?.map(...) ?? []`），所以不必按长度分支。
        tlsPassthrough: PASSTHROUGH.map((hostname) => ({ hostname })),
    },
    socks: true,
    passthrough: ["unknown-protocol"], // 通过 SOCKS 进来的非 HTTP 流量（如 ssh）直接转发
    http2: false,
    recordTraffic: false, // 默认 true：留存流量供 .seenRequests 查询，这里用不到
    suggestChanges: false, // 默认 true：启动后打印「用 Mockttp 还能…」的提示，用不到
    // 不设 maxBodySize：它超限时清空 body 而不报错，大请求会被静默变成空 body
});

await server.forAnyWebSocket().thenPassThrough(); // fetch 转发不了 WebSocket，直接转发
// 本地回环直连：dev server、bridge 自己这些地址不该绕道 Chrome。
// 用 mockttp 自己的 isLocalhostAddress 判断，localhost / *.localhost / 127.0.0.0/8 / ::1 全覆盖。
// forAnyRequest 是 DEFAULT 优先级，天然压过下面的 forUnmatchedRequest（FALLBACK），不依赖注册顺序。
await server
    .forAnyRequest()
    .matching((req) => !!isLocalhostAddress(req.destination.hostname))
    .always()
    .thenPassThrough();
await server.forUnmatchedRequest().thenCallback(viaChrome);

// 客户端先断开时，让扩展中止对应的 fetch，别把剩下的响应白读一遍
await server.on("abort", (req) => fail(req.id, "客户端已断开", 499));

/**
 * failureCause 描述的是「客户端怎么结束的」，不等于「为什么失败」，不能一律当成不信任 CA。
 * 只有 cert-rejected（客户端明确回了 alert unknown ca / bad certificate）才是信任问题；
 * reset / closed 是客户端一个 alert 都没发就掐断连接，装 CA 永远解决不了，得往 pinning 或
 * 非 HTTP 协议上查。分不清这两类，排查方向会一直错。
 *
 * 注意：mockttp 的 getCauseFromError 靠正则匹配错误文案判定 cert-rejected，它认的是 Node 的
 * 写法（"alert unknown ca" / code "ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE"）。Bun 给的是 OpenSSL
 * 常量名（"TLSV1_ALERT_UNKNOWN_CA" / code "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA"），一条都对不上，
 * 于是「客户端不信任 CA」全被归成 unknown。TLS 1.3 的 alert 还是加密的，Bun 只能看到
 * BAD_PACKET_LENGTH，情况更糟。因此 cert-rejected 在 Bun 下基本不会出现，真正的信任问题
 * 会落到 unknown，并在上一行留下 mockttp 打的 "Unknown TLS error"。
 */
// 全量 Record：failureCause 只有这 6 个值，漏写会编译报错，日志里也就不需要兜底分支
const TLS_CAUSE: Record<mockttp.TlsHandshakeFailure["failureCause"], string> = {
    "cert-rejected": "客户端不信任 CA（回了 alert）",
    reset: "客户端静默 RST，未回 alert：多为证书 pinning 或非 HTTP 协议，装 CA 无效",
    closed: "客户端未回 alert 就关闭连接：多为 pinning，或只是探测/预连接",
    "no-shared-cipher": "密码套件协商失败，与证书无关",
    "handshake-timeout": "客户端未发 ClientHello，握手超时",
    // Bun 的 alert 文案与 mockttp 的正则对不上（TLS 1.3 还加密），「客户端拒绝证书」也落在这里
    unknown: "原因未识别：若上一行是 alert 或 BAD_PACKET_LENGTH，通常是客户端拒绝了证书",
};

await server.on("tls-client-error", (e) => {
    console.warn(
        `[tls]   ${e.tlsMetadata?.sniHostname ?? "-"} 握手失败（${e.failureCause}，来自 :${e.remotePort ?? "?"}）：${TLS_CAUSE[e.failureCause]}`,
    );
});

await server.start(PORT);

console.log(
    `[proxy] 监听 :${server.port}（HTTP / HTTPS CONNECT / SOCKS5），HTTP(S) 交给 Chrome，本地地址直连`,
);
console.log(`[ws]    等待扩展连接 ws://${WS_HOST}:${wsServer.port}`);
console.log(`[ca]    ${certPath}`);

// ================================================================ ⑥ 退出

let stopping = false;
async function shutdown() {
    if (stopping) return;
    stopping = true;
    failAll("bridge 正在关闭", 503);
    await server.stop().catch(() => {});
    wsServer.stop(true);
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
