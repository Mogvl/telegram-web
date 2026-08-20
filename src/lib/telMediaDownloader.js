// ==UserScript==
// @name         Telegram Media Downloader
// @name:en      Telegram Media Downloader
// @name:zh-CN   Telegram 受限图片视频下载器
// @name:zh-TW   Telegram 受限圖片影片下載器
// @name:ru      Telegram: загрузчик медиафайлов
// @version      1.212
// @namespace    https://github.com/Neet-Nestor/Telegram-Media-Downloader
// @description  Download images, GIFs, videos, and voice messages on the Telegram webapp from private channels that disable downloading and restrict saving content
// @description:en  Download images, GIFs, videos, and voice messages on the Telegram webapp from private channels that disable downloading and restrict saving content
// @description:ru Загружайте изображения, GIF-файлы, видео и голосовые сообщения в веб-приложении Telegram из частных каналов, которые отключили загрузку и ограничили сохранение контента
// @description:zh-CN 从禁止下载的Telegram频道中下载图片、视频及语音消息
// @description:zh-TW 從禁止下載的 Telegram 頻道中下載圖片、影片及語音訊息
// @author       Nestor Qin
// @license      GNU GPLv3
// @website      https://github.com/Neet-Nestor/Telegram-Media-Downloader
// @match        https://web.telegram.org/*
// @match        https://webk.telegram.org/*
// @match        https://webz.telegram.org/*
// @icon         https://img.icons8.com/color/452/telegram-app--v5.png
// @downloadURL https://update.greasyfork.org/scripts/446342/Telegram%20Media%20Downloader.user.js
// @updateURL https://update.greasyfork.org/scripts/446342/Telegram%20Media%20Downloader.meta.js
// ==/UserScript==
//
// ============================================================
// MODIFIED for self-hosted Telegram Web (github.com/Mogvl/telegram-web)
// - Bundled into the web app (loaded from index.html), no userscript manager needed
// - Downloads are saved to the NAS: media blobs are POSTed to /dl/upload,
//   proxied by nginx to the telegram-web-dl companion container, which writes
//   them into the mounted NAS volume (see docker-compose.yaml).
// - The File System Access API path was removed; browser-side <a download>
//   is kept only as a fallback for images.
// Original upstream: https://github.com/Neet-Nestor/Telegram-Media-Downloader (GPLv3)
// ============================================================


