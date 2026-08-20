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
      "background:#B6C649;color:#fff;font-size:.85rem;padding:.6rem 1rem;border-radius:2rem;" +
      "margin-bottom:.4rem;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);display:flex;gap:.5rem;align-items:center;";
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

  /* ============ NAS download manager ============ */
  const managerState = {
    open: false,
    timer: null,
    listEl: null,
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

  const refreshManagerList = async () => {
    if (!managerState.open) return;
    const listEl = managerState.listEl;
    if (!listEl) return;

    let files = [];
    let active = [];
    try {
      const filesRes = await fetch("/dl/files");
      if (filesRes.ok) {
        files = (await filesRes.json()).files || [];
      }
      const statusRes = await fetch("/dl/status");
      if (statusRes.ok) {
        active = (await statusRes.json()).active || [];
      }
    } catch (e) {
      listEl.innerHTML =
        '<div style="padding:.6rem;color:#D16666;">下载中心暂时不可用（/dl/ 通道未部署）</div>';
      return;
    }

    const activeMap = new Map(active.map((a) => [a.name, a]));

    const renderRow = (file) => {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;align-items:center;gap:.5rem;padding:.5rem .6rem;border-bottom:1px solid rgba(0,0,0,.08);";
      const info = document.createElement("div");
      info.style.cssText = "flex:1;min-width:0;";
      const name = document.createElement("div");
      name.style.cssText =
        "font-size:.8rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      name.title = file.name;
      name.innerText = file.name;
      const meta = document.createElement("div");
      meta.style.cssText = "font-size:.7rem;color:#8a8a8a;";
      const act = activeMap.get(file.name);
      if (act) {
        const pct = act.parts
          ? Math.round(((act.received - 1) / act.parts) * 100)
          : 0;
        meta.innerText = "下载中 " + pct + "% (" + act.received + "/" + act.parts + " 段)";
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
        const ok = window.confirm("确定删除 " + file.name + " ？\n\nNAS 上的文件也会被删除。");
        if (!ok) return;
        try {
          const res = await fetch(
            "/dl/files/" + encodeURIComponent(file.name),
            {method: "DELETE"}
          );
          if (!res.ok) throw new Error(res.status);
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
      empty.style.cssText = "padding:.8rem;color:#8a8a8a;text-align:center;font-size:.8rem;";
      empty.innerText = "暂无下载（文件会出现在这里）";
      listEl.appendChild(empty);
    }
  };

  const setupDownloadManager = () => {
    const container = document.getElementById("tel-downloader-progress-bar-container");
    if (!container) return;

    if (document.getElementById("tel-dl-manager-toggle")) return;

    const toggle = document.createElement("button");
    toggle.id = "tel-dl-manager-toggle";
    toggle.innerText = "NAS 下载中心";
    toggle.style.cssText =
      "position:fixed;right:1rem;bottom:5.5rem;z-index:1600;background:#6093B5;color:#fff;" +
      "border:none;border-radius:2rem;padding:.5rem .9rem;font-size:.8rem;cursor:pointer;" +
      "box-shadow:0 2px 8px rgba(0,0,0,.3);";
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
    panel.style.cssText =
      "position:fixed;right:1rem;bottom:8.2rem;z-index:1600;width:320px;max-height:55vh;" +
      "overflow:hidden;background:#fff;color:#222;border-radius:1rem;box-shadow:0 4px 20px rgba(0,0,0,.35);" +
      "display:none;flex-direction:column;";
    panel.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:.6rem .8rem;' +
      'background:#6093B5;color:#fff;border-radius:1rem 1rem 0 0;">' +
      "<span style='font-weight:700;font-size:.85rem;'>NAS 下载中心</span>" +
      "<span style='display:flex;gap:.4rem;'>" +
      "<button id='tel-dl-refresh' title='刷新' style='border:none;background:none;color:#fff;cursor:pointer;font-size:1rem;'>&#8635;</button>" +
      "<button id='tel-dl-close' title='关闭' style='border:none;background:none;color:#fff;cursor:pointer;font-size:1rem;'>&#10005;</button>" +
      "</span></div>" +
      '<div style="padding:.5rem .8rem;font-size:.7rem;color:#8a8a8a;background:#f7f8f9;border-bottom:1px solid rgba(0,0,0,.06);">' +
      "文件保存在 NAS 的 downloads 目录（telegram-web-dl 挂载卷）</div>";
    const listWrap = document.createElement("div");
    listWrap.style.cssText = "overflow-y:auto;";
    managerState.listEl = document.createElement("div");
    listWrap.appendChild(managerState.listEl);
    panel.appendChild(listWrap);
    document.body.appendChild(panel);

    document.getElementById("tel-dl-refresh").onclick = refreshManagerList;
    document.getElementById("tel-dl-close").onclick = () => toggle.click();
  };

const getVideoUrl = (video) =>
    video?.src ||
    video?.currentSrc ||
    video?.querySelector("source")?.src ||
    video?.getAttribute("src") ||
    "";

  const tel_download_video = (url) => {
    if (!url) {
      logger.error(
        "Video source is empty — open the video (let it start loading) and try again",
        "download"
      );
      return;
    }

    let _blobs = [];
    let _next_offset = 0;
    let _total_size = null;
    let _file_extension = "mp4";

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
        "User-Agent":
          "User-Agent Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/117.0",
      })
        .then((res) => {
          if (![200, 206].includes(res.status)) {
            throw new Error("Non 200/206 response was received: " + res.status);
          }
          const mime = res.headers.get("Content-Type").split(";")[0];
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

          const match = res.headers
            .get("Content-Range")
            .match(contentRangeRegex);

          const startOffset = parseInt(match[1]);
          const endOffset = parseInt(match[2]);
          const totalSize = parseInt(match[3]);

          if (startOffset !== _next_offset) {
            logger.error("Gap detected between responses.", fileName);
            logger.info("Last offset: " + _next_offset, fileName);
            logger.info("New start offset " + match[1], fileName);
            throw "Gap detected between responses.";
          }
          if (_total_size && totalSize !== _total_size) {
            logger.error("Total size differs", fileName);
            throw "Total size differs";
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
          return res.blob();
        })
        .then((resBlob) => {
          _blobs.push(resBlob);
        })
        .then(() => {
          if (!_total_size) {
            throw new Error("_total_size is NULL");
          }

          if (_next_offset < _total_size) {
            fetchNextPart();
          } else {
            save();
            completeProgress(videoId);
          }
        })
        .catch((reason) => {
          logger.error(reason, fileName);
          AbortProgress(videoId);
        });
    };

    const save = () => {
      logger.info("Finish downloading blobs", fileName);
      logger.info("Concatenating blobs and uploading to NAS...", fileName);

      const uploadToNas = async () => {
        const total = _blobs.length;
        for (let i = 0; i < total; i++) {
          const res = await fetch("/dl/upload", {
            method: "POST",
            headers: {
              "X-Filename": encodeURIComponent(fileName),
              "X-Part": i,
              "X-Parts": total,
            },
            body: _blobs[i],
          });
          if (!res.ok) {
            throw new Error(nasErrorHint(res.status) + " (" + res.status + ")");
          }
        }
        logger.info(
          "Uploaded " + total + " part(s) to NAS",
          fileName
        );
        showNasToast(fileName + " 已保存到 NAS");
      };

      uploadToNas().catch((reason) => {
        logger.error(reason, fileName);
        AbortProgress(videoId);
      });
    };

    fetchNextPart();
    createProgressBar(videoId);
  };

  const tel_download_audio = (url) => {
    let _blobs = [];
    let _next_offset = 0;
    let _total_size = null;
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
            logger.error(
              "Non 200/206 response was received: " + res.status,
              fileName
            );
            return;
          }

          const mime = res.headers.get("Content-Type").split(";")[0];
          if (!mime.startsWith("audio/")) {
            logger.error(
              "Get non audio response with MIME type " + mime,
              fileName
            );
            throw "Get non audio response with MIME type " + mime;
          }

          try {
            const match = res.headers
              .get("Content-Range")
              .match(contentRangeRegex);

            const startOffset = parseInt(match[1]);
            const endOffset = parseInt(match[2]);
            const totalSize = parseInt(match[3]);

            if (startOffset !== _next_offset) {
              logger.error("Gap detected between responses.");
              logger.info("Last offset: " + _next_offset);
              logger.info("New start offset " + match[1]);
              throw "Gap detected between responses.";
            }
            if (_total_size && totalSize !== _total_size) {
              logger.error("Total size differs");
              throw "Total size differs";
            }

            _next_offset = endOffset + 1;
            _total_size = totalSize;
          } finally {
            logger.info(
              `Get response: ${res.headers.get(
                "Content-Length"
              )} bytes data from ${res.headers.get("Content-Range")}`
            );
            return res.blob();
          }
        })
        .then((resBlob) => {
          _blobs.push(resBlob);
        })
        .then(() => {
          if (_next_offset < _total_size) {
            fetchNextPart();
          } else {
            save();
          }
        })
        .catch((reason) => {
          logger.error(reason, fileName);
        });
    };

    const save = () => {
      logger.info(
        "Finish downloading blobs. Uploading to NAS...",
        fileName
      );

      const uploadToNas = async () => {
        const total = _blobs.length;
        for (let i = 0; i < total; i++) {
          const res = await fetch("/dl/upload", {
            method: "POST",
            headers: {
              "X-Filename": encodeURIComponent(fileName),
              "X-Part": i,
              "X-Parts": total,
            },
            body: _blobs[i],
          });
          if (!res.ok) {
            throw new Error(nasErrorHint(res.status) + " (" + res.status + ")");
          }
        }
        logger.info(
          "Uploaded " + total + " part(s) to NAS",
          fileName
        );
        showNasToast(fileName + " 已保存到 NAS");
      };

      uploadToNas().catch((reason) => {
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
        downloadButton.onclick = () => {
          tel_download_video(getVideoUrl(mediaAspecter.querySelector("video")));
        };
        brControls.prepend(downloadButton);
      }
    } else if (mediaAspecter.querySelector("video")) {
      // 2. Video HTML element detected, could be either GIF or unloaded video
      // container > video[src]
      const downloadButton = makeNasButton();
      downloadButton.onclick = () => {
        tel_download_video(getVideoUrl(mediaAspecter.querySelector("video")));
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

  setupDownloadManager();

  // Verification hook: check in a browser console with
  //   window.__TEL_DOWNLOADER__
  window.__TEL_DOWNLOADER__ = true;

  logger.info("Completed script setup.");
})();
