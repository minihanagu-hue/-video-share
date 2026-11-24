// 影片放映室 — 雲端影片後端（Cloudflare Worker）
// 保管 Bunny Stream 的 API 金鑰，讓網頁不必把金鑰放在公開的地方。
//
// 需要在 Cloudflare 設定的變數（Settings → Variables and Secrets）：
//   BUNNY_LIBRARY_ID   影片庫 ID（數字）
//   BUNNY_API_KEY      影片庫的 API Key（請設成「Secret」）
//   BUNNY_CDN_HOST     影片庫的 CDN 網域，例如 vz-12345678-abc.b-cdn.net
//   ADMIN_PASSWORD     管理者密碼（請設成「Secret」，越長越好）
//   SITE_ORIGIN        你的網站網址，例如 https://minihanagu-hue.github.io（多個用逗號隔開）
//
// 公開：GET  /videos            取得已轉檔完成的影片清單
// 管理：POST /login             檢查密碼
//       GET  /admin/videos      取得全部影片（含處理中）
//       POST /admin/upload      建立影片並取得上傳授權
//       POST /admin/videos/:id  修改標題、分類、介紹、日期
//       DELETE /admin/videos/:id 刪除影片

const API = "https://video.bunnycdn.com/library";

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = (env.SITE_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : (allowed[0] || "*"),
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization,Content-Type",
      "Vary": "Origin"
    };
    const json = (data, status = 200, extra = {}) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors, ...extra } });

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      // ---------- 公開 ----------
      if (req.method === "GET" && path === "/videos") {
        const items = await listAll(env);
        const pub = items.filter(v => v.status === 4).map(v => shape(v, env));
        return json(pub, 200, { "Cache-Control": "public, max-age=60" });
      }

      // ---------- 管理（需要密碼） ----------
      if (path === "/login" || path.startsWith("/admin/")) {
        if (!(await checkPassword(req, env))) {
          await sleep(800); // 減慢猜密碼的速度
          return json({ error: "密碼不正確" }, 401);
        }
      }

      if (req.method === "POST" && path === "/login") return json({ ok: true });

      if (req.method === "GET" && path === "/admin/videos") {
        const items = await listAll(env);
        return json(items.map(v => shape(v, env)));
      }

      if (req.method === "POST" && path === "/admin/upload") {
        const body = await req.json();
        const title = String(body.title || "").trim().slice(0, 200);
        if (!title) return json({ error: "請填標題" }, 400);
        const video = await bunny(env, `/${env.BUNNY_LIBRARY_ID}/videos`, { method: "POST", body: JSON.stringify({ title }) });
        await setMeta(env, video.guid, title, body);
        const expire = Math.floor(Date.now() / 1000) + 60 * 60 * 24; // 24 小時內有效
        const signature = await sha256(`${env.BUNNY_LIBRARY_ID}${env.BUNNY_API_KEY}${expire}${video.guid}`);
        return json({ libraryId: String(env.BUNNY_LIBRARY_ID), videoId: video.guid, expire, signature });
      }

      const m = path.match(/^\/admin\/videos\/([0-9a-f-]{36})$/i);
      if (m && req.method === "POST") {
        const body = await req.json();
        const title = String(body.title || "").trim().slice(0, 200);
        if (!title) return json({ error: "請填標題" }, 400);
        await setMeta(env, m[1], title, body);
        return json({ ok: true });
      }
      if (m && req.method === "DELETE") {
        await bunny(env, `/${env.BUNNY_LIBRARY_ID}/videos/${m[1]}`, { method: "DELETE" });
        return json({ ok: true });
      }

      return json({ error: "找不到這個網址" }, 404);
    } catch (e) {
      return json({ error: "伺服器錯誤：" + (e.message || e) }, 500);
    }
  }
};

async function bunny(env, p, init = {}) {
  const r = await fetch(API + p, {
    ...init,
    headers: { AccessKey: env.BUNNY_API_KEY, Accept: "application/json", "Content-Type": "application/json" }
  });
  if (!r.ok) throw new Error(`Bunny ${r.status}`);
  const t = await r.text();
  return t ? JSON.parse(t) : {};
}

async function listAll(env) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const d = await bunny(env, `/${env.BUNNY_LIBRARY_ID}/videos?page=${page}&itemsPerPage=100&orderBy=date`);
    out.push(...(d.items || []));
    if (out.length >= (d.totalItems || 0) || !(d.items || []).length) break;
  }
  return out;
}

// 分類、介紹、日期存在 Bunny 影片的 metaTags 裡
async function setMeta(env, id, title, b) {
  const metaTags = [
    { property: "cat", value: String(b.cat || "").slice(0, 40) },
    { property: "desc", value: String(b.desc || "").slice(0, 500) },
    { property: "date", value: /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") ? b.date : "" }
  ];
  await bunny(env, `/${env.BUNNY_LIBRARY_ID}/videos/${id}`, { method: "POST", body: JSON.stringify({ title, metaTags }) });
}

function shape(v, env) {
  const meta = Object.fromEntries((v.metaTags || []).map(t => [t.property, t.value]));
  return {
    id: v.guid,
    title: v.title,
    cat: meta.cat || "",
    desc: meta.desc || "",
    date: meta.date || String(v.dateUploaded || "").slice(0, 10),
    length: v.length || 0,
    status: v.status,            // 4 = 可以播放；0–3 = 上傳／轉檔中；5、6 = 失敗
    progress: v.encodeProgress || 0,
    tall: v.height > v.width,
    thumb: v.thumbnailFileName ? `https://${env.BUNNY_CDN_HOST}/${v.guid}/${v.thumbnailFileName}` : "",
    embed: `https://iframe.mediadelivery.net/embed/${env.BUNNY_LIBRARY_ID}/${v.guid}`,
    play: `https://iframe.mediadelivery.net/play/${env.BUNNY_LIBRARY_ID}/${v.guid}`
  };
}

async function checkPassword(req, env) {
  const given = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!env.ADMIN_PASSWORD || !given) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(env.ADMIN_PASSWORD)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, "0")).join("");
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
