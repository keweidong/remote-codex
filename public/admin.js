const $ = (id) => document.getElementById(id);
let status = null,
  expiresAt = 0,
  lastTunnelUrl = "",
  lastRelayUrl = "";
let token = new URLSearchParams(location.hash.slice(1)).get("token");
if (location.hash) history.replaceState(null, "", location.pathname);
function toast(text) {
  $("toast").textContent = text;
  $("toast").classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("toast").classList.add("hidden"), 4000);
}
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}
function clearPair() {
  $("qr").classList.add("hidden");
  $("qr-placeholder").classList.remove("hidden");
  $("pair-link-row").classList.add("hidden");
  $("pair-link").value = "";
  $("qr").removeAttribute("src");
  expiresAt = 0;
  $("expires").textContent = "";
}
function render(data) {
  status = data;
  $("admin-content").classList.remove("hidden");
  $("readiness").textContent = "本机服务已就绪";
  $("readiness").classList.add("running");
  $("admin-error").textContent = "";
  const select = $("base-url"),
    previous = select.value;
  const options = [
    ...data.lanUrls.map((url) => ({ url, label: "同一 Wi-Fi · " + url })),
    { url: data.localUrl, label: "仅本机预览 · " + data.localUrl },
  ];
  if (data.tunnel.url)
    options.unshift({
      url: data.tunnel.url,
      label: "外网访问 · " + data.tunnel.url,
    });
  const relayUrl = (data.relay && data.relay.url) || "";
  if (relayUrl)
    options.unshift({
      url: relayUrl,
      label: "公网固定地址 · " + relayUrl,
    });
  const nextSignature = JSON.stringify(options);
  if (select.dataset.signature !== nextSignature) {
    select.replaceChildren(...options.map((o) => new Option(o.label, o.url)));
    select.dataset.signature = nextSignature;
    if (options.some((o) => o.url === previous)) select.value = previous;
    if (data.tunnel.url && data.tunnel.url !== lastTunnelUrl)
      select.value = data.tunnel.url;
    // The stable relay origin wins over the raw quick URL for QR pairing.
    if (relayUrl && relayUrl !== lastRelayUrl) select.value = relayUrl;
    clearPair();
  }
  lastTunnelUrl = data.tunnel.url;
  lastRelayUrl = relayUrl;
  addressHint();
  const t = data.tunnel;
  $("tunnel-description").textContent = t.fixed
    ? t.autostart
      ? "已配置固定域名；启动电脑服务时会自动连接 Cloudflare 隧道。"
      : "已配置固定域名；点击下方按钮连接 Cloudflare 隧道。"
    : "手机不在同一 Wi-Fi 时，可以开启临时 Cloudflare 隧道。";
  $("tunnel-hint").textContent = t.fixed
    ? "固定域名重启后不变。首次改用此域名时请重新扫码，之后保持电脑服务运行即可继续使用。流量经 Cloudflare 转发；管理页不会公开。"
    : data.relay && data.relay.status === "running"
      ? "临时地址本身会变，但下方中继固定地址不变：用固定地址配对一次即可跨重启使用。流量经中继与 Cloudflare 转发；管理页不会公开。"
      : "临时地址在重新启动隧道后会变化，需要重新扫码。流量经 Cloudflare 转发；管理页不会公开。";
  $("tunnel-state").textContent =
    {
      stopped: "未开启",
      starting: "启动中",
      running: t.fixed ? "固定隧道已连接" : "隧道已启动",
      reconnecting: "正在重新连接",
      error: "启动失败",
    }[t.status] || t.status;
  $("tunnel-state").className =
    "status " + (t.status === "running" ? "running" : "");
  $("tunnel-url").textContent = t.url || "开启后显示公网地址";
  $("tunnel-error").textContent = t.error || "";
  $("start-tunnel").disabled =
    ["starting", "running", "reconnecting"].includes(t.status) || !t.available;
  $("start-tunnel").textContent =
    t.status === "starting" || t.status === "reconnecting"
      ? "等待 Cloudflare…"
      : t.fixed
        ? "连接固定域名"
        : "开启外网访问";
  $("stop-tunnel").classList.toggle(
    "hidden",
    !["starting", "running", "reconnecting"].includes(t.status),
  );
  if (!t.available)
    $("tunnel-error").textContent =
      "尚未找到 cloudflared。首次启动会自动在后台下载，请稍后重试；也可配置 CLOUDFLARED_PATH 指定自己的副本。";
  const r = data.relay || {};
  $("relay-row").classList.toggle("hidden", !r.configured);
  if (r.configured) {
    $("relay-state").textContent =
      {
        disabled: "未启用",
        idle: "等待隧道",
        registering: "正在注册",
        running: "已注册",
        failed: "注册失败",
      }[r.status] || r.status || "";
    $("relay-state").className =
      "status " + (r.status === "running" ? "running" : "");
    $("relay-url").textContent = r.url || "开启临时隧道后显示固定地址";
    $("relay-error").textContent = r.error || "";
  }
  $("device-count").textContent = data.devices.length + " 台";
  const deviceSignature = JSON.stringify(
    data.devices.map((d) => [d.id, d.name, d.baseUrl, Math.floor(d.lastSeen / 60000)]),
  );
  if ($("devices").dataset.signature !== deviceSignature) {
    $("devices").dataset.signature = deviceSignature;
    $("devices").replaceChildren();
    for (const device of data.devices) {
      const row = document.createElement("div");
      row.className = "device-row";
      const copy = document.createElement("div"),
        name = document.createElement("strong"),
        detail = document.createElement("div");
      name.textContent = device.name;
      detail.className = "small muted";
      detail.textContent =
        "最近访问 " + new Date(device.lastSeen).toLocaleString("zh-CN") +
        (device.baseUrl ? " · 配对地址 " + device.baseUrl : "");
      copy.append(name, detail);
      const button = document.createElement("button");
      button.className = "danger-button";
      button.textContent = "撤销";
      button.onclick = async () => {
        try {
          await api("/admin/devices/" + device.id, {
            method: "DELETE",
            body: "{}",
          });
          toast("设备授权已撤销");
          await refresh();
        } catch (e) {
          toast(e.message);
        }
      };
      row.append(copy, button);
      $("devices").append(row);
    }
    if (!data.devices.length) {
      const text = document.createElement("p");
      text.className = "muted empty-list";
      text.textContent = "还没有配对设备。用手机扫描左侧二维码开始。";
      $("devices").append(text);
    }
  }
}
function addressHint() {
  const url = $("base-url").value;
  $("address-hint").textContent =
    status?.relay?.url && url === status.relay.url
    ? "公网固定地址：配对一次后跨服务重启有效，手机书签不变；流量经中继与 Cloudflare 转发。"
    : status?.tunnel?.fixed && url === status.tunnel.url
    ? "固定域名可用手机流量访问；在此地址配对一次后，重启服务仍可使用。"
    : url.includes("trycloudflare.com")
      ? "手机可使用流量或其他 Wi-Fi；临时地址重启后需重新配对。"
    : url.includes("127.0.0.1")
      ? "这个地址只用于电脑预览。手机请选局域网地址或开启外网访问。"
      : "手机与电脑需在同一网络，并允许 Windows 防火墙访问 TCP 8766 端口。";
}
async function refresh() {
  try {
    render(await api("/admin/status"));
  } catch (e) {
    $("admin-error").textContent = e.message;
    $("readiness").textContent = "连接不可用";
  }
}
$("base-url").onchange = () => {
  clearPair();
  addressHint();
};
$("create-pair").onclick = async () => {
  $("create-pair").disabled = true;
  try {
    const data = await api("/admin/pair", {
      method: "POST",
      body: JSON.stringify({ baseUrl: $("base-url").value }),
    });
    $("qr").src = data.qr;
    $("qr").classList.remove("hidden");
    $("qr-placeholder").classList.add("hidden");
    $("pair-link").value = data.url;
    $("preview-link").href = data.url;
    $("pair-link-row").classList.remove("hidden");
    expiresAt = data.expiresAt;
  } catch (e) {
    toast(e.message);
  } finally {
    $("create-pair").disabled = false;
  }
};
$("copy-link").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("pair-link").value);
    toast("配对链接已复制");
  } catch {
    $("pair-link").select();
    toast("请手动复制选中的链接");
  }
};
for (const [id, action] of [
  ["start-tunnel", "start"],
  ["stop-tunnel", "stop"],
])
  $(id).onclick = async () => {
    $(id).disabled = true;
    clearPair();
    try {
      await api("/admin/tunnel", {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      await refresh();
    } catch (e) {
      toast(e.message);
    } finally {
      $(id).disabled = false;
    }
  };
setInterval(() => {
  if (expiresAt) {
    const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    $("expires").textContent = left
      ? `有效期 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`
      : "二维码已过期";
  }
  if (!document.hidden) refresh();
}, 4000);
try {
  if (token) {
    await api("/admin/login", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    token = null;
  }
  await refresh();
} catch (e) {
  $("admin-error").textContent = e.message;
  $("readiness").textContent = "请重新运行启动脚本";
}