(function () {
  const logger = {
    info: (message, fileName = null) => {
      console.log(
        `[Tel Download] ${fileName ? `${fileName}: ` : ""}${message}`
      );
    },
    error: (message, fileName = null) => {
      console.error(
        `[Tel Download] ${fileName ? `${fileName}: ` : ""}${message}`
      );
    },
  };
  // Unicode values for icons (used in /k/ app)
  // https://github.com/morethanwords/tweb/blob/master/src/icons.ts
  const DOWNLOAD_ICON = "\ue979";
  const FORWARD_ICON = "\ue99a";
  const contentRangeRegex = /^bytes (\d+)-(\d+)\/(\d+)$/;
  const REFRESH_DELAY = 500;
  const hashCode = (s) => {
    var h = 0,
      l = s.length,
      i = 0;
    if (l > 0) {
      while (i < l) {
        h = ((h << 5) - h + s.charCodeAt(i++)) | 0;
      }
    }
    return h >>> 0;
  };

  const createProgressBar = (videoId, fileName) => {
    const isDarkMode =
      document.querySelector("html").classList.contains("night") ||
      document.querySelector("html").classList.contains("theme-dark");
    const container = document.getElementById(
      "tel-downloader-progress-bar-container"
    );
    const innerContainer = document.createElement("div");
    innerContainer.id = "tel-downloader-progress-" + videoId;
    innerContainer.style.width = "20rem";
    innerContainer.style.marginTop = "0.4rem";
    innerContainer.style.padding = "0.6rem";
    innerContainer.style.backgroundColor = isDarkMode
      ? "rgba(0,0,0,0.3)"
      : "rgba(0,0,0,0.6)";

    const flexContainer = document.createElement("div");
    flexContainer.style.display = "flex";
    flexContainer.style.justifyContent = "space-between";

    const title = document.createElement("p");
    title.className = "filename";
    title.style.margin = 0;
    title.style.color = "white";
    title.innerText = fileName;

    const closeButton = document.createElement("div");
    closeButton.style.cursor = "pointer";
    closeButton.style.fontSize = "1.2rem";
    closeButton.style.color = isDarkMode ? "#8a8a8a" : "white";
    closeButton.innerHTML = "&times;";
    closeButton.onclick = function () {
      container.removeChild(innerContainer);
    };

    const progressBar = document.createElement("div");
    progressBar.className = "progress";
    progressBar.style.backgroundColor = "#e2e2e2";
    progressBar.style.position = "relative";
    progressBar.style.width = "100%";
    progressBar.style.height = "1.6rem";
    progressBar.style.borderRadius = "2rem";
    progressBar.style.overflow = "hidden";

    const counter = document.createElement("p");
    counter.style.position = "absolute";
    counter.style.zIndex = 5;
    counter.style.left = "50%";
    counter.style.top = "50%";
    counter.style.transform = "translate(-50%, -50%)";
    counter.style.margin = 0;
    counter.style.color = "black";
    const progress = document.createElement("div");
    progress.style.position = "absolute";
    progress.style.height = "100%";
    progress.style.width = "0%";
    progress.style.backgroundColor = "#6093B5";

    progressBar.appendChild(counter);
    progressBar.appendChild(progress);
    flexContainer.appendChild(title);
    flexContainer.appendChild(closeButton);
    innerContainer.appendChild(flexContainer);
    innerContainer.appendChild(progressBar);
    container.appendChild(innerContainer);
  };

  const updateProgress = (videoId, fileName, progress) => {
    const innerContainer = document.getElementById(
      "tel-downloader-progress-" + videoId
    );
    if (!innerContainer) return; // closed by the user mid-download
    innerContainer.querySelector("p.filename").innerText = fileName;
    const progressBar = innerContainer.querySelector("div.progress");
    progressBar.querySelector("p").innerText = progress + "%";
    progressBar.querySelector("div").style.width = progress + "%";
  };

  const completeProgress = (videoId) => {
    const progressBarContainer = document.getElementById(
      "tel-downloader-progress-" + videoId
    );
    if (!progressBarContainer) return; // closed by the user mid-download
    const progressBar = progressBarContainer.querySelector("div.progress");
    progressBar.querySelector("p").innerText = "Completed";
    progressBar.querySelector("div").style.backgroundColor = "#B6C649";
    progressBar.querySelector("div").style.width = "100%";
  };

  const AbortProgress = (videoId) => {
    const progressBarContainer = document.getElementById(
      "tel-downloader-progress-" + videoId
    );
    if (!progressBarContainer) return; // closed by the user mid-download
    const progressBar = progressBarContainer.querySelector("div.progress");
    progressBar.querySelector("p").innerText = "Aborted";
    progressBar.querySelector("div").style.backgroundColor = "#D16666";
    progressBar.querySelector("div").style.width = "100%";
  };

  const nasErrorHint = (status) => {
    if (status === 404) {
      return "NAS download channel missing: update the image (ghcr.io/mogvl/telegram-web:latest) and deploy the compose file with BOTH services (telegram-web + telegram-web-dl)";
    }
    if (status === 502) {
      return "NAS download service is down: make sure the telegram-web-dl container is running";
    }
    return "NAS download failed (" + status + ") - check the deployment";
  };


  const showNasToast = (message) => {
    const container = document.getElementById("tel-downloader-progress-bar-container");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = "tel-dl-toast";
    toast.style.cssText =
      "background:#B6C649;color:#fff;font-size:.85rem;padding:.6rem 1.1rem;" +
      "margin-bottom:.4rem;box-shadow:0 4px 14px rgba(15,30,50,.25);display:flex;gap:.5rem;align-items:center;";
    toast.innerHTML =
      '<span style="font-weight:700;">&#10003; ' +
      message +
      '</span><span style="opacity:.85;font-size:.75rem;">(点此打开下载中心)</span>';
    toast.onclick = () => {
      const btn = document.getElementById("tel-dl-manager-toggle");
      if (btn) btn.click();
    };
    container.prepend(toast);
    setTimeout(() => toast.remove(), 6000);
  };

  /* Detect a missing Service Worker: tweb's SW handles media streams
   * (MP4 moov repair, chunk caching, preload) — without it video playback
   * fails with demux errors in many environments. The usual cause is a
   * reverse proxy redirecting sw-*.js. Show a one-time dismissible banner. */
  const checkServiceWorker = () => {
    try {
      if (!('serviceWorker' in navigator)) return;
      setTimeout(() => {
        navigator.serviceWorker.getRegistration().then((reg) => {
          if (reg) return; // SW active — playback pipeline is fine
          const banner = document.createElement("div");
          banner.style.cssText =
            "position:fixed;top:.8rem;right:.8rem;left:.8rem;z-index:9999;margin:0 auto;max-width:420px;" +
            "background:#D16666;color:#fff;border-radius:14px;padding:.7rem 1rem;font-size:.8rem;" +
            "box-shadow:0 8px 24px rgba(15,30,50,.3);display:flex;gap:.6rem;align-items:center;";
          banner.innerHTML =
            '<span style="font-weight:700;">\u26A0 Service Worker 未注册</span>' +
            '<span style="flex:1;opacity:.95;">视频在线播放可能失败（媒体流修复依赖 SW）。' +
            '通常是反向代理把 sw-*.js 重定向导致——请在绿联反代中放行本站全部路径。</span>' +
            '<button id="tel-sw-banner-close" style="border:0;background:rgba(255,255,255,.25);color:#fff;' +
            'border-radius:999px;width:1.4rem;height:1.4rem;cursor:pointer;font-size:.8rem;flex:none;">\u2715</button>';
          const close = banner.querySelector("#tel-sw-banner-close");
          close.onclick = () => banner.remove();
          document.body.appendChild(banner);
          setTimeout(() => banner.remove(), 20000);
        }).catch(() => {});
      }, 6000);
    } catch (e) {
      /* ignore */
    }
  };

  /* ============ NAS download manager ============ */
  const managerState = {
    open: false,
    timer: null,
    listEl: null,
    page: 1,
    pageSize: 20,
    sort: "time",
    query: "",
    filter: "all",
    dark: false,
    total: 0,
    selected: new Set(),
    pageInfoEl: null,
    pagerEl: null,
    selectAllEl: null,
    statsEl: null,
    delSelectedEl: null,
  };

  const formatSize = (bytes) => {
    if (bytes === undefined || bytes === null) return "";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return v.toFixed(i === 0 ? 0 : 1) + " " + units[i];
  };

  const formatTime = (iso) => {
    try {
      return new Date(iso).toLocaleString();
    } catch (e) {
      return "";
    }
  };

  const makeCheckSpan = () => {
    const c = document.createElement("span");
    c.className = "tel-dl-check";
    c.style.cssText =
      "flex:none;width:1.05rem;height:1.05rem;border:1.5px solid #6093B5;" +
      "display:inline-flex;align-items:center;justify-content:center;" +
      "font-size:.65rem;color:#fff;background:#fff;";
    c.setChecked = (on) => {
      c.dataset.on = on ? "1" : "0";
      c.style.background = on ? "#6093B5" : "#fff";
      c.textContent = on ? "\u2713" : "";
    };
    return c;
  };

  const typeIcon = (name) => {
    const lower = name.toLowerCase();
    if (/.(png|jpe?g|gif|webp|bmp|svg|heic)$/.test(lower)) return "\u{1F5BC}\uFE0F";
    if (/.(mp4|mov|mkv|avi|webm|m4v|ts)$/.test(lower)) return "\u{1F3AC}";
    if (/.(mp3|ogg|opus|m4a|wav|flac|amr)$/.test(lower)) return "\u{1F3B5}";
    if (/.(zip|rar|7z|tar|gz)$/.test(lower)) return "\u{1F4E6}";
    return "\u{1F4C4}";
  };

  const safeName = (name) => name.replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const updateSelectAllState = () => {
    const sa = managerState.selectAllEl;
    if (!sa) return;
    const rows = managerState.listEl
      ? managerState.listEl.querySelectorAll('span[data-name]')
      : [];
    const allOn = rows.length > 0 && [...rows].every((r) => r.dataset.on === "1");
    sa.dataset.on = allOn ? "1" : "0";
    sa.style.background = allOn ? "#6093B5" : "#fff";
    sa.textContent = allOn ? "\u2713" : "";
  };

  const updateSelectedUi = () => {
    if (!managerState.delSelectedEl) return;
    managerState.delSelectedEl.disabled = managerState.selected.size === 0;
    managerState.delSelectedEl.innerHTML =
      "\u2715 删除选中(" + managerState.selected.size + ")";
  };

  const refreshManagerList = async () => {
    if (!managerState.open) return;
    const listEl = managerState.listEl;
    if (!listEl) return;

    let files = [];
    let total = 0;
    let totalSize = 0;
    let active = [];
    const errFetch = (el, msg) => {
      el.innerHTML =
        '<div style="padding:.6rem;color:#D16666;">' + msg + "</div>";
    };

    try {
      const qs =
        "page=" + managerState.page +
        "&pageSize=" + managerState.pageSize +
        "&sort=" + managerState.sort +
        "&filter=" + managerState.filter +
        (managerState.query ? "&q=" + encodeURIComponent(managerState.query) : "");
      const filesRes = await fetch("/dl/files?" + qs);
      if (!filesRes.ok) throw new Error(filesRes.status);
      const filesJson = await filesRes.json();
      files = filesJson.files || [];
      total = filesJson.total || 0;
      totalSize = filesJson.totalSize || 0;

      const statusRes = await fetch("/dl/status");
      if (statusRes.ok) {
        active = (await statusRes.json()).active || [];
      }
    } catch (e) {
      errFetch(listEl, "下载中心暂时不可用（/dl/ 通道未部署）");
      managerState.pageInfoEl && (managerState.pageInfoEl.innerText = "");
      managerState.pagerEl && (managerState.pagerEl.innerText = "");
      managerState.statsEl && (managerState.statsEl.innerText = "");
      return;
    }

    managerState.total = total;
    const activeMap = new Map(active.map((a) => [a.name, a]));
    const pages = Math.max(1, Math.ceil(total / managerState.pageSize));
    // after deletes the current page can exceed the new page count — clamp
    // so the user is not stranded on an empty page ("第 3/1 页")
    if (managerState.page > pages) {
      managerState.page = pages;
    }

    // stats line
    if (managerState.statsEl) {
      managerState.statsEl.innerText =
        "共 " + total + " 个文件" + (totalSize ? " · " + formatSize(totalSize) : "");
    }
    const clearDoneEl = document.getElementById("tel-dl-clear-done");
    if (clearDoneEl) {
      clearDoneEl.disabled = managerState.filter !== "done" || total === 0;
      clearDoneEl.style.opacity = clearDoneEl.disabled ? ".4" : "1";
    }

    const dark = managerState.dark;
    const cs = {
      border: dark ? "rgba(255,255,255,.08)" : "rgba(0,0,0,.08)",
      meta: dark ? "#9a9a9a" : "#8a8a8a",
      empty: dark ? "#8a8a8a" : "#8a8a8a",
      checkBorder: dark ? "#7fb3d5" : "#6093B5",
    };

    const renderRow = (file) => {
      const row = document.createElement("div");
      row.className = "tel-dl-row";
      row.style.cssText =
        "display:flex;align-items:center;gap:.4rem;padding:.45rem .6rem;margin:.1rem .4rem;";

      const icon = document.createElement("span");
      icon.style.cssText = "flex:none;font-size:1rem;";
      icon.innerText = typeIcon(file.name);
      row.appendChild(icon);

      const cb = makeCheckSpan();
      cb.style.borderColor = cs.checkBorder;
      cb.dataset.name = file.name;
      cb.setChecked(managerState.selected.has(file.name));
      cb.onclick = () => {
        const on = cb.dataset.on !== "1";
        cb.setChecked(on);
        if (on) managerState.selected.add(file.name);
        else managerState.selected.delete(file.name);
        updateSelectAllState();
        updateSelectedUi();
      };
      row.appendChild(cb);

      const info = document.createElement("div");
      info.style.cssText = "flex:1;min-width:0;";
      const name = document.createElement("div");
      name.style.cssText =
        "font-size:.8rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;";
      name.title = file.name + "（点击打开/预览）";
      name.innerHTML = safeName(file.name);
      name.onclick = () => {
        window.open("/dl/files/" + encodeURIComponent(file.name), "_blank");
      };
      const meta = document.createElement("div");
      meta.style.cssText = "font-size:.7rem;color:" + cs.meta + ";";

      const act = activeMap.get(file.name);
      if (act) {
        // streaming uploads carry X-Parts: 1 and X-Size (expected size), so
        // the old received/parts ratio was always ~100% after the 2nd part;
        // prefer bytes/expectedBytes when the sink reports a target size.
        let pct = null;
        if (act.expectedBytes > 0 && act.bytes > 0) {
          pct = Math.min(100, Math.round((act.bytes / act.expectedBytes) * 100));
        } else if (act.parts > 1) {
          pct = Math.round(((act.received - 1) / act.parts) * 100);
        }
        meta.innerText =
          "下载中 " +
          (pct !== null
            ? pct + "%（" + formatSize(act.bytes) + "）"
            : formatSize(act.bytes));
        if (pct !== null) {
          const bar = document.createElement("div");
          bar.style.cssText =
            "height:.3rem;background:#e2e2e2;border-radius:2rem;margin-top:.25rem;overflow:hidden;";
          const fill = document.createElement("div");
          fill.style.cssText =
            "height:100%;width:" + pct + "%;background:#6093B5;transition:width .5s;";
          bar.appendChild(fill);
          info.appendChild(bar);
        }
      } else if (file.status === "active") {
        meta.innerText = "下载中（残留任务，可删除）";
      } else {
        meta.innerText = formatSize(file.size) + " · " + formatTime(file.mtime);
      }
      info.appendChild(name);
      info.appendChild(meta);
      row.appendChild(info);

      const del = document.createElement("button");
      del.innerText = "\u2715";
      del.title = "删除（同时删除 NAS 上的文件）";
      del.style.cssText =
        "border:none;background:#D16666;color:#fff;border-radius:50%;width:1.5rem;height:1.5rem;" +
        "cursor:pointer;font-size:.8rem;flex:none;";
      del.onclick = async () => {
        const ok = window.confirm(
          "确定删除 " + file.name + " [" + formatSize(file.size) + "] ？\n\nNAS 上的文件也会被删除。"
        );
        if (!ok) return;
        try {
          const res = await fetch(
            "/dl/files/" + encodeURIComponent(file.name),
            {method: "DELETE"}
          );
          if (!res.ok) throw new Error(res.status);
          managerState.selected.delete(file.name);
          updateSelectedUi();
          refreshManagerList();
        } catch (e) {
          del.style.background = "#8a8a8a";
        }
      };
      row.appendChild(del);
      return row;
    };

    listEl.replaceChildren();
    if (files.length) {
      for (const f of files) {
        listEl.appendChild(renderRow(f));
      }
    } else {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:.8rem;color:" + cs.empty + ";text-align:center;font-size:.8rem;";
      empty.innerText = managerState.query
        ? "没有匹配「" + managerState.query + "」的文件"
        : "暂无下载（文件会出现在这里）";
      listEl.appendChild(empty);
    }

    // pager
    if (managerState.pagerEl) {
      managerState.pagerEl.innerText = "";
      const prev = document.createElement("button");
      prev.innerText = "\u2039 上一页";
      prev.disabled = managerState.page <= 1;
      prev.onclick = () => {
        managerState.page--;
        managerState.selected.clear();
        updateSelectedUi();
        refreshManagerList();
      };
      const info = document.createElement("span");
      info.style.cssText = "margin:0 .4rem;font-size:.75rem;color:#8a8a8a;";
      info.innerText = "第 " + managerState.page + "/" + pages + " 页";
      const next = document.createElement("button");
      next.innerText = "下一页 \u203a";
      next.disabled = managerState.page >= pages;
      next.onclick = () => {
        managerState.page++;
        managerState.selected.clear();
        updateSelectedUi();
        refreshManagerList();
      };
      prev.className = "tel-dl-btn";
      next.className = "tel-dl-btn";
      const bstyle = "background:#6093B5;color:#fff;padding:.3rem .7rem;font-size:.75rem;";
      prev.style.cssText = bstyle + (prev.disabled ? "opacity:.4;cursor:default;" : "");
      next.style.cssText = bstyle + (next.disabled ? "opacity:.4;cursor:default;" : "");
      managerState.pagerEl.appendChild(prev);
      managerState.pagerEl.appendChild(info);
      managerState.pagerEl.appendChild(next);
    }
  };


  function injectStyles() {
    if (document.getElementById("tel-dl-styles")) return;
    const style = document.createElement("style");
    style.id = "tel-dl-styles";
    style.textContent = `
      .tel-dl-fab{position:fixed;z-index:1600;border:0;border-radius:999px;font-weight:700;letter-spacing:.2px;
        cursor:pointer;transition:transform .15s,box-shadow .15s,filter .15s;font-family:inherit;
        box-shadow:0 6px 18px rgba(15,30,50,.28)}
      .tel-dl-fab:hover{transform:translateY(-1px);filter:brightness(1.08)}
      .tel-dl-fab:active{transform:translateY(0) scale(.96)}
      .tel-dl-panel{overflow:hidden;border-radius:18px;
        box-shadow:0 16px 44px rgba(15,30,50,.32),0 3px 12px rgba(15,30,50,.10);
        border:1px solid rgba(120,160,190,.20);animation:telDlIn .18s ease-out}
      @keyframes telDlIn{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
      .tel-dl-panel .tel-dl-header{background:linear-gradient(135deg,#74b6d8,#4b8fb8 55%,#4382a8);position:relative}
      .tel-dl-panel .tel-dl-header::after{content:"";position:absolute;inset:0;pointer-events:none;
        background:linear-gradient(180deg,rgba(255,255,255,.16),rgba(255,255,255,0))}
      .tel-dl-btn{border:0;border-radius:14px;font-weight:600;cursor:pointer;font-family:inherit;
        transition:filter .15s,transform .06s,opacity .15s}
      .tel-dl-btn:hover{filter:brightness(1.1)}
      .tel-dl-btn:active{transform:scale(.96)}
      .tel-dl-btn:disabled{opacity:.4;cursor:default;filter:none}
      .tel-dl-row{transition:background .15s;border-radius:12px}
      .tel-dl-row:hover{background:rgba(96,147,181,.12)}
      .tel-dl-check{border-radius:7px;line-height:1;user-select:none;cursor:pointer;
        transition:background .15s,border-color .15s,box-shadow .15s}
      .tel-dl-check:hover{border-color:#7fb3d5;box-shadow:0 0 0 2px rgba(96,147,181,.18)}
      .tel-dl-scroll::-webkit-scrollbar{width:6px;height:6px}
      .tel-dl-scroll::-webkit-scrollbar-thumb{background:rgba(128,143,160,.35);border-radius:3px}
      .tel-dl-scroll::-webkit-scrollbar-track{background:transparent}
      .tel-dl-input{border-radius:999px;outline:none;transition:border-color .15s,box-shadow .15s;font-family:inherit}
      .tel-dl-input:focus{border-color:#6093B5;box-shadow:0 0 0 2px rgba(96,147,181,.18)}
      .tel-dl-chip{border:0;border-radius:999px;cursor:pointer;font-family:inherit;
        transition:background .15s,color .15s}
      .tel-dl-toast{border-radius:999px;font-weight:600;animation:telDlToast .25s ease-out;cursor:pointer}
      @keyframes telDlToast{from{opacity:0;transform:translateX(26px)}to{opacity:1;transform:none}}
      .tel-dl-panel.tel-dl-dark .tel-dl-card{background:#242830;border-color:rgba(255,255,255,.08)}
      .tel-dl-panel.tel-dl-dark .tel-dl-row:hover{background:rgba(96,147,181,.16)}
      .tel-dl-panel.tel-dl-light .tel-dl-card{background:#f4f7fa;border-color:rgba(20,40,60,.07)}
    `;
    document.head.appendChild(style);
  }

  injectStyles();

  const isNarrowScreen = () => window.innerWidth < 640;

  const fabPosition = (base) => {
    // on narrow screens move the FABs up and enlarge them so the chat
    // input bar never covers them; keep them above everything else
    return (
      "right:0.9rem;bottom:" +
      (isNarrowScreen() ? base + 1.5 : base) +
      "rem;padding:" +
      (isNarrowScreen() ? "0.7rem 1.15rem" : "0.55rem 1rem") +
      ";font-size:" +
      (isNarrowScreen() ? "0.9rem" : "0.8rem") +
      ";z-index:9999;"
    );
  };

  const setupDownloadManager = () => {
    const container = document.getElementById("tel-downloader-progress-bar-container");
    if (!container) return;
    if (document.getElementById("tel-dl-manager-toggle")) return;

    managerState.dark = !!(document.querySelector("html").classList.contains("night") ||
      document.querySelector("html").classList.contains("theme-dark"));

    managerState.dark;
    const isDark = managerState.dark;
    const ui = {
      panelBg: isDark ? "#1e1e1e" : "#fff",
      panelText: isDark ? "#eee" : "#222",
      cardBg: isDark ? "#262626" : "#f7f8f9",
      cardBorder: isDark ? "rgba(255,255,255,.08)" : "rgba(0,0,0,.06)",
      inputBg: isDark ? "#2c2c2c" : "#fff",
      inputBorder: isDark ? "#444" : "#ddd",
      inputText: isDark ? "#eee" : "#222",
      delBg: "#D16666",
    };

    const toggle = document.createElement("button");
    toggle.id = "tel-dl-manager-toggle";
    toggle.innerText = "NAS 下载中心";
    toggle.className = "tel-dl-fab";
    toggle.style.cssText =
      fabPosition(5.5) + "background:#6093B5;color:#fff;";
    toggle.onclick = () => {
      managerState.open = !managerState.open;
      const panel = document.getElementById("tel-dl-manager-panel");
      panel.style.display = managerState.open ? "block" : "none";
      toggle.style.background = managerState.open ? "#B6C649" : "#6093B5";
      if (managerState.open) {
        refreshManagerList();
        managerState.timer = setInterval(refreshManagerList, 3000);
      } else {
        clearInterval(managerState.timer);
      }
    };
    document.body.appendChild(toggle);

    const panel = document.createElement("div");
    panel.id = "tel-dl-manager-panel";
    panel.className = "tel-dl-panel " + (isDark ? "tel-dl-dark" : "tel-dl-light");
    panel.style.cssText =
      "position:fixed;right:0.9rem;bottom:" + (isNarrowScreen() ? "10.5rem" : "8.2rem") +
      ";z-index:9999;width:340px;max-width:92vw;max-height:60vh;" +
      "background:" + ui.panelBg + ";color:" + ui.panelText + ";" +
      "display:none;flex-direction:column;";
    panel.innerHTML =
      '<div class="tel-dl-header" style="display:flex;align-items:center;justify-content:space-between;' +
      'padding:.7rem .9rem;color:#fff;">' +
      "<span style='font-weight:700;font-size:.85rem;'>NAS 下载中心</span>" +
      "<span style='display:flex;gap:.4rem;'>" +
      "<button id='tel-dl-refresh' title='刷新' style='border:none;background:none;color:#fff;cursor:pointer;font-size:1rem;'>&#8635;</button>" +
      "<button id='tel-dl-close' title='关闭' style='border:none;background:none;color:#fff;cursor:pointer;font-size:1rem;'>&#10005;</button>" +
      "</span></div>" +
      '<div class="tel-dl-card" style="padding:.45rem .8rem;border-bottom:1px solid ' + ui.cardBorder + ';display:flex;gap:.4rem;align-items:center;background:' + (isDark ? '#242830' : '#f4f7fa') + ';">' +
      '<input id="tel-dl-search" placeholder="搜索文件名" class="tel-dl-input" style="flex:1;min-width:0;border:1px solid ' + ui.inputBorder + ';background:' + ui.inputBg + ';color:' + ui.inputText + ';padding:.35rem .7rem;font-size:.75rem;">' +
      '<select id="tel-dl-filter" title="状态" class="tel-dl-input" style="border:1px solid ' + ui.inputBorder + ';background:' + ui.inputBg + ';color:' + ui.inputText + ';padding:.3rem .4rem;font-size:.75rem;">' +
      "<option value='all'>全部</option><option value='done'>已完成</option><option value='active'>下载中</option>" +
      "</select>" +
      '<select id="tel-dl-sort" title="排序" class="tel-dl-input" style="border:1px solid ' + ui.inputBorder + ';background:' + ui.inputBg + ';color:' + ui.inputText + ';padding:.3rem .4rem;font-size:.75rem;">' +
      "<option value='time'>时间</option><option value='name'>名称</option><option value='size'>大小</option>" +
      "</select></div>" +
      '<div class="tel-dl-card" style="padding:.3rem .8rem;display:flex;align-items:center;gap:.5rem;border-bottom:1px solid ' + ui.cardBorder + ';background:' + (isDark ? '#242830' : '#f4f7fa') + ';">' +
      '<span id="tel-dl-stats" style="flex:1 1 0;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:.7rem;color:#8a8a8a;pointer-events:none;"></span>' +
      '<span id="tel-dl-select-all" title="全选本页" style="width:1rem;height:1rem;border:1.5px solid #6093B5;border-radius:.25rem;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:.7rem;color:#fff;user-select:none;background:#fff;line-height:1;"></span>' +
      '<button id="tel-dl-del-selected" class="tel-dl-btn" style="background:#D16666;color:#fff;padding:.3rem .7rem;font-size:.7rem;" disabled>' +
      "删除选中</button>" +
      '<button id="tel-dl-clear-done" title="一键删除所有已完成的文件" class="tel-dl-btn" style="background:#8a8a8a;color:#fff;padding:.3rem .7rem;font-size:.7rem;" disabled>' +
      "清空已完成</button></div>";
    const listWrap = document.createElement("div");
    listWrap.className = "tel-dl-scroll";
    listWrap.style.cssText = "overflow-y:auto;flex:1;";
    managerState.listEl = document.createElement("div");
    listWrap.appendChild(managerState.listEl);
    panel.appendChild(listWrap);

    managerState.pageInfoEl = document.createElement("div");
    managerState.pagerEl = document.createElement("div");
    managerState.pagerEl.style.cssText =
      "display:flex;align-items:center;justify-content:center;padding:.45rem;" +
      "border-top:1px solid rgba(0,0,0,.06);background:#fbfcfd;";
    panel.appendChild(managerState.pagerEl);
    document.body.appendChild(panel);

    managerState.statsEl = document.getElementById("tel-dl-stats");
    managerState.selectAllEl = document.getElementById("tel-dl-select-all");
    managerState.delSelectedEl = document.getElementById("tel-dl-del-selected");
    updateSelectedUi();

    const clearDoneEl = document.getElementById("tel-dl-clear-done");
    clearDoneEl.onclick = async () => {
      const count = managerState.total;
      if (!count) return;
      const ok = window.confirm("确定删除所有已完成的文件（共 " + count + " 个）？\n\nNAS 上的文件也会被删除。");
      if (!ok) return;
      try {
        const res = await fetch("/dl/batch-delete", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({filter: "done"}),
        });
        if (!res.ok) throw new Error(res.status);
        managerState.selected.clear();
        updateSelectedUi();
        refreshManagerList();
      } catch (e) {
        clearDoneEl.style.background = "#D16666";
      }
    };

    const filterSelect = document.getElementById("tel-dl-filter");
    filterSelect.onchange = (e) => {
      managerState.filter = (e && e.target && e.target.value) || managerState.filter;
      managerState.page = 1;
      managerState.selected.clear();
      updateSelectedUi();
      refreshManagerList();
    };
    // initialize clear-done state without re-fetching the list
    managerState.filter = filterSelect.value || "all";

    document.getElementById("tel-dl-refresh").onclick = refreshManagerList;
    document.getElementById("tel-dl-close").onclick = () => toggle.click();

    const searchInput = document.getElementById("tel-dl-search");
    let searchTimer = null;
    searchInput.oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        managerState.query = searchInput.value.trim();
        managerState.page = 1;
        managerState.selected.clear();
        updateSelectedUi();
        refreshManagerList();
      }, 300);
    };
    searchInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        managerState.query = searchInput.value.trim();
        managerState.page = 1;
        refreshManagerList();
      }
    };

    document.getElementById("tel-dl-sort").onchange = (e) => {
      managerState.sort = e.target.value;
      managerState.page = 1;
      refreshManagerList();
    };

    managerState.selectAllEl.onclick = () => {
      const rows = managerState.listEl.querySelectorAll('span[data-name]');
      const allOn = rows.length > 0 && [...rows].every((r) => r.dataset.on === "1");
      for (const row of rows) {
        const name = row.dataset.name;
        if (!name) continue;
        if (allOn) {
          row.setChecked(false);
          managerState.selected.delete(name);
        } else {
          row.setChecked(true);
          managerState.selected.add(name);
        }
      }
      updateSelectAllState();
      updateSelectedUi();
    };

    managerState.delSelectedEl.onclick = async () => {
      const names = [...managerState.selected];
      if (!names.length) return;
      const ok = window.confirm(
        "确定删除选中的 " + names.length + " 个文件？\n\nNAS 上的文件也会被删除。"
      );
      if (!ok) return;
      try {
        const res = await fetch("/dl/batch-delete", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({names}),
        });
        if (!res.ok) throw new Error(res.status);
        managerState.selected.clear();
        updateSelectedUi();
        refreshManagerList();
      } catch (e) {
        managerState.delSelectedEl.style.background = "#8a8a8a";
      }
    };
  };

