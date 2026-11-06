// chrome-bridge 扩展端（协议 v5）：连本地 mitmproxy.ts，用 Chrome 的 fetch 代发请求。
// 重定向按 GET / HEAD 还原成 302 交还客户端，其余方法维持终点响应。
// 结构：① 帧 ② 通道 ③ 请求处理。帧格式：[单行 JSON 头]\n[正文]
const WS_URL = "ws://127.0.0.1:8765"; // 和 mitmproxy.ts 的 --ws 一致
const MAX_BUFFERED = 8 * 1024 * 1024; // 发送缓冲超过这个值就暂停（背压）

// ================================================================ ① 帧

const enc = new TextEncoder();
const dec = new TextDecoder();

// WebSocket 消息本身已是边界，头与正文只靠第一个 \n 分隔（JSON.stringify 不产生裸换行）
function pack(head, body) {
    const h = enc.encode(JSON.stringify(head) + "\n");
    if (!body?.length) return h;
    const out = new Uint8Array(h.length + body.length);
    out.set(h);
    out.set(body, h.length);
    return out;
}

/** 发一帧；socket 不可用时返回 false，不抛 */
function send(sock, head, body) {
    if (sock.readyState !== WebSocket.OPEN) return false;
    sock.send(pack(head, body));
    return true;
}

// ================================================================ ② 通道

let ws = null;
let backoff = 500;
const inflight = new Map(); // 请求 id -> AbortController

/** 帧路由：mitmproxy.ts 是可信对端，帧形状由协议保证，只按 t 分派 */
function onMessage(sock, data) {
    const bytes = new Uint8Array(data);
    const i = bytes.indexOf(10);
    if (i < 0) return; // 半截消息，丢弃
    const head = JSON.parse(dec.decode(bytes.subarray(0, i)));
    if (head.t === "req") handle(sock, head, bytes.subarray(i + 1));
    else if (head.t === "cancel") inflight.get(head.id)?.abort();
}

/** 等发送缓冲降下来；连接断了就别再等，直接抛错让上层放弃这次响应 */
async function drain(sock) {
    // 轮询而不是用 bufferedamountlow 事件：socket 卡住（对端不读）时事件永远不会来，轮询至少能靠 close 退出
    while (sock.readyState === WebSocket.OPEN && sock.bufferedAmount > MAX_BUFFERED) {
        await new Promise((r) => setTimeout(r, 10));
    }
    if (sock.readyState !== WebSocket.OPEN) throw new Error("bridge disconnected"); // 别把剩下的几百 MB 白读一遍
}

function connect() {
    if (ws && ws.readyState <= WebSocket.OPEN) return; // 正在连接或已连接
    const sock = new WebSocket(WS_URL);
    ws = sock;
    sock.binaryType = "arraybuffer";

    sock.onopen = () => {
        backoff = 500;
        console.log("[bridge] connected");
    };

    sock.onmessage = (e) => onMessage(sock, e.data);

    sock.onclose = (e) => {
        // 旧连接的 onclose 会晚于新连接建立触发；此时既不能清 inflight，也不该重连
        if (ws !== sock) return;
        console.warn(`[bridge] closed code=${e.code} reason=${e.reason || "-"}, retry in ${backoff}ms`);
        ws = null;
        for (const ac of inflight.values()) ac.abort();
        inflight.clear();
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 5000);
    };
}

// 心跳：Chrome 116+ 下 WebSocket 有消息往来，service worker 就不会被回收。
// 用文本帧 "ping"，不占二进制帧的帧类型。
setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send("ping");
}, 20_000);

// 万一 service worker 还是被回收了：浏览器启动时连接，另外定时唤醒检查一次
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
connect();

// ================================================================ ③ 请求处理

function buildHeaders(raw) {
    // 用 Chrome 自己的 UA；禁止设置的头（Cookie、Host、Origin、Sec-* 等）fetch 会自动忽略
    const headers = new Headers(raw.filter(([k]) => k.toLowerCase() !== "user-agent"));
    headers.set("x-bridge-hop", "1"); // 回环检测标记
    return headers;
}

