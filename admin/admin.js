(function () {
  "use strict";

  var API = "/admin/api";
  var state = null;
  var token = null;
  var pollTimer = null;
  var dragSrcId = null;

  function $(sel) {
    return document.querySelector(sel);
  }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /* ---------- token ---------- */

  function initToken() {
    var params = new URLSearchParams(window.location.search);
    var urlToken = params.get("token");
    if (urlToken) {
      sessionStorage.setItem("admin_token", urlToken);
      token = urlToken;
      var clean = new URL(window.location.href);
      clean.searchParams.delete("token");
      window.history.replaceState({}, "", clean.toString());
    } else {
      token = sessionStorage.getItem("admin_token");
    }
  }

  function clearToken() {
    sessionStorage.removeItem("admin_token");
    token = null;
  }

  /* ---------- api ---------- */

  function api(path, options) {
    options = options || {};
    var headers = { "X-Admin-Token": token || "" };
    var extra = options.headers || {};
    Object.keys(extra).forEach(function (k) {
      headers[k] = extra[k];
    });
    if (options.body && !headers["content-type"]) {
      headers["content-type"] = "application/json";
    }
    return fetch(API + path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = text;
        try {
          data = JSON.parse(text);
        } catch (e) {
          /* keep raw */
        }
        return { status: res.status, body: data };
      });
    });
  }

  /* ---------- dom helpers ---------- */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k === "html") {
          /* intentionally unsupported */
        } else if (k.indexOf("on") === 0 && typeof v === "function") {
          node.addEventListener(k.slice(2), v);
        } else if (k === "dataset" && v && typeof v === "object") {
          Object.keys(v).forEach(function (dk) {
            node.dataset[dk] = v[dk];
          });
        } else if (v !== null && v !== undefined && v !== false) {
          node.setAttribute(k, v === true ? "" : v);
        }
      });
    }
    if (children) {
      var list = Array.isArray(children) ? children : [children];
      list.forEach(function (c) {
        if (c === null || c === undefined) return;
        node.appendChild(
          typeof c === "string" ? document.createTextNode(c) : c,
        );
      });
    }
    return node;
  }

  function svgIcon(path) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.style.width = "16px";
    svg.style.height = "16px";
    var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("fill", "currentColor");
    p.setAttribute("d", path);
    svg.appendChild(p);
    return svg;
  }

  var ICONS = {
    up: "M7 14l5-5 5 5H7z",
    down: "M7 10l5 5 5-5H7z",
    trash: "M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
    edit: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
    test: "M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm-1 14.5l-4-4 1.41-1.41L11 13.67l5.59-5.58L18 9.5l-7 7z",
  };

  /* ---------- toast ---------- */

  var toastTimer = null;
  function toast(message, type) {
    var t = $("#toast");
    t.textContent = message;
    t.className = "toast " + (type || "");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.className = "toast hidden";
    }, 4000);
  }

  /* ---------- state load ---------- */

  function loadState() {
    return api("/state").then(function (r) {
      if (r.status === 401) {
        clearToken();
        $("#token-warning").classList.remove("hidden");
        $("#app").classList.add("hidden");
        return null;
      }
      if (r.status >= 400) {
        toast(errorMessage(r.body), "error");
        return null;
      }
      $("#token-warning").classList.add("hidden");
      $("#app").classList.remove("hidden");
      state = r.body;
      return state;
    });
  }

  function errorMessage(body) {
    if (body && body.error) {
      if (Array.isArray(body.error.errors) && body.error.errors.length) {
        return body.error.errors.map(function (e) { return "• " + e; }).join("\n");
      }
      if (body.error.message) return body.error.message;
    }
    if (body && Array.isArray(body.errors) && body.errors.length) {
      return body.errors.map(function (e) { return "• " + e; }).join("\n");
    }
    if (body && body.message) return body.message;
    if (typeof body === "string") return body;
    return "Erro desconhecido.";
  }

  function providerKeyLabel(p) {
    if (p.keySource === "stored") return "armazenada localmente";
    if (p.keySource === "env") return "variável de ambiente " + (p.apiKeyEnv || "");
    return "ausente";
  }

  function cooldownBadge(p) {
    if (p.cooldownUntil && p.cooldownUntil > Date.now()) {
      return el("span", { class: "badge cooldown", text: "cooldown ativo" });
    }
    if (p.online === false) {
      return el("span", { class: "badge offline", text: "offline" });
    }
    return null;
  }

  /* ---------- render routing ---------- */

  function providerOptions(selectedId, includeEmpty) {
    var opts = [];
    if (includeEmpty) {
      opts.push(el("option", { value: "", text: "(nenhum)" }));
    }
    Object.keys(state.providers || {}).forEach(function (id) {
      opts.push(
        el("option", {
          value: id,
          text: state.providers[id].name + " (" + id + ")",
          selected: id === selectedId ? "" : null,
        }),
      );
    });
    return opts;
  }

  function renderRouting() {
    $("#mode").value = state.mode || "auto";
    var manual = $("#manual-provider");
    clearChildren(manual);
    providerOptions(state.manualProvider || "").forEach(function (o) {
      manual.appendChild(o);
    });
    $("#manual-provider-field").style.display =
      state.mode === "manual" ? "" : "none";

    var normal = $("#normal-provider");
    clearChildren(normal);
    providerOptions(state.normalProvider || "", true).forEach(function (o) {
      normal.appendChild(o);
    });

    var large = $("#large-provider");
    clearChildren(large);
    providerOptions(state.largeContextProvider || "", true).forEach(function (o) {
      large.appendChild(o);
    });

    $("#large-threshold").value = state.largeContextThreshold || "";
  }

  /* ---------- render order ---------- */

  function renderOrder() {
    var list = $("#order-list");
    clearChildren(list);
    var order = state.fallbackOrder || [];
    order.forEach(function (id, idx) {
      var p = state.providers[id];
      if (!p) return;
      var item = el("li", {
        class: "order-item",
        draggable: "true",
        dataset: { id: id },
      });
      item.addEventListener("dragstart", function () {
        dragSrcId = id;
        item.classList.add("dragging");
      });
      item.addEventListener("dragend", function () {
        item.classList.remove("dragging");
        dragSrcId = null;
      });
      item.addEventListener("dragover", function (e) {
        e.preventDefault();
      });
      item.addEventListener("drop", function (e) {
        e.preventDefault();
        if (!dragSrcId || dragSrcId === id) return;
        var newOrder = order.slice();
        var from = newOrder.indexOf(dragSrcId);
        newOrder.splice(from, 1);
        var to = newOrder.indexOf(id);
        newOrder.splice(to, 0, dragSrcId);
        state.fallbackOrder = newOrder;
        renderOrder();
      });

      var idxSpan = el("span", {
        class: "badge",
        text: String(idx + 1),
      });
      var nameSpan = el("span", { class: "name", text: p.name + " (" + id + ")" });
      var cd = cooldownBadge(p);

      var upBtn = el("button", {
        type: "button",
        class: "icon-btn",
        "aria-label": "Subir " + p.name,
        disabled: idx === 0 ? "" : null,
      });
      upBtn.appendChild(svgIcon(ICONS.up));
      upBtn.addEventListener("click", function () {
        moveOrder(id, -1);
      });

      var downBtn = el("button", {
        type: "button",
        class: "icon-btn",
        "aria-label": "Descer " + p.name,
        disabled: idx === order.length - 1 ? "" : null,
      });
      downBtn.appendChild(svgIcon(ICONS.down));
      downBtn.addEventListener("click", function () {
        moveOrder(id, 1);
      });

      item.appendChild(idxSpan);
      item.appendChild(nameSpan);
      if (cd) item.appendChild(cd);
      item.appendChild(upBtn);
      item.appendChild(downBtn);
      list.appendChild(item);
    });
  }

  function moveOrder(id, delta) {
    var order = state.fallbackOrder.slice();
    var i = order.indexOf(id);
    var j = i + delta;
    if (j < 0 || j >= order.length) return;
    var tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
    state.fallbackOrder = order;
    renderOrder();
  }

  /* ---------- render providers ---------- */

  function renderProviders() {
    var container = $("#providers-list");
    clearChildren(container);
    var order = state.fallbackOrder || [];
    var ids = order.slice();
    Object.keys(state.providers || {}).forEach(function (id) {
      if (ids.indexOf(id) === -1) ids.push(id);
    });

    ids.forEach(function (id) {
      var p = state.providers[id];
      if (!p) return;
      var card = el("div", { class: "provider-card" });

      var head = el("div", { class: "p-head" });
      var titleWrap = el("div", {});
      titleWrap.appendChild(el("div", { class: "p-name", text: p.name }));
      titleWrap.appendChild(el("div", { class: "p-id", text: id }));
      head.appendChild(titleWrap);
      var statusBadge = cooldownBadge(p);
      if (statusBadge) head.appendChild(statusBadge);
      card.appendChild(head);

      var meta = el("div", { class: "p-meta" });
      meta.appendChild(
        el("div", {
          text: "modelo: " + p.model + " • " + p.baseUrl,
        }),
      );
      var keyText =
        "chave: " +
        providerKeyLabel(p) +
        (p.keyLast4 ? " (…" + p.keyLast4 + ")" : "");
      meta.appendChild(el("div", { text: keyText }));
      if (p.timeoutMs) {
        meta.appendChild(
          el("div", { text: "timeout: " + p.timeoutMs + " ms" }),
        );
      }
      card.appendChild(meta);

      var actions = el("div", { class: "p-actions" });

      var editBtn = el("button", {
        type: "button",
        class: "secondary",
        "aria-label": "Editar " + p.name,
      });
      editBtn.appendChild(svgIcon(ICONS.edit));
      editBtn.appendChild(document.createTextNode(" Editar"));
      editBtn.addEventListener("click", function () {
        openForm(id);
      });

      var testBtn = el("button", {
        type: "button",
        class: "secondary",
        "aria-label": "Testar conexão de " + p.name,
      });
      testBtn.appendChild(svgIcon(ICONS.test));
      testBtn.appendChild(document.createTextNode(" Testar"));
      testBtn.addEventListener("click", function () {
        testConnection(id, card);
      });

      var delBtn = el("button", {
        type: "button",
        class: "danger",
        "aria-label": "Excluir " + p.name,
      });
      delBtn.appendChild(svgIcon(ICONS.trash));
      delBtn.appendChild(document.createTextNode(" Excluir"));
      delBtn.addEventListener("click", function () {
        deleteProvider(id);
      });

      actions.appendChild(editBtn);
      actions.appendChild(testBtn);
      actions.appendChild(delBtn);
      card.appendChild(actions);

      container.appendChild(card);
    });
  }

  /* ---------- form ---------- */

  var editingId = null;
  var headerRows = [];

  function openForm(id) {
    editingId = id || null;
    var title = $("#modal-title");
    title.textContent = id ? "Editar provider" : "Novo provider";
    var p = id ? state.providers[id] : null;

    $("#f-id").value = p ? id : "";
    $("#f-id").disabled = !!id;
    $("#f-name").value = p ? p.name || "" : "";
    $("#f-baseurl").value = p ? p.baseUrl || "" : "";
    $("#f-model").value = p ? p.model || "" : "";
    $("#f-timeout").value = p && p.timeoutMs ? p.timeoutMs : "";
    $("#f-key").value = "";
    $("#f-key-hint").textContent = id
      ? "Deixe em branco para manter a chave atual (" + providerKeyLabel(p) + ")."
      : "Opcional na criação; se preenchida, é armazenada localmente.";

    renderHeaders(p ? p.headers : null);
    $("#remove-key").style.display = id && p && p.keySource === "stored" ? "" : "none";

    $("#modal").classList.remove("hidden");
    $("#f-name").focus();
  }

  function closeForm() {
    $("#modal").classList.add("hidden");
    editingId = null;
    headerRows = [];
    $("#provider-form").reset();
  }

  function renderHeaders(headers) {
    var list = $("#headers-list");
    clearChildren(list);
    headerRows = [];
    var entries = [];
    if (headers && typeof headers === "object") {
      Object.keys(headers).forEach(function (k) {
        entries.push([k, headers[k]]);
      });
    }
    if (entries.length === 0) entries.push(["", ""]);
    entries.forEach(function (pair) {
      addHeaderRow(pair[0], pair[1]);
    });
  }

  function addHeaderRow(k, v) {
    var row = el("div", { class: "header-row" });
    var keyInput = el("input", {
      type: "text",
      placeholder: "nome",
      autocomplete: "off",
      spellcheck: "false",
      value: k || "",
    });
    var valInput = el("input", {
      type: "text",
      placeholder: "valor",
      autocomplete: "off",
      spellcheck: "false",
      value: v || "",
    });
    var remove = el("button", {
      type: "button",
      class: "icon-btn",
      text: "✕",
      "aria-label": "Remover header",
    });
    remove.addEventListener("click", function () {
      row.remove();
      headerRows = headerRows.filter(function (r) {
        return r !== row;
      });
    });
    row.appendChild(keyInput);
    row.appendChild(valInput);
    row.appendChild(remove);
    $("#headers-list").appendChild(row);
    headerRows.push(row);
  }

  function collectHeaders() {
    var headers = {};
    var hasAny = false;
    headerRows.forEach(function (row) {
      var inputs = row.querySelectorAll("input");
      var k = (inputs[0].value || "").trim();
      var v = inputs[1].value;
      if (k) {
        headers[k] = v;
        hasAny = true;
      }
    });
    return hasAny ? headers : null;
  }

  function saveProvider(andTest) {
    var id = $("#f-id").value.trim();
    var name = $("#f-name").value.trim();
    var baseUrl = $("#f-baseurl").value.trim();
    var model = $("#f-model").value.trim();
    var timeoutRaw = $("#f-timeout").value;
    var key = $("#f-key").value;
    var headers = collectHeaders();

    if (!editingId && !id) {
      toast("Informe o ID do provider.", "error");
      return;
    }
    if (!baseUrl || !model) {
      toast("baseUrl e modelo são obrigatórios.", "error");
      return;
    }

    var body = { name: name || id, baseUrl: baseUrl, model: model };
    if (timeoutRaw) body.timeoutMs = Number(timeoutRaw);
    if (headers) body.headers = headers;
    if (key) body.apiKey = key;

    var method = editingId ? "PUT" : "POST";
    var path = editingId
      ? "/providers/" + encodeURIComponent(editingId)
      : "/providers";

    api(path, { method: method, body: body })
      .then(function (r) {
        $("#f-key").value = "";
        if (r.status >= 400) {
          toast(errorMessage(r.body), "error");
          return;
        }
        toast("Provider salvo com sucesso.", "success");
        closeForm();
        return loadState().then(function () {
          renderAll();
          if (andTest) {
            var pid = editingId || id;
            testConnection(pid);
          }
        });
      })
      .catch(function (e) {
        $("#f-key").value = "";
        toast("Erro de rede: " + e.message, "error");
      });
  }

  function removeStoredKey() {
    if (!editingId) return;
    api("/key/" + encodeURIComponent(editingId), { method: "DELETE" })
      .then(function (r) {
        if (r.status >= 400) {
          toast(errorMessage(r.body), "error");
          return;
        }
        toast("Chave removida. A variável de ambiente volta a valer, se existir.", "success");
        return loadState().then(function () {
          renderAll();
          var p = state.providers[editingId];
          if (p) {
            $("#f-key-hint").textContent =
              "Deixe em branco para manter a chave atual (" + providerKeyLabel(p) + ").";
          }
          $("#remove-key").style.display = "none";
        });
      })
      .catch(function (e) {
        toast("Erro de rede: " + e.message, "error");
      });
  }

  function testConnection(id, card) {
    var target = card || $("#providers-list");
    var existing = target.querySelector(".test-result");
    if (existing) existing.remove();
    var box = el("div", { class: "test-result", text: "testando…" });
    target.appendChild(box);

    api("/providers/" + encodeURIComponent(id) + "/test", { method: "POST" })
      .then(function (r) {
        if (r.status >= 400) {
          box.className = "test-result fail";
          box.textContent = "falhou: " + errorMessage(r.body);
          return;
        }
        var b = r.body || {};
        box.className = b.ok ? "test-result ok" : "test-result fail";
        var parts = [];
        parts.push(b.ok ? "ok" : "falhou");
        if (b.status) parts.push("HTTP " + b.status);
        if (b.latencyMs != null) parts.push(b.latencyMs + " ms");
        if (b.message) parts.push(b.message);
        box.textContent = parts.join(" • ");
      })
      .catch(function (e) {
        box.className = "test-result fail";
        box.textContent = "erro de rede: " + e.message;
      });
  }

  function deleteProvider(id) {
    var p = state.providers[id];
    var msg =
      'Remover o provider "' +
      (p ? p.name : id) +
      '"? Esta ação não pode ser desfeita.';
    if (!window.confirm(msg)) return;

    api("/providers/" + encodeURIComponent(id), { method: "DELETE" })
      .then(function (r) {
        if (r.status === 409) {
          toast(errorMessage(r.body), "error");
          return;
        }
        if (r.status >= 400) {
          toast(errorMessage(r.body), "error");
          return;
        }
        toast("Provider removido.", "success");
        return loadState().then(function () {
          renderAll();
        });
      })
      .catch(function (e) {
        toast("Erro de rede: " + e.message, "error");
      });
  }

  /* ---------- save actions ---------- */

  function saveMode() {
    var mode = $("#mode").value;
    var body = { mode: mode };
    if (mode === "manual") {
      body.provider = $("#manual-provider").value;
    }
    api("/mode", { method: "PUT", body: body })
      .then(function (r) {
        if (r.status >= 400) {
          toast(errorMessage(r.body), "error");
          return;
        }
        toast("Modo salvo.", "success");
        return loadState().then(renderAll);
      })
      .catch(function (e) {
        toast("Erro de rede: " + e.message, "error");
      });
  }

  function saveRouting() {
    var body = {
      normalProvider: $("#normal-provider").value || null,
      largeContextProvider: $("#large-provider").value || null,
    };
    var threshold = $("#large-threshold").value;
    if (threshold) body.largeContextThreshold = Number(threshold);

    api("/routing", { method: "PUT", body: body })
      .then(function (r) {
        if (r.status >= 400) {
          toast(errorMessage(r.body), "error");
          return;
        }
        toast("Roteamento salvo.", "success");
        return loadState().then(renderAll);
      })
      .catch(function (e) {
        toast("Erro de rede: " + e.message, "error");
      });
  }

  function saveOrder() {
    api("/order", {
      method: "PUT",
      body: { fallbackOrder: state.fallbackOrder },
    })
      .then(function (r) {
        if (r.status >= 400) {
          toast(errorMessage(r.body), "error");
          return;
        }
        toast("Ordem salva.", "success");
        return loadState().then(renderAll);
      })
      .catch(function (e) {
        toast("Erro de rede: " + e.message, "error");
      });
  }

  /* ---------- render all ---------- */

  function renderAll() {
    if (!state) return;
    renderRouting();
    renderOrder();
    renderProviders();
  }

  /* ---------- polling ---------- */

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (document.hidden) return;
      loadState().then(function (s) {
        if (s) renderAll();
      });
    }, 5000);
  }

  /* ---------- wiring ---------- */

  function initTabs() {
    var tabs = document.querySelectorAll(".tab-btn");
    var activeTab = sessionStorage.getItem("admin_active_tab") || "tab-providers";

    function selectTab(targetId) {
      tabs.forEach(function (btn) {
        var isTarget = btn.getAttribute("data-tab") === targetId;
        btn.classList.toggle("active", isTarget);
        btn.setAttribute("aria-selected", isTarget ? "true" : "false");
      });
      document.querySelectorAll(".tab-pane").forEach(function (pane) {
        pane.classList.toggle("active", pane.id === targetId);
      });
      sessionStorage.setItem("admin_active_tab", targetId);
    }

    tabs.forEach(function (btn) {
      btn.addEventListener("click", function () {
        selectTab(btn.getAttribute("data-tab"));
      });
    });

    selectTab(activeTab);
  }

  document.addEventListener("DOMContentLoaded", function () {
    initToken();
    initTabs();

    $("#mode").addEventListener("change", function () {
      $("#manual-provider-field").style.display =
        $("#mode").value === "manual" ? "" : "none";
    });

    $("#save-mode").addEventListener("click", saveMode);
    $("#save-routing").addEventListener("click", saveRouting);
    $("#save-order").addEventListener("click", saveOrder);
    $("#new-provider").addEventListener("click", function () {
      openForm(null);
    });

    $("#modal-close").addEventListener("click", closeForm);
    $("#modal").addEventListener("click", function (e) {
      if (e.target === $("#modal")) closeForm();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !$("#modal").classList.contains("hidden")) {
        closeForm();
      }
    });

    $("#add-header").addEventListener("click", function () {
      addHeaderRow("", "");
    });

    $("#provider-form").addEventListener("submit", function (e) {
      e.preventDefault();
      saveProvider(false);
    });

    $("#save-test").addEventListener("click", function (e) {
      e.preventDefault();
      saveProvider(true);
    });

    $("#remove-key").addEventListener("click", function (e) {
      e.preventDefault();
      removeStoredKey();
    });

    loadState().then(function (s) {
      if (s) {
        renderAll();
        startPolling();
      }
    });
  });
})();
