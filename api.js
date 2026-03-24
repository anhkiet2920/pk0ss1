const fs   = require("fs");
const path = require("path");
const os   = require("os");

const LISTAPI_DIR = path.join(process.cwd(), "includes", "listapi");

// ── Bảng content-type → extension ────────────────────────────────────────────
const MIME_TO_EXT = {
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
  "video/x-msvideo": "avi", "video/x-matroska": "mkv", "video/3gpp": "3gp",
  "video/x-flv": "flv", "video/ogg": "ogv",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/ogg": "ogg",
  "audio/wav": "wav", "audio/aac": "aac", "audio/flac": "flac",
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
  "image/webp": "webp", "image/bmp": "bmp", "image/svg+xml": "svg",
};

// ── Magic bytes → extension (fallback khi không có content-type) ──────────────
function extFromMagic(buf) {
  if (!buf || buf.length < 4) return null;
  const b = buf;
  // JPEG
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return "jpg";
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return "png";
  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  // WEBM / MKV
  if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return "webm";
  // MP3 (ID3)
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return "mp3";
  // MP3 (sync frame)
  if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return "mp3";
  if (buf.length >= 8) {
    // MP4 / MOV (ftyp box ở byte 4-7)
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "mp4";
  }
  if (buf.length >= 12) {
    // AVI (RIFF....AVI )
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x41 && b[9] === 0x56 && b[10] === 0x49) return "avi";
    // WEBP (RIFF....WEBP)
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  }
  return null;
}

// ── Danh sách extension video để dùng Release Upload ─────────────────────────
const VIDEO_EXTS = new Set(["mp4","webm","mkv","avi","mov","flv","m4v","3gp","ogv","wmv"]);

