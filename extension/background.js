const WS_URL = "ws://127.0.0.1:8765";
const MAX_BUFFERED = 8 * 1024 * 1024;

const enc = new TextEncoder();
const dec = new TextDecoder();

function pack(head, body) {
    const h = enc.encode(`${JSON.stringify(head)}\n`);
    if (!body?.length) return h;
    const out = new Uint8Array(h.length + body.length);
    out.set(h);
    out.set(body, h.length);
    return out;
}

function send(sock, head, body) {
    if (sock.readyState !== WebSocket.OPEN) return false;
    sock.send(pack(head, body));
    return true;
}

let ws;
let retryDelay = 500;
const inflight = new Map();

function onMessage(sock, data) {
    const bytes = new Uint8Array(data);
    const i = bytes.indexOf(10);
    const head = JSON.parse(dec.decode(bytes.subarray(0, i)));
    if (head.t === "req") handle(sock, head, bytes.subarray(i + 1));
    else inflight.get(head.id)?.abort();
}

async function drain(sock) {
    while (sock.readyState === WebSocket.OPEN && sock.bufferedAmount > MAX_BUFFERED) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (sock.readyState !== WebSocket.OPEN) throw new Error("bridge disconnected");
}

function connect() {
    if (ws && ws.readyState <= WebSocket.OPEN) return;
    const sock = new WebSocket(WS_URL);
    ws = sock;
    sock.binaryType = "arraybuffer";

    sock.onopen = () => {
        retryDelay = 500;
        console.log("[bridge] connected");
    };
    sock.onmessage = (event) => onMessage(sock, event.data);
    sock.onclose = () => {
        if (ws !== sock) return;
        console.warn(`[bridge] closed, retry in ${retryDelay}ms`);
        ws = undefined;
        for (const controller of inflight.values()) controller.abort();
        inflight.clear();
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 5000);
    };
}

setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send("ping");
}, 20_000);

chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
connect();

async function applyCookies(url, headers) {
    if (new URL(url).origin !== "https://mirrors.ustc.edu.cn") return;

    for (const cookie of headers.get("cookie")?.split(";") ?? []) {
        const i = cookie.indexOf("=");
        await chrome.cookies.set({
            url,
            name: cookie.slice(0, i).trim(),
            value: cookie.slice(i + 1).trim(),
            path: "/",
            secure: true,
        });
    }
}

async function cookieHeaders(url) {
    return (await chrome.cookies.getAll({ url })).map((c) => [
        "set-cookie",
        [
            `${c.name}=${c.value}`,
            !c.hostOnly && `Domain=${c.domain}`,
            `Path=${c.path}`,
            c.secure && "Secure",
            c.httpOnly && "HttpOnly",
            c.expirationDate && `Expires=${new Date(c.expirationDate * 1000).toUTCString()}`,
        ]
            .filter(Boolean)
            .join("; "),
    ]);
}

async function handle(sock, req, body) {
    const controller = new AbortController();
    inflight.set(req.id, controller);
    try {
        const headers = new Headers(req.headers);
        await applyCookies(req.url, headers);

        const response = await fetch(req.url, {
            method: req.method,
            headers,
            body: body.length && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
            credentials: "include",
            cache: "no-store",
            signal: controller.signal,
        });

        const replay = response.redirected && (req.method === "GET" || req.method === "HEAD");
        if (
            replay &&
            send(sock, { t: "end", id: req.id, status: 302, headers: [["location", response.url]] })
        ) {
            await response.body?.cancel();
            return;
        }

        for await (const chunk of response.body ?? []) {
            await drain(sock);
            send(sock, { t: "data", id: req.id }, chunk);
        }
        send(sock, {
            t: "end",
            id: req.id,
            status: response.status,
            headers: [...response.headers, ...(await cookieHeaders(response.url))],
        });
    } catch (error) {
        if (!controller.signal.aborted) send(sock, { t: "end", id: req.id, msg: String(error) });
    } finally {
        inflight.delete(req.id);
    }
}