function fmtCookie(c) {
    return [
        `${c.name}=${c.value}`,
        !c.hostOnly && `Domain=${c.domain}`, // host-only cookie 不能带 Domain，否则会被当成域 cookie
        `Path=${c.path}`,
        c.secure && "Secure",
        c.httpOnly && "HttpOnly",
        c.expirationDate && `Expires=${new Date(c.expirationDate * 1000).toUTCString()}`,
    ]
        .filter(Boolean)
        .join("; ");
}

// fetch 的 credentials 只进 Chrome 的 cookie jar，代理客户端拿不到；
// 把目标站的 cookie 回传成 Set-Cookie，客户端（如 curl -c）才能保存会话
async function cookieHeaders(url) {
    try {
        return (await chrome.cookies.getAll({ url })).map((c) => ["set-cookie", fmtCookie(c)]);
    } catch {
        return []; // data:/blob: 等非 http(s) 响应无法查 cookie，别因此丢掉整个响应
    }
}

/**
 * 一次请求的完整生命周期：fetch → 还原重定向或流式转发 → 收尾 end 帧。
 * 失败自己回报，不抛：只有这里知道上游状态码和已发字节数，错误文案得由它拼。
 */
async function handle(sock, req, body) {
    const ac = new AbortController();
    inflight.set(req.id, ac);
    let resp; // 拿到响应后才知道上游状态码
    let sent = 0; // 已推给 bridge 的字节数
    try {
        const hasBody = body.length > 0 && req.method !== "GET" && req.method !== "HEAD";
        resp = await fetch(req.url, {
            method: req.method,
            headers: buildHeaders(req.headers),
            body: hasBody ? body : undefined,
            credentials: "include", // 带上 Chrome 的 Cookie
            cache: "no-store",
            signal: ac.signal,
        });

        // Chrome 把重定向跟完了，客户端却只拿到终点响应：依赖 3xx 的客户端（pixi self-update 靠
        // response.url 的最后一段取版本号）会直接判错，所以把终点 URL 还原成一次 302 让它自己跟。
        // 只对 GET / HEAD 成立——其余方法 Chrome 已经重发过 body，原始状态码是 301/302/303 还是
        // 307/308 无从得知，编一个会让客户端选错方法，只能维持「直接给终点响应」。
        // shortcut: 中间跳的 Set-Cookie 仍然丢，GET/HEAD 多一次往返；要补全得让 Chrome 别跟重定向，
        // 但 service worker 里 redirect:"manual" 只给 opaqueredirect（status 0、无 header），做不到。
        // 发不出去就退回正常路径，让下面的 drain() 按「连接已断」抛错，别假装成功
        const replay = resp.redirected && resp.url !== req.url && (req.method === "GET" || req.method === "HEAD");
        if (replay && send(sock, { t: "end", id: req.id, status: 302, headers: [["location", resp.url]] })) {
            resp.body?.cancel().catch(() => { }); // 终点正文客户端会自己再取一遍，别白读
            return;
        }

        // 只有 resp.body 是流式的；HEAD / 204 / 304 按规范就是 null，无需再判断状态码
        if (resp.body) {
            const reader = resp.body.getReader();
            for (; ;) {
                const { done, value } = await reader.read();
                if (done) break;
                await drain(sock);
                send(sock, { t: "data", id: req.id }, value);
                sent += value.length;
            }
        }
        send(sock, { t: "end", id: req.id, status: resp.status, headers: [...resp.headers, ...(await cookieHeaders(resp.url))] });
    } catch (e) {
        if (ac.signal.aborted) return; // 被 bridge 取消时不用回报
        // bridge 只认 end 帧，「上游已响应但正文断了」和「根本没连上」的区别只能靠这里拼进 msg
        send(sock, {
            t: "end", id: req.id, status: 0, headers: [],
            msg: resp ? `上游已回 ${resp.status}，已发 ${sent} 字节后失败（${e}）` : `fetch 失败：${e}`,
        });
    } finally {
        inflight.delete(req.id);
    }
}