// ── Helper: Tải URL về file tạm, phát hiện đúng định dạng, upload lên GitHub ─
async function uploadToGithub(url, baseName) {
  const res = await global.axios.get(url, { responseType: "arraybuffer", timeout: 60000 });
  const buf = Buffer.from(res.data);

  // Xác định extension: content-type → magic bytes → URL → fallback mp4
  const ct  = (res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  let ext   = MIME_TO_EXT[ct]
    || extFromMagic(buf)
    || (() => {
         try {
           const p = new URL(url).pathname.split("?")[0];
           const e = path.extname(p).replace(".", "").toLowerCase();
           return e || null;
         } catch { return null; }
       })()
    || "mp4";

  // Tên file sạch: bỏ đuôi cũ nếu có, gắn đuôi đúng
  const nameNoExt = path.basename(baseName).replace(/\.[^.]+$/, "");
  const fileName  = `${nameNoExt}.${ext}`;
  const tmpPath   = path.join(os.tmpdir(), `api_upload_${Date.now()}_${fileName}`);

  try {
    fs.writeFileSync(tmpPath, buf);
    // Video dùng Release Upload (không giới hạn kích thước, Zalo chấp nhận tốt hơn)
    // Ảnh/audio dùng Content API thông thường
    let downloadUrl;
    if (VIDEO_EXTS.has(ext)) {
      downloadUrl = await global.githubReleaseUpload(tmpPath, fileName);
    } else {
      const repoPath = `listapi/${Date.now()}_${fileName}`;
      downloadUrl    = await global.githubUpload(tmpPath, repoPath);
    }
    return downloadUrl;
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

// ── Helper: Đảm bảo file JSON tồn tại và trả về mảng hiện có ─────────────────
function loadJsonList(tipName) {
  if (!fs.existsSync(LISTAPI_DIR)) fs.mkdirSync(LISTAPI_DIR, { recursive: true });
  const dataPath = path.join(LISTAPI_DIR, `${tipName}.json`);
  if (!fs.existsSync(dataPath)) fs.writeFileSync(dataPath, "[]", "utf-8");
  return { dataPath, data: JSON.parse(fs.readFileSync(dataPath, "utf-8")) };
}

// ── Helper: Kiểm tra chuỗi có phải URL hợp lệ không ─────────────────────────
function isValidUrl(str) {
  try { return /^https?:\/\/.+/.test(new URL(str).href); } catch { return false; }
}

// ── Regex nhận dạng link media (video / ảnh / audio) ─────────────────────────
const MEDIA_EXTS_RE = /\.(mp4|webm|mkv|avi|mov|flv|m4v|3gp|ogv|wmv|mp3|aac|m4a|ogg|wav|flac|jpg|jpeg|png|gif|webp|bmp|svg)(\?[^"'\s<>]*)?$/i;
const MEDIA_CT_RE   = /^(video|audio|image)\//;

// ── Helper: Fetch URL → lấy toàn bộ link có thể download bên trong ───────────
// Ưu tiên: 1) JSON array  2) file media trực tiếp  3) scrape HTML/JS
async function extractMediaLinks(url) {
  // 1. Fetch nội dung URL dạng arraybuffer để xử lý cả file binary lẫn text
  let bodyBuf, body = "", contentType = "";
  try {
    const res = await global.axios.get(url, {
      timeout: 20000,
      responseType: "arraybuffer",
      headers: { "User-Agent": "Mozilla/5.0" },
      maxContentLength: 20 * 1024 * 1024
    });
    bodyBuf     = Buffer.from(res.data);
    body        = bodyBuf.toString("utf-8");
    contentType = (res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  } catch (e) {
    global.logWarn?.(`[api] extractMediaLinks fetch lỗi: ${e.message}`);
    return [url]; // nếu fetch lỗi → trả về chính URL đó
  }

  // 2. Thử parse JSON (file .bin / .json chứa mảng link)
  try {
    const parsed = JSON.parse(body);
    // Mảng string → lấy tất cả URL hợp lệ
    if (Array.isArray(parsed)) {
      const links = parsed.filter(v => typeof v === "string" && isValidUrl(v));
      if (links.length > 0) return links;
    }
    // Object có key là array → lấy mảng đầu tiên tìm thấy
    if (parsed && typeof parsed === "object") {
      for (const val of Object.values(parsed)) {
        if (Array.isArray(val)) {
          const links = val.filter(v => typeof v === "string" && isValidUrl(v));
          if (links.length > 0) return links;
        }
      }
    }
  } catch { /* không phải JSON */ }

  // 3. Nếu là file media trực tiếp (theo content-type hoặc magic bytes) → trả về URL
  const detectedExt = extFromMagic(bodyBuf);
  if (MEDIA_CT_RE.test(contentType) || detectedExt || MEDIA_EXTS_RE.test(url.split("?")[0])) {
    return [url];
  }

  // 4. Scrape HTML / JS để tìm tất cả link có đuôi media
  const found = new Set();

  for (const m of body.matchAll(/(?:src|href|url|file|link|path|source)=?["'\s:]?\s*["']?(https?:\/\/[^"'\s<>,]+)/gi)) {
    try {
      const abs = new URL(m[1], url).href;
      if (MEDIA_EXTS_RE.test(abs.split("?")[0])) found.add(abs);
    } catch { /* skip */ }
  }

  for (const m of body.matchAll(/https?:\/\/[^\s"'<>()[\]{}]+/gi)) {
    const link = m[0].replace(/[.,;)}\]]+$/, "");
    if (MEDIA_EXTS_RE.test(link.split("?")[0])) found.add(link);
  }

  return found.size > 0 ? [...found] : [url];
}

// ── Helper: Link đã nằm trên GitHub chưa ─────────────────────────────────────
function isGithubLink(url) {
  return url.includes("raw.githubusercontent.com") || url.includes("github.com");
}

// ── Helper: Lấy extension từ URL ──────────────────────────────────────────────
function extFromUrl(url) {
  try {
    const p = new URL(url).pathname;
    const ext = path.extname(p).replace(".", "").toLowerCase();
    return ext || "bin";
  } catch { return "bin"; }
}

// ── Helper: Kiểm tra & convert 1 file JSON ───────────────────────────────────
async function checkAndConvertFile(filePath, fileName, send) {
  let links = [];
  try { links = JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch {
    return `📄 ${fileName}\n  ❌ Không đọc được file.`;
  }
  if (!Array.isArray(links) || links.length === 0) {
    return `📄 ${fileName}\n  ⚠️ File trống.`;
  }

  let live = 0, dead = 0, converted = 0, failed = 0;
  const newLinks = [];
  let convertIdx = 0;

  for (const link of links) {
    // 1. Kiểm tra link còn sống không
    let alive = false;
    try {
      const r = await global.axios.head(link, { timeout: 8000 });
      alive = r.status === 200;
    } catch { alive = false; }

    if (!alive) {
      dead++;
      continue; // Bỏ link chết ra khỏi danh sách
    }

    // 2. Nếu sống nhưng chưa phải GitHub → convert lên GitHub
    if (!isGithubLink(link)) {
      try {
        const ext      = extFromUrl(link);
        const baseName = path.basename(fileName, ".json");
        const ghUrl    = await uploadToGithub(link, `${baseName}_${Date.now()}_${convertIdx++}.${ext}`);
        if (ghUrl) {
          newLinks.push(ghUrl);
          converted++;
        } else {
          newLinks.push(link); // giữ nguyên nếu không lấy được URL
          failed++;
        }
      } catch {
        newLinks.push(link); // giữ nguyên nếu upload lỗi
        failed++;
      }
    } else {
      newLinks.push(link);
      live++;
    }
  }

  // Lưu lại danh sách đã cập nhật
  fs.writeFileSync(filePath, JSON.stringify(newLinks, null, 2), "utf-8");

  let summary = `📄 ${fileName}\n`;
  summary += `  ✅ GitHub: ${live}  🔄 Converted: ${converted}  ❎ Đã xoá (die): ${dead}`;
  if (failed > 0) summary += `  ⚠️ Convert lỗi: ${failed}`;
  summary += `  📝 Còn lại: ${newLinks.length}`;
  return summary;
}


module.exports = {
  config: {
    name: "api",
    version: "2.3.0",
    hasPermssion: 2,
    credits: "MiZai",
    description: "Quản lý link media trong listapi (GitHub / link trực tiếp / JSON khác)",
    commandCategory: "Quản Trị",
    usages: [
      ".api add <tên> [reply|<url>|<file.json>]      — Upload/import media lên GitHub",
      ".api check [tên]                               — Kiểm tra & convert file (bỏ trống = tất cả)",
      ".api tt <tên> <từ khóa|@user> [-n <số>]       — Tìm/lấy video TikTok → upload GitHub"
    ].join("\n"),
    cooldowns: 5
  },

  run: async ({ api, event, args, send }) => {
    if (!args[0]) {
      return send(
        "📝 Cách dùng:\n" +
        "  add <tên> [reply|<url>|<file.json>]    — Upload/import media lên GitHub\n" +
        "  check [tên]                             — Kiểm tra & convert (bỏ trống = tất cả)\n" +
        "  tt <tên> <từ khóa|@user> [-n <số>]     — Tìm/lấy video TikTok → upload GitHub"
      );
    }

    const FLAG_MAP = { "-a": "add", "-c": "check", "-t": "tt" };
    const sub = FLAG_MAP[args[0]] || (args[0] || "").toLowerCase();

    // ══════════════════════════════════════════════════════
    //  ADD — 3 chế độ: reply đính kèm / link trực tiếp / import JSON
    // ══════════════════════════════════════════════════════
    if (sub === "add") {
      const tipName = args[1];
      if (!tipName) return send("⚠️ Vui lòng nhập tên tệp.\nVí dụ: .api add hinh");

      const thirdArg = args[2];

      // ── Chế độ 1: Import từ file JSON khác ─────────────────────────────────
      if (thirdArg && thirdArg.endsWith(".json")) {
        const srcPath = path.join(LISTAPI_DIR, thirdArg);
        if (!fs.existsSync(srcPath)) {
          return send(`❌ Không tìm thấy file: listapi/${thirdArg}`);
        }
        let srcLinks = [];
        try { srcLinks = JSON.parse(fs.readFileSync(srcPath, "utf-8")); } catch {
          return send(`❌ Không đọc được file JSON: ${thirdArg}`);
        }
        if (!Array.isArray(srcLinks) || srcLinks.length === 0) {
          return send(`⚠️ File ${thirdArg} trống hoặc không hợp lệ.`);
        }
        const { dataPath, data } = loadJsonList(tipName);
        const before = data.length;
        const merged = [...new Set([...data, ...srcLinks])];
        fs.writeFileSync(dataPath, JSON.stringify(merged, null, 2), "utf-8");
        return send(
          `✅ Đã import từ ${thirdArg} → listapi/${tipName}.json\n` +
          `➕ Thêm mới: ${merged.length - before} link\n` +
          `📦 Tổng: ${merged.length} link`
        );
      }

      // ── Chế độ 2: Nhập URL → tự lấy link video bên trong → upload lên GitHub ─
      if (thirdArg && isValidUrl(thirdArg)) {
        if (!global.config?.githubToken || !global.config?.uploadRepo) {
          return send("❌ Chưa cấu hình githubToken hoặc uploadRepo trong config.json");
        }

        await send(`⏳ Đang phân tích URL...\n🔍 ${thirdArg}`);

        const mediaLinks = await extractMediaLinks(thirdArg);

        await send(`🎬 Tìm thấy ${mediaLinks.length} link media, đang upload lên GitHub...`);

        const { dataPath, data } = loadJsonList(tipName);
        let success = 0, failed = 0;
        const addedUrls = [];
        const failReasons2 = [];
        let uploadIdx2 = 0;

        for (const mUrl of mediaLinks) {
          if (data.includes(mUrl)) continue;
          try {
            const ghUrl = await uploadToGithub(mUrl, `${tipName}_${Date.now()}_${uploadIdx2++}`);
            if (ghUrl && !data.includes(ghUrl)) {
              data.push(ghUrl);
              addedUrls.push(ghUrl);
              success++;
            }
          } catch (e) {
            failed++;
            failReasons2.push(e.message?.slice(0, 60) || "unknown");
            global.logWarn?.(`[api] Upload lỗi: ${e.message} | URL: ${mUrl}`);
          }
        }

        fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), "utf-8");

        let msg = `✅ Đã upload ${success} link vào listapi/${tipName}.json\n📦 Tổng: ${data.length} link`;
        if (failed > 0) msg += `\n⚠️ Upload lỗi: ${failed} (${[...new Set(failReasons2)].join(", ")})`;
        if (addedUrls.length <= 5) msg += "\n\n" + addedUrls.map(u => `🔗 ${u}`).join("\n");
        return send(msg);
      }

      // ── Chế độ 3: Reply tin nhắn có link/file ──────────────────────────────
      const quote = await global.resolveQuote({
        raw: event?.data,
        api: global.api,
        threadId: event?.threadId,
        event
      });

      // Ưu tiên lấy URL từ reply: mediaUrl → link trong text/content
      const replyUrl = quote?.mediaUrl || (() => {
        let txt = "";
        if (typeof quote?.content === "string") txt = quote.content;
        else if (quote?.content && typeof quote.content === "object") {
          txt = quote.content.url || quote.content.href || quote.content.normalUrl ||
                quote.content.fileUrl || quote.content.downloadUrl || "";
          if (!txt) txt = JSON.stringify(quote.content);
        }
        if (!txt && typeof quote?.text === "string") txt = quote.text;
        const m = txt.match(/https?:\/\/[^\s"'<>]+/);
        return m ? m[0].replace(/[.,;)}\]]+$/, "") : null;
      })();

      if (!replyUrl) {
        return send(
          "⚠️ Không tìm thấy nội dung hợp lệ. Hãy:\n" +
          "  • Reply vào tin nhắn có ảnh/video/file/link, hoặc\n" +
          "  • Nhập URL: .api add <tên> <https://...>, hoặc\n" +
          "  • Import JSON: .api add <tên> <file.json>"
        );
      }

      if (!global.config?.githubToken || !global.config?.uploadRepo) {
        return send("❌ Chưa cấu hình githubToken hoặc uploadRepo trong config.json");
      }

      await send(`⏳ Đang phân tích nội dung...\n🔍 ${replyUrl}`);

      // Fetch URL → thử parse JSON array → nếu có link bên trong thì convert từng cái
      const mediaLinks = await extractMediaLinks(replyUrl);

      // Nếu chỉ có 1 link và chính là replyUrl (file media trực tiếp) → upload thẳng
      const isDirectMedia = mediaLinks.length === 1 && mediaLinks[0] === replyUrl;

      if (isDirectMedia) {
        try { await api.addReaction("⏳", { type: event.type, threadId: event.threadId, data: event.data }); } catch (_r) {}
      } else {
        await send(`🎬 Tìm thấy ${mediaLinks.length} link bên trong, đang upload lên GitHub...`);
      }

      const { dataPath, data } = loadJsonList(tipName);
      let success = 0, failed = 0;
      const addedUrls = [];

      const failReasons = [];
      let uploadIdx = 0;
      for (const mUrl of mediaLinks) {
        if (data.includes(mUrl)) continue;
        try {
          const ghUrl = await uploadToGithub(mUrl, `${tipName}_${Date.now()}_${uploadIdx++}`);
          if (ghUrl && !data.includes(ghUrl)) {
            data.push(ghUrl);
            addedUrls.push(ghUrl);
            success++;
          }
        } catch (e) {
          failed++;
          failReasons.push(e.message?.slice(0, 60) || "unknown");
          global.logWarn?.(`[api] Upload lỗi: ${e.message} | URL: ${mUrl}`);
        }
      }

      fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), "utf-8");

      let msg = `✅ Đã upload ${success} link vào listapi/${tipName}.json\n📦 Tổng: ${data.length} link`;
      if (failed > 0) msg += `\n⚠️ Upload lỗi: ${failed} (${[...new Set(failReasons)].join(", ")})`;
      if (addedUrls.length > 0 && addedUrls.length <= 5)
        msg += "\n\n" + addedUrls.map(u => `🔗 ${u}`).join("\n");
      return send(msg);
    }

    // ══════════════════════════════════════════════════════
    //  CHECK — kiểm tra link & convert link không phải GitHub lên GitHub
    //  .api check          → toàn bộ listapi
    //  .api check <tên>    → chỉ file <tên>.json
    // ══════════════════════════════════════════════════════
    if (sub === "check") {
      if (!global.config?.githubToken || !global.config?.uploadRepo) {
        return send("❌ Chưa cấu hình githubToken hoặc uploadRepo trong config.json\n(Cần để convert link lên GitHub)");
      }

      if (!fs.existsSync(LISTAPI_DIR)) {
        return send("📂 Thư mục listapi chưa có dữ liệu.");
      }

      const targetName = args[1]; // tuỳ chọn: check 1 file cụ thể

      let files = [];
      if (targetName) {
        const targetFile = targetName.endsWith(".json") ? targetName : `${targetName}.json`;
        const targetPath = path.join(LISTAPI_DIR, targetFile);
        if (!fs.existsSync(targetPath)) {
          return send(`❌ Không tìm thấy file: listapi/${targetFile}`);
        }
        files = [targetFile];
      } else {
        files = fs.readdirSync(LISTAPI_DIR).filter(f => f.endsWith(".json"));
        if (files.length === 0) return send("📂 Chưa có file nào trong listapi.");
      }

      await send(
        `⏳ Đang kiểm tra & convert ${files.length} file...\n` +
        `(Link chết sẽ bị xoá, link chưa phải GitHub sẽ được upload lên GitHub)`
      );

      const results = [];
      for (const file of files) {
        const filePath = path.join(LISTAPI_DIR, file);
        const result = await checkAndConvertFile(filePath, file, send);
        results.push(result);
      }

      return send(results.join("\n\n"));
    }

    // ══════════════════════════════════════════════════════
    //  TT — Tìm TikTok → Tải video → Upload GitHub → Lưu vào listapi
    //  .api tt <tên> <từ khóa> [-n <số>]
    // ══════════════════════════════════════════════════════
    if (sub === "tt") {
      if (!global.config?.githubToken || !global.config?.uploadRepo) {
        return send("❌ Chưa cấu hình githubToken hoặc uploadRepo trong config.json");
      }

      const tipName = args[1];
      if (!tipName) return send(
        "⚠️ Nhập tên file lưu.\n" +
        "Ví dụ: .api tt gai ten 50    (tìm theo từ khóa, cần tiktokCookie)\n" +
        "       .api tt gai @username  (lấy full video @user, không cần cookie)"
      );

      // Parse số lượng — hỗ trợ cả 2 dạng:
      //   .api tt gai ten -n 50
      //   .api tt gai ten 50      (số ở cuối, không cần -n)
      // limit = 0 → không giới hạn (dùng cho @user khi không có -n)
      let limit = 0;
      let limitSet = false;
      let queryArgs = args.slice(2);

      // Dạng -n <số>
      const nIdx = queryArgs.findIndex(a => a === "-n");
      if (nIdx !== -1 && queryArgs[nIdx + 1]) {
        const parsed = parseInt(queryArgs[nIdx + 1], 10);
        if (!isNaN(parsed) && parsed >= 1) { limit = parsed; limitSet = true; }
        queryArgs.splice(nIdx, 2);
      } else {
        // Dạng số cuối không có -n
        const last = queryArgs[queryArgs.length - 1];
        const parsed = parseInt(last, 10);
        if (!isNaN(parsed) && parsed >= 1 && String(parsed) === last) {
          limit = parsed; limitSet = true;
          queryArgs = queryArgs.slice(0, -1);
        }
      }

      const query = queryArgs.join(" ").trim();
      if (!query) return send(
        "⚠️ Nhập từ khóa hoặc @username.\n" +
        "Ví dụ: .api tt gai ten 50\n" +
        "       .api tt gai @username"
      );

      const isUserMode = query.startsWith("@");

      if (isUserMode) {
        const limitNote = limitSet ? `(tối đa ${limit} video)` : "(toàn bộ)";
        await send(`👤 Đang lấy video TikTok: ${query} ${limitNote}\n⏳ Sẽ tải & upload lần lượt lên GitHub...`);
      } else {
        const safeLimit = limitSet ? limit : 8;
        limit = Math.min(safeLimit, 50);
        await send(`🔍 Đang tìm TikTok: "${query}" (tối đa ${limit} video)...\n⏳ Sẽ tải & upload lần lượt lên GitHub.`);
      }

      let res;
      let lastProgressSent = 0;
      const onProgress = async (i, total, status) => {
        const now = Date.now();
        const step = Math.max(1, Math.ceil(total / 5));
        if (i === 1 || i === total || now - lastProgressSent >= 20000 || i % step === 0) {
          lastProgressSent = now;
          const pct = total > 0 ? Math.round((i / total) * 100) : 0;
          const icon = status === "ok" ? "✅" : status === "fail" ? "❌" : "⏭";
          await send(`${icon} Đang xử lý ${i}/${total} video (${pct}%)...`);
        }
      };
      try {
        res = await global.cawr.tt.bulkAdd(tipName, query, limit, onProgress);
      } catch (err) {
        return send(`❌ Lỗi: ${err?.message || "Không xác định"}`);
      }

      if (res.total === 0) {
        return send(
          isUserMode
            ? `😔 Không tìm thấy video nào từ ${query}`
            : `😔 Không tìm thấy video TikTok cho "${query}"`
        );
      }

      const finalList = global.cawr.tt.loadList(tipName);
      const source = isUserMode ? `@${query.replace(/^@/, "")}` : `"${query}"`;
      let msg  = `🎬 KẾT QUẢ — TikTok (${source}) → listapi/${tipName}.json\n`;
      msg += `━━━━━━━━━━━━━━━━\n`;
      msg += `✅ Upload thành công : ${res.success}\n`;
      msg += `⏭ Bỏ qua (trùng/lịch sử/ảnh): ${res.skipped}\n`;
      msg += `❌ Thất bại           : ${res.failed}\n`;
      msg += `📊 Tổng đã xử lý     : ${res.total}\n`;
      msg += `📦 Tổng trong file    : ${finalList.length}`;
      if (res.failed > 0) msg += `\n⚠️ Lý do lỗi: ${[...new Set(res.failReasons)].join(", ")}`;

      // Upload JSON data lên GitHub để có link xem trực tiếp
      if (res.success > 0 && typeof global.githubUpload === "function") {
        try {
          const jsonLocalPath = path.join(LISTAPI_DIR, `${tipName}.json`);
          const jsonGhUrl = await global.githubUpload(jsonLocalPath, `listapi/${tipName}.json`);
          if (jsonGhUrl) msg += `\n🔗 Data: ${jsonGhUrl}`;
        } catch (_) {}
      }

      return send(msg);
    }

    // ══════════════════════════════════════════════════════
    //  Lệnh con không hợp lệ
    // ══════════════════════════════════════════════════════
    return send("❓ Lệnh con không hợp lệ. Dùng: .api add <tên> | .api check [tên] | .api tt <tên> <từ khóa>");
  }
};