const getVideoUrl = (video) =>
    video?.src ||
    video?.currentSrc ||
    video?.querySelector("source")?.src ||
    video?.getAttribute("src") ||
    "";

  const waitForVideoSource = (video, timeoutMs) => {
    return new Promise((resolve) => {
      const url = getVideoUrl(video);
      if (url) return resolve(url);
      const start = Date.now();
      const iv = setInterval(() => {
        const u = getVideoUrl(video);
        if (u || Date.now() - start > (timeoutMs || 15000)) {
          clearInterval(iv);
          resolve(u);
        }
      }, 800);
    });
  };

  const showWaitingToast = () => {
    const container = document.getElementById("tel-downloader-progress-bar-container");
    if (!container) return null;
    const toast = document.createElement("div");
    toast.className = "tel-dl-toast";
    toast.style.cssText =
      "background:#6093B5;color:#fff;font-size:.8rem;padding:.55rem 1rem;" +
      "margin-bottom:.4rem;display:flex;gap:.4rem;align-items:center;box-shadow:0 4px 14px rgba(15,30,50,.25);";
    toast.innerText = "\u23F3 正在等待视频加载…";
    container.prepend(toast);
    const t = setTimeout(() => toast.remove(), 18000);
    const close = () => {
      clearTimeout(t);
      toast.remove();
    };
    toast.onclick = close;
    return close;
  };

  // Guard against double-clicking the same media: two concurrent chains for
  // one URL would interleave parts into the same NAS session and corrupt the
  // final file.
  const inFlightDownloads = new Set();

  const tel_download_video = (url) => {
    if (!url) {
      logger.error(
        "Video source is empty — open the video (let it start loading) and try again",
        "download"
      );
      return;
    }
    if (inFlightDownloads.has(url)) {
      logger.error("This media is already being downloaded", "download");
      return;
    }
    inFlightDownloads.add(url);
    const done = () => inFlightDownloads.delete(url);

    let _next_offset = 0;
    let _total_size = null;
    let _file_extension = "mp4";
    let _part_index = 0;

    const videoId =
      (Math.random() + 1).toString(36).substring(2, 10) +
      "_" +
      Date.now().toString();
    let fileName = hashCode(url).toString(36) + "." + _file_extension;

    // Some video src is in format:
    // 'stream/{"dcId":5,"location":{...},"size":...,"mimeType":"video/mp4","fileName":"xxxx.MP4"}'
    try {
      const metadata = JSON.parse(
        decodeURIComponent(url.split("/")[url.split("/").length - 1])
      );
      if (metadata.fileName) {
        fileName = metadata.fileName;
      }
    } catch (e) {
      // Invalid JSON string, pass extracting fileName
    }
    logger.info(`URL: ${url}`, fileName);

    const fetchNextPart = () => {
      fetch(url, {
        method: "GET",
        headers: {
          Range: `bytes=${_next_offset}-`,
        },
      })
        .then((res) => {
          if (![200, 206].includes(res.status)) {
            throw new Error("Non 200/206 response was received: " + res.status);
          }
          const mime = (res.headers.get("Content-Type") || "").split(";")[0];
          if (!mime.startsWith("video/")) {
            throw new Error(
              "Get non video response with MIME type " +
                mime +
                " (empty source or unavailable media; let the video play first)"
            );
          }
          _file_extension = mime.split("/")[1];
          fileName =
            fileName.substring(0, fileName.indexOf(".") + 1) + _file_extension;

          const contentRange = res.headers.get("Content-Range");
          if (!contentRange) {
            // server ignored Range (e.g. a proxy): fetch the whole file as
            // a single part instead of failing on a null Content-Range
            return res.blob().then((fullBlob) =>
              postPartToNas(fileName, fullBlob, true, _part_index, null).then(
                () => ({
                  whole: true,
                })
              )
            );
          }
          const match = contentRange.match(contentRangeRegex);
          if (!match) {
            throw new Error("Bad Content-Range header: " + contentRange);
          }

          const startOffset = parseInt(match[1]);
          const endOffset = parseInt(match[2]);
          const totalSize = parseInt(match[3]);

          if (startOffset !== _next_offset) {
            logger.error("Gap detected between responses.", fileName);
            logger.info("Last offset: " + _next_offset, fileName);
            logger.info("New start offset " + match[1], fileName);
            throw new Error("Gap detected between responses.");
          }
          if (_total_size && totalSize !== _total_size) {
            logger.error("Total size differs", fileName);
            throw new Error("Total size differs");
          }

          _next_offset = endOffset + 1;
          _total_size = totalSize;

          logger.info(
            `Get response: ${res.headers.get(
              "Content-Length"
            )} bytes data from ${res.headers.get("Content-Range")}`,
            fileName
          );
          logger.info(
            `Progress: ${((_next_offset * 100) / _total_size).toFixed(0)}%`,
            fileName
          );
          updateProgress(
            videoId,
            fileName,
            ((_next_offset * 100) / _total_size).toFixed(0)
          );
          return res.blob().then((b) => ({whole: false, blob: b}));
        })
        .then((part) => {
          if (part.whole) {
            logger.info("Download finished", fileName);
            completeProgress(videoId);
            done();
            return;
          }
          // stream: upload this part right away (X-Last marks the final one)
          const isLast = _next_offset >= _total_size;
          return postPartToNas(fileName, part.blob, isLast, _part_index++, _total_size).then(
            () => {
              if (isLast) {
                logger.info("Download finished", fileName);
                completeProgress(videoId);
                done();
              } else {
                fetchNextPart();
              }
            }
          );
        })
        .catch((reason) => {
          done();
          if (reason instanceof TypeError) {
            logger.error(
              "Video source unavailable (blob was released or network failed) - reopen the media viewer and try again",
              fileName
            );
          } else {
            logger.error(reason, fileName);
          }
          AbortProgress(videoId);
        });
    };

    fetchNextPart();
    createProgressBar(videoId);
  };

  const tel_download_audio = (url) => {
    if (inFlightDownloads.has(url)) {
      logger.error("This media is already being downloaded", "download");
      return;
    }
    inFlightDownloads.add(url);
    const done = () => inFlightDownloads.delete(url);

    // stream: upload each Range part right away, like the video path — the
    // old code buffered every blob in memory and only uploaded at the end
    let _next_offset = 0;
    let _total_size = null;
    let _part_index = 0;
    const fileName = hashCode(url).toString(36) + ".ogg";

    const fetchNextPart = () => {
      fetch(url, {
        method: "GET",
        headers: {
          Range: `bytes=${_next_offset}-`,
        },
      })
        .then((res) => {
          if (res.status !== 206 && res.status !== 200) {
            throw new Error("Non 200/206 response was received: " + res.status);
          }

          const mime = (res.headers.get("Content-Type") || "").split(";")[0];
          if (!mime.startsWith("audio/")) {
            throw new Error("Get non audio response with MIME type " + mime);
          }

          const contentRange = res.headers.get("Content-Range");
          if (!contentRange) {
            // server ignored Range (e.g. a proxy): whole file as one part
            return res.blob().then((fullBlob) =>
              postPartToNas(fileName, fullBlob, true, _part_index, null).then(
                () => ({whole: true})
              )
            );
          }
          const match = contentRange.match(contentRangeRegex);
          if (!match) {
            throw new Error("Bad Content-Range header: " + contentRange);
          }

          const startOffset = parseInt(match[1]);
          const endOffset = parseInt(match[2]);
          const totalSize = parseInt(match[3]);

          if (startOffset !== _next_offset) {
            logger.error("Gap detected between responses.", fileName);
            logger.info("Last offset: " + _next_offset, fileName);
            logger.info("New start offset " + match[1], fileName);
            throw new Error("Gap detected between responses.");
          }
          if (_total_size && totalSize !== _total_size) {
            logger.error("Total size differs", fileName);
            throw new Error("Total size differs");
          }

          _next_offset = endOffset + 1;
          _total_size = totalSize;

          logger.info(
            `Get response: ${res.headers.get(
              "Content-Length"
            )} bytes data from ${res.headers.get("Content-Range")}`,
            fileName
          );
          return res.blob().then((b) => ({whole: false, blob: b}));
        })
        .then((part) => {
          if (part.whole) {
            logger.info("Download finished", fileName);
            showNasToast(fileName + " 已保存到 NAS");
            done();
            return;
          }
          const isLast = _next_offset >= _total_size;
          return postPartToNas(fileName, part.blob, isLast, _part_index++, _total_size).then(
            () => {
              if (isLast) {
                logger.info("Download finished", fileName);
                showNasToast(fileName + " 已保存到 NAS");
                done();
              } else {
                fetchNextPart();
              }
            }
          );
        })
        .catch((reason) => {
          done();
          logger.error(reason, fileName);
        });
    };

    fetchNextPart();
  };

  const tel_download_image = (imageUrl) => {
    const fileName =
      (Math.random() + 1).toString(36).substring(2, 10) + ".jpeg"; // assume jpeg

    const uploadToNas = async () => {
      const res = await fetch(imageUrl);
      if (!res.ok) {
        throw new Error("GET " + imageUrl + " failed: " + res.status);
      }
      const blob = await res.blob();
      const up = await fetch("/dl/upload", {
        method: "POST",
        headers: {
          "X-Filename": encodeURIComponent(fileName),
          "X-Part": 0,
          "X-Parts": 1,
        },
        body: blob,
      });
      if (!up.ok) {
        throw new Error(nasErrorHint(up.status) + " (" + up.status + ")");
      }
      logger.info("NAS download triggered", fileName);
      showNasToast(fileName + " 已保存到 NAS");
    };

    uploadToNas().catch((reason) => {
      logger.error(reason, fileName);
      // Fallback to the browser download
      const a = document.createElement("a");
      document.body.appendChild(a);
      a.href = imageUrl;
      a.download = fileName;
      a.click();
      document.body.removeChild(a);
      logger.info("Browser download fallback triggered", fileName);
    });
  };

  logger.info("Initialized");

  // For webz /a/ webapp
  setInterval(() => {
    // Stories
    const storiesContainer = document.getElementById("StoryViewer");
    if (storiesContainer) {
      console.log("storiesContainer");
      const createDownloadButton = () => {
        console.log("createDownloadButton");
        const downloadIcon = document.createElement("i");
        downloadIcon.className = "icon icon-download";
        const downloadButton = document.createElement("button");
        downloadButton.className =
          "Button TkphaPyQ tiny translucent-white round tel-download";
        downloadButton.appendChild(downloadIcon);
        downloadButton.setAttribute("type", "button");
        downloadButton.setAttribute("title", "Download");
        downloadButton.setAttribute("aria-label", "Download");
        downloadButton.onclick = () => {
          // 1. Story with video
          const video = storiesContainer.querySelector("video");
          const videoSrc =
            video?.src ||
            video?.currentSrc ||
            video?.querySelector("source")?.src;
          if (videoSrc) {
            tel_download_video(videoSrc);
          } else {
            // 2. Story with image
            const images = storiesContainer.querySelectorAll("img.PVZ8TOWS");
            if (images.length > 0) {
              const imageSrc = images[images.length - 1]?.src;
              if (imageSrc) tel_download_image(imageSrc);
            }
          }
        };
        return downloadButton;
      };

      const storyHeader =
        storiesContainer.querySelector(".GrsJNw3y") ||
        storiesContainer.querySelector(".DropdownMenu")?.parentNode;
      if (storyHeader && !storyHeader.querySelector(".tel-download")) {
        console.log("storyHeader");
        storyHeader.insertBefore(
          createDownloadButton(),
          storyHeader.querySelector("button")
        );
      }
    }

    // All media opened are located in .media-viewer-movers > .media-viewer-aspecter
    const mediaContainer = document.querySelector(
      "#MediaViewer .MediaViewerSlide--active"
    );
    const mediaViewerActions = document.querySelector(
      "#MediaViewer .MediaViewerActions"
    );
    if (!mediaContainer || !mediaViewerActions) return;

    // Videos in channels
    const videoPlayer = mediaContainer.querySelector(
      ".MediaViewerContent > .VideoPlayer"
    );
    const img = mediaContainer.querySelector(".MediaViewerContent > div > img");
    // 1. Video player detected - Video or GIF
    // container > .MediaViewerSlides > .MediaViewerSlide > .MediaViewerContent > .VideoPlayer > video[src]
    const downloadIcon = document.createElement("i");
    downloadIcon.className = "icon icon-download";
    const downloadButton = document.createElement("button");
    downloadButton.className =
      "Button smaller translucent-white round tel-download";
    downloadButton.setAttribute("type", "button");
    downloadButton.setAttribute("title", "Download");
    downloadButton.setAttribute("aria-label", "Download");
    if (videoPlayer) {
      const video = videoPlayer.querySelector("video");
      if (!video) return;
      const videoUrl = getVideoUrl(video);
      downloadButton.setAttribute("data-tel-download-url", videoUrl);
      downloadButton.appendChild(downloadIcon);
      downloadButton.onclick = () => {
        tel_download_video(getVideoUrl(video));
      };

      // Add download button to video controls
      const controls = videoPlayer.querySelector(".VideoPlayerControls");
      if (controls) {
        const buttons = controls.querySelector(".buttons");
        if (!buttons.querySelector("button.tel-download")) {
          const spacer = buttons.querySelector(".spacer");
          spacer?.after(downloadButton);
        }
      }

      // Add/Update/Remove download button to topbar
      if (mediaViewerActions.querySelector("button.tel-download")) {
        const telDownloadButton = mediaViewerActions.querySelector(
          "button.tel-download"
        );
        if (
          mediaViewerActions.querySelectorAll('button[title="Download"]')
            .length > 1
        ) {
          // There's existing download button, remove ours
          mediaViewerActions.querySelector("button.tel-download").remove();
        } else if (
          telDownloadButton.getAttribute("data-tel-download-url") !== videoUrl
        ) {
          // Update existing button
          telDownloadButton.onclick = () => {
            tel_download_video(getVideoUrl(videoPlayer.querySelector("video")));
          };
          telDownloadButton.setAttribute("data-tel-download-url", videoUrl);
        }
      } else if (
        !mediaViewerActions.querySelector('button[title="Download"]')
      ) {
        // Add the button if there's no download button at all
        mediaViewerActions.prepend(downloadButton);
      }
    } else if (img && img.src) {
      downloadButton.setAttribute("data-tel-download-url", img.src);
      downloadButton.appendChild(downloadIcon);
      downloadButton.onclick = () => {
        tel_download_image(img.src);
      };

      // Add/Update/Remove download button to topbar
      if (mediaViewerActions.querySelector("button.tel-download")) {
        const telDownloadButton = mediaViewerActions.querySelector(
          "button.tel-download"
        );
        if (
          mediaViewerActions.querySelectorAll('button[title="Download"]')
            .length > 1
        ) {
          // There's existing download button, remove ours
          mediaViewerActions.querySelector("button.tel-download").remove();
        } else if (
          telDownloadButton.getAttribute("data-tel-download-url") !== img.src
        ) {
          // Update existing button
          telDownloadButton.onclick = () => {
            tel_download_image(img.src);
          };
          telDownloadButton.setAttribute("data-tel-download-url", img.src);
        }
      } else if (
        !mediaViewerActions.querySelector('button[title="Download"]')
      ) {
        // Add the button if there's no download button at all
        mediaViewerActions.prepend(downloadButton);
      }
    }
  }, REFRESH_DELAY);

  // For webk /k/ webapp
  setInterval(() => {
    /* Voice Message or Circle Video */
    const pinnedAudio = document.body.querySelector(".pinned-audio");
    let dataMid;
    let downloadButtonPinnedAudio =
      document.body.querySelector("._tel_download_button_pinned_container") ||
      document.createElement("button");
    if (pinnedAudio) {
      dataMid = pinnedAudio.getAttribute("data-mid");
      downloadButtonPinnedAudio.className =
        "btn-icon tgico-download _tel_download_button_pinned_container";
      downloadButtonPinnedAudio.innerHTML = `<span class="tgico button-icon">${DOWNLOAD_ICON}</span>`;
    }
    const audioElements = document.body.querySelectorAll("audio-element");
    audioElements.forEach((audioElement) => {
      const bubble = audioElement.closest(".bubble");
      if (
        !bubble ||
        bubble.querySelector("._tel_download_button_pinned_container")
      ) {
        return; /* Skip if there's already a download button */
      }
      if (
        dataMid &&
        downloadButtonPinnedAudio.getAttribute("data-mid") !== dataMid &&
        audioElement.getAttribute("data-mid") === dataMid
      ) {
        const link = audioElement.audio && audioElement.audio.getAttribute("src");
        if (!link) {
          return;
        }
        const isAudio = audioElement.audio instanceof HTMLAudioElement;
        downloadButtonPinnedAudio.onclick = (e) => {
          e.stopPropagation();
          if (isAudio) {
              tel_download_audio(link);
          } else {
              tel_download_video(link);
          }
        };
        downloadButtonPinnedAudio.setAttribute("data-mid", dataMid);
        pinnedAudio
          .querySelector(".pinned-container-wrapper-utils")
          ?.appendChild(downloadButtonPinnedAudio);
      }
    });

    // Stories
    const storiesContainer = document.getElementById("stories-viewer");
    if (storiesContainer) {
      const createDownloadButton = () => {
        const downloadButton = document.createElement("button");
        downloadButton.className = "btn-icon rp tel-download";
        downloadButton.innerHTML = `<span class="tgico">${DOWNLOAD_ICON}</span><div class="c-ripple"></div>`;
        downloadButton.setAttribute("type", "button");
        downloadButton.setAttribute("title", "Download");
        downloadButton.setAttribute("aria-label", "Download");
        downloadButton.onclick = () => {
          // 1. Story with video
          const video = storiesContainer.querySelector("video.media-video");
          const videoSrc =
            video?.src ||
            video?.currentSrc ||
            video?.querySelector("source")?.src;
          if (videoSrc) {
            tel_download_video(videoSrc);
          } else {
            // 2. Story with image
            const imageSrc =
              storiesContainer.querySelector("img.media-photo")?.src;
            if (imageSrc) tel_download_image(imageSrc);
          }
        };
        return downloadButton;
      };

      const storyHeader = storiesContainer.querySelector(
        "[class^='_ViewerStoryHeaderRight']"
      );
      if (storyHeader && !storyHeader.querySelector(".tel-download")) {
        storyHeader.prepend(createDownloadButton());
      }

      const storyFooter = storiesContainer.querySelector(
        "[class^='_ViewerStoryFooterRight']"
      );
      if (storyFooter && !storyFooter.querySelector(".tel-download")) {
        storyFooter.prepend(createDownloadButton());
      }
    }

    // All media opened are located in .media-viewer-movers > .media-viewer-aspecter
    const mediaContainer = document.querySelector(".media-viewer-whole");
    if (!mediaContainer) return;
    const mediaAspecter = mediaContainer.querySelector(
      ".media-viewer-movers .media-viewer-aspecter"
    );
    const mediaButtons = mediaContainer.querySelector(
      ".media-viewer-topbar .media-viewer-buttons"
    );
    if (!mediaAspecter || !mediaButtons) return;

    // Only unhide the forward button; the official download button (when
    // present) is left untouched. Our own NAS download button is added
    // unconditionally below, so downloads always go to the NAS volume.
    const hiddenButtons = mediaButtons.querySelectorAll("button.btn-icon.hide");
    for (const btn of hiddenButtons) {
      if (btn.textContent === FORWARD_ICON) {
        btn.classList.remove("hide");
        btn.classList.add("tgico-forward");
      }
    }

    // Skip if our NAS download button is already there for this media.
    if (mediaButtons.querySelector("button.btn-icon.tel-download")) return;

    const makeNasButton = () => {
      const downloadButton = document.createElement("button");
      downloadButton.className = "btn-icon tgico-download tel-download";
      downloadButton.innerHTML = `<span class="tgico button-icon">${DOWNLOAD_ICON}</span>`;
      downloadButton.setAttribute("type", "button");
      downloadButton.setAttribute("title", "Download to NAS");
      downloadButton.setAttribute("aria-label", "Download to NAS");
      return downloadButton;
    };

    if (mediaAspecter.querySelector(".ckin__player")) {
      // 1. Video player detected - Video and it has finished initial loading
      // container > .ckin__player > video[src]

      // add download button to videos
      const controls = mediaAspecter.querySelector(
        ".default__controls.ckin__controls"
      );
      if (controls) {
        const brControls = controls.querySelector(
          ".bottom-controls .right-controls"
        );
        if (!brControls) return;
        const downloadButton = makeNasButton();
        downloadButton.classList.add("default__button");
        downloadButton.onclick = async () => {
          const video = mediaAspecter.querySelector("video");
          if (!video) return;
          const closeWait = showWaitingToast();
          const url = await waitForVideoSource(video, 15000);
          closeWait && closeWait();
          if (!url) {
            logger.error(
              "Video source is empty — the video failed to load; reopen the media viewer and try again",
              "download"
            );
            return;
          }
          tel_download_video(url);
        };
        brControls.prepend(downloadButton);
      }
    } else if (mediaAspecter.querySelector("video")) {
      // 2. Video HTML element detected, could be either GIF or unloaded video
      // container > video[src]
      const downloadButton = makeNasButton();
      downloadButton.onclick = async () => {
        const video = mediaAspecter.querySelector("video");
        if (!video) return;
        const closeWait = showWaitingToast();
        const url = await waitForVideoSource(video, 15000);
        closeWait && closeWait();
        if (!url) {
          logger.error(
            "Video source is empty — the video failed to load; reopen the media viewer and try again",
            "download"
          );
          return;
        }
        tel_download_video(url);
      };
      mediaButtons.prepend(downloadButton);
    } else {
      // 3. Image
      // container > img.thumbnail
      const img = mediaAspecter.querySelector("img.thumbnail");
      if (!img || !img.src) {
        return;
      }
      const downloadButton = makeNasButton();
      downloadButton.onclick = () => {
        tel_download_image(img.src);
      };
      mediaButtons.prepend(downloadButton);
    }
  }, REFRESH_DELAY);

  // Progress bar container setup
  (function setupProgressBar() {
    const body = document.querySelector("body");
    if (!body) {
      return; // module scripts run after DOM parse; guard anyway
    }
    const container = document.createElement("div");
    container.id = "tel-downloader-progress-bar-container";
    container.style.position = "fixed";
    container.style.bottom = 0;
    container.style.right = 0;
    if (location.pathname.startsWith("/k/")) {
      container.style.zIndex = 4;
    } else {
      container.style.zIndex = 1600;
    }
    body.appendChild(container);
  })();


  /* ============ NAS batch downloader ============ */
  // Upload one blob part; the server finalizes the file when X-Last is "1".
  const postPartToNas = (fileName, blob, isLast, partIndex, totalSize) => {
    const headers = {
      "X-Filename": encodeURIComponent(fileName),
      "X-Part": partIndex,
      "X-Parts": 1,
      "X-Last": isLast ? "1" : "0",
    };
    // X-Size tells the sink the file's expected size so the download-center
    // progress bar can show a real percentage for streaming uploads (where
    // X-Parts is always 1).
    if (totalSize !== undefined && totalSize !== null && totalSize > 0) {
      headers["X-Size"] = String(totalSize);
    }
    return fetch("/dl/upload", {
      method: "POST",
      headers,
      body: blob,
    }).then((res) => {
      if (!res.ok) {
        throw new Error(nasErrorHint(res.status) + " (" + res.status + ")");
      }
      return res.json();
    });
  };

  const downloadUrlToNas = async (url, fileName, onProgress, isCancelled) => {
    let offset = 0;
    let total = null;
    let partIndex = 0;
    while (true) {
      if (isCancelled && isCancelled()) throw new Error("cancelled");
      const res = await fetch(url, {
        headers: {Range: "bytes=" + offset + "-"},
      });
      if (res.status === 416 && offset === 0) {
        // empty/missing source: record a 0-byte file instead of failing
        await postPartToNas(fileName, new Blob([]), true, partIndex, 0);
        onProgress && onProgress(100);
        return;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      const cr = res.headers.get("Content-Range");
      if (!cr) {
        // server does not support Range: fetch the whole file at once
        const blob = await res.blob();
        await postPartToNas(fileName, blob, true, partIndex, null);
        onProgress && onProgress(100);
        return;
      }
      const m = cr.match(/bytes (\d+)-(\d+)\/(\d+)/);
      if (!m) throw new Error("bad content-range");
      const start = +m[1];
      if (start !== offset) throw new Error("range mismatch: server ignored offset");
      total = +m[3];
      if (!Number.isFinite(total)) throw new Error("unknown total in content-range");
      const blob = await res.blob();
      offset = +m[2] + 1;
      if (offset <= start) throw new Error("no progress from range response");
      const isLast = offset >= total;
      await postPartToNas(fileName, blob, isLast, partIndex++, total);
      onProgress && onProgress(Math.round((offset / total) * 100));
      if (isLast) return;
    }
  };

  const batchState = {
    open: false,
    view: "dialogs", // 'dialogs' | 'media'
    peer: null,
    dialogTitle: "",
    filter: "all",
    format: "all",
    items: [],       // all fetched items (unfiltered)
    dialogs: null,   // cached dialog list (refreshed on panel open)
    lastMids: {},    // filter -> last fetched mid (for load-more pagination)
    endReached: {},  // filter -> true once a page came back short/empty
    renderSeq: 0,    // bumps on every view/tab switch to drop stale fetches
    generation: 0,   // bumps when leaving the batch context to cancel downloads
    selected: new Set(),
    downloading: false,
    query: "",
    listEl: null,
    contentEl: null,
    formatEl: null,
  };

  const MEDIA_TAB_ICONS = {
    photo: "\u{1F5BC}\uFE0F",
    video: "\u{1F3AC}",
    gif: "\u{1F4E1}\uFE0F",
    audio: "\u{1F3B5}",
    document: "\u{1F4C4}",
  };
  const DIALOG_TYPE_ICONS = {channel: "\u{1F4E2}", chat: "\u{1F465}", user: "\u{1F464}"};

  const batchEl = () => document.getElementById("tel-batch-panel");

  const batchToast = (msg, color) => {
    const c = document.getElementById("tel-downloader-progress-bar-container");
    if (!c) return;
    const t = document.createElement("div");
    t.className = "tel-dl-toast";
    t.style.cssText =
      "background:" + (color || "#6093B5") + ";color:#fff;font-size:.8rem;padding:.55rem 1rem;" +
      "margin-bottom:.4rem;box-shadow:0 4px 14px rgba(15,30,50,.25);";
    t.innerText = msg;
    c.prepend(t);
    setTimeout(() => t.remove(), 5000);
  };

  const renderBatchDialogList = async (force) => {
    const list = batchState.listEl;
    if (!list) return;
    const bridge = window.__TEL_DOWNLOADER_BRIDGE__;
    if (!bridge) {
      list.innerHTML =
        '<div style="padding:.8rem;color:#D16666;font-size:.8rem;">桥接不可用：请先登录 Telegram 账号，并更新到最新镜像</div>';
      return;
    }
    // enumerate once per panel open, then filter client-side — re-running the
    // full paginated dialog walk on every keystroke is expensive and racy
    if (!batchState.dialogs || force) {
      const seq = ++batchState.renderSeq;
      list.innerHTML = '<div style="padding:.8rem;color:#8a8a8a;font-size:.8rem;">加载对话…</div>';
      try {
        batchState.dialogs = await bridge.listDialogs();
      } catch (e) {
        list.innerHTML =
          '<div style="padding:.8rem;color:#D16666;font-size:.8rem;">加载频道失败：' + e.message + "</div>";
        return;
      }
      if (seq !== batchState.renderSeq) return; // a newer render superseded us
    }
    const q = batchState.query.toLowerCase();
    const filtered = q
      ? batchState.dialogs.filter((d) => d.title.toLowerCase().includes(q))
      : batchState.dialogs;

    list.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:.8rem;color:#8a8a8a;text-align:center;font-size:.8rem;";
      empty.innerText = q ? "没有匹配的对话" : "暂无可下载的对话（请先打开过至少一个会话）";
      list.appendChild(empty);
      return;
    }
    for (const d of filtered) {
      const row = document.createElement("div");
      row.className = "tel-dl-row";
      row.style.cssText =
        "display:flex;align-items:center;gap:.5rem;padding:.5rem .7rem;cursor:pointer;margin:.1rem .4rem;";
      row.onclick = async () => {
        batchState.view = "media";
        batchState.peer = d.peerId;
        batchState.dialogTitle = d.title;
        batchState.selected.clear();
        batchState.filter = "all";
        batchState.format = "all";
        batchState.generation++; // cancel an in-flight batch download
        resetBatchMedia();
        renderBatchHeader();
        const seq = batchState.renderSeq;
        await fetchBatchMedia(0);
        if (seq === batchState.renderSeq) renderBatchMediaList();
      };
      const icon = document.createElement("span");
      icon.style.cssText = "font-size:1.1rem;flex:none;";
      icon.innerText = DIALOG_TYPE_ICONS[d.type] || "\u{1F4C1}";
      const info = document.createElement("div");
      info.style.cssText = "flex:1;min-width:0;";
      const title = document.createElement("div");
      title.style.cssText =
        "font-size:.8rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      title.innerText = d.title;
      const meta = document.createElement("div");
      meta.style.cssText = "font-size:.7rem;color:#8a8a8a;";
      meta.innerText =
        d.type === "channel" ? "频道" : d.type === "chat" ? "群组" : "私聊";
      info.appendChild(title);
      info.appendChild(meta);
      row.appendChild(icon);
      row.appendChild(info);
      const go = document.createElement("span");
      go.style.cssText = "color:#8a8a8a;font-size:.9rem;";
      go.innerText = "\u203A";
      row.appendChild(go);
      list.appendChild(row);
    }
  };

  // Fetch the next page (offsetId) for the current filter and MERGE into
  // batchState.items (no reset — load-more keeps appending). Returns the
  // number of new items, or -1 on error.
  const fetchBatchMedia = async (offsetId) => {
    const bridge = window.__TEL_DOWNLOADER_BRIDGE__;
    const peerId = batchState.peer;
    if (!bridge || peerId === null) return -1;
    const seq = batchState.renderSeq;

    const filters = batchState.filter === "all"
      ? ["video", "photo", "gif", "audio", "document"]
      : [batchState.filter];

    let fetched = [];
    try {
      for (const key of filters) {
        if (seq !== batchState.renderSeq) return -1; // superseded by a tab/view switch
        const res = await bridge.searchMedia(peerId, key, 100, offsetId || 0);
        fetched = fetched.concat(res.items || []);
      }
    } catch (e) {
      return -1;
    }
    if (seq !== batchState.renderSeq) return -1;

    const have = new Set(batchState.items.map((it) => it.mid));
    const fresh = fetched.filter((it) => !have.has(it.mid));
    batchState.items = batchState.items.concat(fresh).sort((a, b) => b.mid - a.mid);
    if (batchState.filter !== "all") {
      // a page shorter than the limit (or empty) means we reached the tail
      const perFilter = fetched.length;
      if (!fresh.length || perFilter < 100) {
        batchState.endReached[batchState.filter] = true;
      } else if (fresh.length) {
        batchState.lastMids[batchState.filter] = fresh[fresh.length - 1].mid;
      }
    }
    return fresh.length;
  };

  const resetBatchMedia = () => {
    batchState.items = [];
    batchState.lastMids = {};
    batchState.endReached = {};
    batchState.renderSeq++;
  };

  // Render ONLY (no fetching) — formats filters apply here.
  const renderBatchMediaList = () => {
    const list = batchState.listEl;
    if (!list) return;

    let items = batchState.items;

    // fill the format dropdown with the extensions actually present
    if (batchState.formatEl) {
      const exts = new Set();
      for (const it of items) {
        const m = (it.fileName || "").match(/\.([a-zA-Z0-9]{2,5})$/);
        if (m) exts.add(m[1].toLowerCase());
      }
      const sorted = [...exts].sort();
      const cur = batchState.format;
      batchState.formatEl.replaceChildren();
      const optAll = document.createElement("option");
      optAll.value = "all";
      optAll.innerText = "全部格式";
      batchState.formatEl.appendChild(optAll);
      for (const e of sorted) {
        const o = document.createElement("option");
        o.value = e;
        o.innerText = "." + e;
        batchState.formatEl.appendChild(o);
      }
      batchState.formatEl.value = sorted.includes(cur) ? cur : "all";
      batchState.format = batchState.formatEl.value;
    }

    // format filter (frontend only — all items already fetched)
    if (batchState.format !== "all") {
      items = items.filter((it) => {
        const m = (it.fileName || "").match(/\.([a-zA-Z0-9]{2,5})$/);
        return m && m[1].toLowerCase() === batchState.format;
      });
    }

    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:.8rem;color:#8a8a8a;text-align:center;font-size:.8rem;";
      empty.innerText = "该分类下没有媒体";
      list.appendChild(empty);
      return;
    }

    const dark = managerState.dark;
    const cs = {
      border: dark ? "rgba(255,255,255,.08)" : "rgba(0,0,0,.08)",
    };

    for (const it of items) {
      const row = document.createElement("div");
      row.className = "tel-dl-row";
      row.style.cssText =
        "display:flex;align-items:center;gap:.4rem;padding:.4rem .6rem;margin:.1rem .4rem;";
      const cb = document.createElement("span");
      cb.style.cssText =
        "flex:none;width:1.05rem;height:1.05rem;border:1.5px solid #6093B5;border-radius:.25rem;cursor:pointer;" +
        "display:inline-flex;align-items:center;justify-content:center;font-size:.65rem;color:#fff;" +
        "user-select:none;background:#fff;line-height:1;";
      cb.setChecked = (on) => {
        cb.dataset.on = on ? "1" : "0";
        cb.style.background = on ? "#6093B5" : "#fff";
        cb.textContent = on ? "\u2713" : "";
      };
      cb.setChecked(batchState.selected.has(it.mid));
      cb.dataset.mid = "" + it.mid;
      cb.onclick = () => {
        const on = cb.dataset.on !== "1";
        cb.setChecked(on);
        if (on) batchState.selected.add(it.mid);
        else batchState.selected.delete(it.mid);
        updateBatchFooter();
      };
      const icon = document.createElement("span");
      icon.style.cssText = "font-size:1rem;flex:none;";
      icon.innerText = MEDIA_TAB_ICONS[it.kind] || "\u{1F4C4}";
      const info = document.createElement("div");
      info.style.cssText = "flex:1;min-width:0;";
      const name = document.createElement("div");
      name.style.cssText =
        "font-size:.78rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      name.title = it.fileName;
      name.innerText = it.fileName;
      const meta = document.createElement("div");
      meta.style.cssText = "font-size:.68rem;color:#8a8a8a;";
      const extMatch = (it.fileName || "").match(/\.([a-zA-Z0-9]{2,5})$/);
      const badge = extMatch
        ? '<span style="background:#6093B5;color:#fff;border-radius:2rem;padding:0 .35rem;margin-right:.3rem;font-size:.62rem;">.' + extMatch[1].toLowerCase() + "</span>"
        : "";
      meta.innerHTML = badge + (it.size ? formatSize(it.size) : "") + (it.mime ? " " + it.mime : "");
      info.appendChild(name);
      info.appendChild(meta);
      row.appendChild(cb);
      row.appendChild(icon);
      row.appendChild(info);
      list.appendChild(row);
    }

    // load-more button (single-filter tabs; 'all' already merges 5 tabs)
    if (batchState.filter !== "all" && !batchState.endReached[batchState.filter]) {
      const moreBtn = document.createElement("button");
      moreBtn.className = "tel-dl-btn";
      moreBtn.style.cssText =
        "display:block;margin:.6rem auto;background:#6093B5;color:#fff;padding:.35rem 1rem;font-size:.75rem;";
      moreBtn.innerText = "加载更多";
      moreBtn.onclick = async () => {
        if (batchState.downloading) return; // keep the current download predictable
        moreBtn.disabled = true;
        moreBtn.innerText = "加载中…";
        const offsetId = batchState.lastMids[batchState.filter] || 0;
        const added = await fetchBatchMedia(offsetId);
        if (added < 0) {
          moreBtn.disabled = false;
          moreBtn.innerText = "加载更多（失败，重试）";
          return;
        }
        renderBatchMediaList();
      };
      list.appendChild(moreBtn);
    }
  };

  const startBatchDownload = async () => {
    if (batchState.selected.size === 0 || batchState.downloading) return;
    batchState.downloading = true;
    const generation = batchState.generation;
    updateBatchFooter();
    const targets = batchState.items.filter((it) => batchState.selected.has(it.mid));
    let ok = 0;
    let failed = 0;
    const failedNames = [];
    for (let i = 0; i < targets.length; i++) {
      if (generation !== batchState.generation) break; // user left the batch context
      const it = targets[i];
      batchToast(
        "\u2B07 批量下载 " + (i + 1) + "/" + targets.length + "：" + it.fileName,
        ok + failed ? "#B6C649" : "#6093B5"
      );
      try {
        await downloadUrlToNas(it.url, it.fileName, null, () => generation !== batchState.generation);
        ok++;
      } catch (e) {
        if (e && e.message === "cancelled") break;
        failed++;
        failedNames.push(it.fileName);
        logger.error("batch item failed: " + it.fileName + " " + (e && e.message), "batch");
      }
    }
    const cancelled = generation !== batchState.generation;
    batchState.downloading = false;
    batchState.selected.clear();
    updateBatchFooter();
    if (cancelled) {
      batchToast("批量下载已取消（已完成 " + ok + " 个）", "#D16666");
    } else {
      batchToast(
        "批量下载完成：成功 " + ok +
        (failed ? "，失败 " + failed + (failedNames.length ? "：" + failedNames.slice(0, 3).join("、") + (failedNames.length > 3 ? " 等" : "") : "") : "") +
        " \u2713",
        failed ? "#D16666" : "#B6C649"
      );
    }
  };

  const renderBatchHeader = () => {
    const panel = batchEl();
    if (!panel) return;
    const header = panel.querySelector(".tel-batch-header");
    if (!header) return;

    const formatBar = document.getElementById("tel-batch-formatbar");
    if (formatBar) {
      formatBar.style.display = batchState.view === "media" ? "flex" : "none";
    }

    if (batchState.view === "dialogs") {
      header.innerHTML =
        '<span style="font-weight:700;font-size:.85rem;">批量下载 - 选择对话</span>';
      return;
    }

    header.innerHTML = "";
    const back = document.createElement("button");
    back.style.cssText =
      "border:none;background:none;color:#fff;cursor:pointer;font-size:1rem;padding:0 .2rem;";
    back.innerText = "\u2039";
    back.title = "返回对话列表";
    back.onclick = () => {
      batchState.view = "dialogs";
      batchState.peer = null;
      batchState.selected.clear();
      batchState.generation++; // cancel an in-flight batch download
      resetBatchMedia();
      renderBatchHeader();
      renderBatchDialogList();
    };
    const title = document.createElement("span");
    title.style.cssText =
      "flex:1;min-width:0;font-weight:700;font-size:.8rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    title.innerText = batchState.dialogTitle;
    title.title = batchState.dialogTitle;
    header.appendChild(back);
    header.appendChild(title);

    const tabs = document.createElement("div");
    tabs.style.cssText =
      "display:flex;gap:.3rem;overflow-x:auto;padding:.4rem .8rem;background:none;border-bottom:1px solid rgba(255,255,255,.15);";
    const tabDefs = [
      ["all", "全部"],
      ["video", "视频"],
      ["photo", "图片"],
      ["gif", "GIF"],
      ["audio", "音频"],
      ["document", "文件"],
    ];
    for (const [key, label] of tabDefs) {
      const t = document.createElement("button");
      t.className = "tel-dl-chip";
      t.style.cssText =
        "padding:.28rem .7rem;font-size:.72rem;" +
        (batchState.filter === key
          ? "background:#fff;color:#6093B5;font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,.15);"
          : "background:rgba(255,255,255,.22);color:#fff;");
      t.innerText = label;
      t.onclick = async () => {
        batchState.filter = key;
        batchState.selected.clear();
        batchState.format = "all";
        resetBatchMedia();
        renderBatchHeader();
        const seq = batchState.renderSeq;
        await fetchBatchMedia(0);
        if (seq === batchState.renderSeq) renderBatchMediaList();
      };
      tabs.appendChild(t);
    }
    header.appendChild(tabs);
  };

  const setupBatchDownloader = () => {
    const container = document.getElementById("tel-downloader-progress-bar-container");
    if (!container) return;
    if (document.getElementById("tel-batch-toggle")) return;

    const toggle = document.createElement("button");
    toggle.id = "tel-batch-toggle";
    toggle.innerText = "批量下载";
    toggle.className = "tel-dl-fab";
    toggle.style.cssText =
      fabPosition(8.8) + "background:#B6C649;color:#fff;";
    toggle.onclick = () => {
      batchState.open = !batchState.open;
      const panel = batchEl();
      panel.style.display = batchState.open ? "flex" : "none";
      toggle.style.background = batchState.open ? "#D16666" : "#B6C649";
      if (!batchState.open) {
        batchState.generation++; // cancel any in-flight batch download
      }
      if (batchState.open) {
        if (batchState.view === "dialogs") renderBatchDialogList(true);
        else {
          renderBatchHeader();
          if (!batchState.items.length) {
            const seq = batchState.renderSeq;
            fetchBatchMedia(0).then(() => {
              if (seq === batchState.renderSeq) renderBatchMediaList();
            });
          } else {
            renderBatchMediaList();
          }
        }
      }
    };
    document.body.appendChild(toggle);

    const panel = document.createElement("div");
    panel.id = "tel-batch-panel";
    panel.className = "tel-dl-panel " + (managerState.dark ? "tel-dl-dark" : "tel-dl-light");
    panel.style.cssText =
      "position:fixed;right:0.9rem;bottom:" + (isNarrowScreen() ? "13.6rem" : "11.4rem") +
      ";z-index:9999;width:340px;max-width:92vw;max-height:62vh;" +
      "display:none;flex-direction:column;";

    const header = document.createElement("div");
    header.className = "tel-batch-header tel-dl-header";
    header.style.cssText =
      "display:flex;align-items:center;gap:.4rem;padding:.7rem .9rem;color:#fff;flex-wrap:wrap;";
    panel.appendChild(header);

    const searchWrap = document.createElement("div");
    searchWrap.className = "tel-dl-card";
    searchWrap.style.cssText =
      "padding:.45rem .8rem;border-bottom:1px solid " + (managerState.dark ? "rgba(255,255,255,.08)" : "rgba(0,0,0,.06)") +
      ";background:" + (managerState.dark ? "#242830" : "#f4f7fa") + ";";
    const search = document.createElement("input");
    search.id = "tel-batch-search";
    search.placeholder = "搜索对话名称";
    search.className = "tel-dl-input";
    search.style.cssText =
      "width:100%;box-sizing:border-box;border:1px solid " + (managerState.dark ? "#444" : "#ddd") +
      ";background:" + (managerState.dark ? "#2c2c2c" : "#fff") + ";color:" + (managerState.dark ? "#eee" : "#222") +
      ";padding:.35rem .7rem;font-size:.75rem;";
    search.oninput = () => {
      batchState.query = search.value.trim();
      if (batchState.view === "dialogs") renderBatchDialogList();
    };
    searchWrap.appendChild(search);
    panel.appendChild(searchWrap);

    batchState.contentEl = document.createElement("div");
    batchState.contentEl.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0;";

    // format filter bar (visible in media view)
    const formatBar = document.createElement("div");
    formatBar.id = "tel-batch-formatbar";
    formatBar.className = "tel-dl-card";
    formatBar.style.cssText =
      "display:none;align-items:center;gap:.4rem;padding:.4rem .8rem;" +
      "border-bottom:1px solid " + (managerState.dark ? "rgba(255,255,255,.08)" : "rgba(0,0,0,.06)") + ";" +
      "background:" + (managerState.dark ? "#242830" : "#f4f7fa") + ";";
    const formatLabel = document.createElement("span");
    formatLabel.style.cssText = "font-size:.72rem;color:#8a8a8a;";
    formatLabel.innerText = "格式";
    const formatSelect = document.createElement("select");
    formatSelect.id = "tel-batch-format";
    formatSelect.className = "tel-dl-input";
    formatSelect.style.cssText =
      "flex:1;min-width:0;border:1px solid " + (managerState.dark ? "#444" : "#ddd") +
      ";background:" + (managerState.dark ? "#2c2c2c" : "#fff") + ";color:" + (managerState.dark ? "#eee" : "#222") +
      ";padding:.3rem .6rem;font-size:.75rem;";
    formatBar.appendChild(formatLabel);
    formatBar.appendChild(formatSelect);
    batchState.contentEl.appendChild(formatBar);
    batchState.formatEl = formatSelect;

    const listWrap = document.createElement("div");
    listWrap.className = "tel-dl-scroll";
    listWrap.style.cssText = "overflow-y:auto;flex:1;min-height:0;";
    batchState.listEl = document.createElement("div");
    listWrap.appendChild(batchState.listEl);
    batchState.contentEl.appendChild(listWrap);

    const footer = document.createElement("div");
    footer.className = "tel-dl-card";
    footer.style.cssText =
      "display:flex;align-items:center;gap:.4rem;padding:.45rem .8rem;border-top:1px solid " +
      (managerState.dark ? "rgba(255,255,255,.08)" : "rgba(0,0,0,.06)") + ";" +
      "background:" + (managerState.dark ? "#242830" : "#f4f7fa") + ";";
    const selAll = document.createElement("span");
    selAll.id = "tel-batch-select-all";
    selAll.title = "全选当前列表";
    selAll.className = "tel-dl-check";
    selAll.style.cssText =
      "flex:none;width:1.05rem;height:1.05rem;border:1.5px solid #6093B5;" +
      "display:inline-flex;align-items:center;justify-content:center;font-size:.65rem;color:#fff;background:#fff;";
    selAll.onclick = () => {
      const rows = batchState.listEl.querySelectorAll("span[data-on]");
      const allOn = rows.length > 0 && [...rows].every((r) => r.dataset.on === "1");
      const mids = [];
      for (const r of rows) {
        const on = !allOn;
        r.dataset.on = on ? "1" : "0";
        r.style.background = on ? "#6093B5" : "#fff";
        r.textContent = on ? "\u2713" : "";
        if (r.dataset.mid) mids.push(+r.dataset.mid);
      }
      // only the visible (format/tab-filtered) rows take part
      for (const mid of mids) {
        if (allOn) batchState.selected.delete(mid);
        else batchState.selected.add(mid);
      }
      updateBatchFooter();
    };
    const dlBtn = document.createElement("button");
    dlBtn.id = "tel-batch-download";
    dlBtn.className = "tel-dl-btn";
    dlBtn.style.cssText =
      "flex:1;background:#B6C649;color:#fff;padding:.4rem .9rem;font-size:.75rem;";
    dlBtn.disabled = true;
    footer.appendChild(selAll);
    footer.appendChild(dlBtn);
    batchState.contentEl.appendChild(footer);
    panel.appendChild(batchState.contentEl);

    const close = document.createElement("button");
    close.style.cssText =
      "position:absolute;top:.5rem;right:.6rem;border:none;background:none;color:#fff;cursor:pointer;font-size:1rem;";
    close.innerText = "\u2715";
    close.onclick = () => toggle.click();
    panel.appendChild(close);
    document.body.appendChild(panel);

    document.getElementById("tel-batch-download").onclick = startBatchDownload;
    formatSelect.onchange = () => {
      batchState.format = formatSelect.value;
      batchState.selected.clear();
      updateBatchFooter();
      renderBatchMediaList(); // re-render (filter is frontend-side)
    };
    renderBatchHeader();
  };

  setupDownloadManager();
  setupBatchDownloader();
  checkServiceWorker();

  // Verification hook: check in a browser console with
  //   window.__TEL_DOWNLOADER__
  window.__TEL_DOWNLOADER__ = true;

  logger.info("Completed script setup.");
})();
