const state = {
  categories: [],
  categoryTree: [],
  boomCategories: [],
  boomCategoryTree: [],
  configUnits: [],
  page: 1,
  pageSize: 20,
  total: 0,
  selectedTreeCategoryId: null,
  selectedTreeProductId: null,
  draggingTreeProductId: null,
  treeDropCategoryId: null,
  movingTreeProductId: null,
  selectedBoomBaseCategoryId: null,
  selectedProductMainImagePath: null,
  expandedCategoryIds: new Set(),
  categoryAction: "add",
  categoryAddMode: "child",
  boomCategoryAction: "add",
  boomCategoryAddMode: "child",
  materialProducts: [],
  recycleBinProducts: [],
  recycleExpandedCategoryIds: new Set(),
  packagingExpandedCategoryIds: new Set(),
  boomBaseItems: [],
  quoteLines: [],
  currentProductSpecs: [],
  currentProductBomItems: [],
  currentProductBoomBaseItems: [],
  currentProductBomTotalCost: 0,
  editingProductSpecId: null,
  editingBomItemId: null,
  editingBoomBaseItemId: null,
  editingConfigUnitId: null,
};

function el(id) {
  return document.getElementById(id);
}

function toast(message) {
  const node = el("toast");
  node.textContent = message;
  node.classList.add("show");
  window.setTimeout(() => node.classList.remove("show"), 2200);
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || "请求失败");
    err.payload = data;
    throw err;
  }
  return data;
}

function parseFirstNumber(value) {
  const text = String(value || "").trim();
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function toMoney(value) {
  if (!Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

function setText(id, value) {
  const node = el(id);
  if (!node) return;
  node.textContent = value;
}

function setProductCodeError(message = "") {
  const node = el("productCodeError");
  if (!node) return;
  node.textContent = message;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDecimal(value, fractionDigits = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  if (Number.isInteger(number)) return String(number);
  return number.toFixed(fractionDigits).replace(/\.?0+$/, "");
}

function formatDateTime(value) {
  const text = String(value || "").trim();
  if (!text) return "-";
  return text.replace("T", " ").replace("Z", "");
}

function updateEditSelectedProductButtonState() {
  const button = el("editSelectedProductBtn");
  if (!button) return;
  button.disabled = !state.selectedTreeProductId;
}

function updateDeleteProductButtonState() {
  const button = el("deleteProductBtn");
  if (!button) return;
  button.disabled = !el("productId").value;
}

function updateBoomBaseSaveButtonState() {
  const saveBtn = el("saveBoomBaseItemBtn");
  if (!saveBtn) return;
  saveBtn.disabled = !state.selectedBoomBaseCategoryId;
}

function productDisplayName(product) {
  const name = product.chinese_name || product.name || "";
  return `${product.code} | ${name}`;
}

function getMaterialProductById(rawId) {
  const id = Number(rawId);
  if (!id) return null;
  return state.materialProducts.find((item) => item.id === id) || null;
}

function fillMaterialProductSelect(selectId, placeholder = "请选择产品") {
  const select = el(selectId);
  if (!select) return;

  const currentValue = select.value;
  let html = `<option value="">${placeholder}</option>`;
  for (const item of state.materialProducts) {
    html += `<option value="${item.id}">${productDisplayName(item)}</option>`;
  }

  select.innerHTML = html;
  if ([...select.options].some((option) => option.value === currentValue)) {
    select.value = currentValue;
    return;
  }

  if (state.materialProducts.length > 0) {
    select.value = String(state.materialProducts[0].id);
  }
}

function setActivePage(pageId, updateHash = true) {
  const target = document.getElementById(pageId);
  if (!target) return;

  document.querySelectorAll(".nav-level2[data-page]").forEach((link) => {
    link.classList.toggle("active", link.dataset.page === pageId);
  });
  document.querySelectorAll(".content-page").forEach((page) => {
    page.classList.toggle("active", page.id === pageId);
  });

  if (updateHash && window.location.hash !== `#${pageId}`) {
    window.history.replaceState(null, "", `#${pageId}`);
  }
}

function initSideNavigation() {
  const links = [...document.querySelectorAll(".nav-level2[data-page]")];
  if (!links.length) return;

  links.forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      setActivePage(link.dataset.page || links[0].dataset.page || "page-category-manage");
    });
  });

  const applyByHash = () => {
    const hash = window.location.hash.replace("#", "");
    const matched = links.find((link) => link.dataset.page === hash);
    if (matched) {
      setActivePage(hash, false);
      return;
    }
    setActivePage(links[0].dataset.page || "page-category-manage", false);
  };

  window.addEventListener("hashchange", applyByHash);
  applyByHash();
}

function buildPathMap(items) {
  const children = new Map();

  for (const item of items) {
    if (!children.has(item.parent_id ?? 0)) {
      children.set(item.parent_id ?? 0, []);
    }
    children.get(item.parent_id ?? 0).push(item);
  }

  const result = new Map();

  function walk(parentId, prefix) {
    const list = children.get(parentId) || [];
    for (const item of list) {
      const path = prefix ? `${prefix} / ${item.name}` : item.name;
      result.set(item.id, path);
      walk(item.id, path);
    }
  }

  walk(0, "");
  return result;
}

function categoryPathMap() {
  return buildPathMap(state.categories);
}

function boomCategoryPathMap() {
  return buildPathMap(state.boomCategories);
}

function fillCategorySelect(selectId, includeAll = false) {
  const select = el(selectId);
  if (!select) return;
  const pathMap = categoryPathMap();
  const currentValue = select.value;

  let html = "";
  if (includeAll) {
    html += '<option value="">全部目录</option>';
  } else {
    html += '<option value="">无</option>';
  }

  for (const category of state.categories) {
    const path = pathMap.get(category.id) || category.name;
    html += `<option value="${category.id}">${path}</option>`;
  }

  select.innerHTML = html;
  if ([...select.options].some((option) => option.value === currentValue)) {
    select.value = currentValue;
  }
}

function fillBoomCategorySelect(selectId, includeBlank = true) {
  const select = el(selectId);
  if (!select) return;
  const pathMap = boomCategoryPathMap();
  const currentValue = select.value;

  let html = includeBlank ? '<option value="">无</option>' : "";
  for (const category of state.boomCategories) {
    const path = pathMap.get(category.id) || category.name;
    html += `<option value="${category.id}">${path}</option>`;
  }

  select.innerHTML = html;
  if ([...select.options].some((option) => option.value === currentValue)) {
    select.value = currentValue;
    return;
  }
  select.value = "";
}

function renderBoomUnitSelect(selectedValue = "") {
  const select = el("boomBaseUnit");
  if (!select) return;

  let html = '<option value="">未设置</option>';
  for (const unit of state.configUnits) {
    html += `<option value="${escapeHtml(unit.name)}">${escapeHtml(unit.name)}</option>`;
  }
  if (
    selectedValue &&
    !state.configUnits.some((unit) => (unit.name || "").trim() === String(selectedValue).trim())
  ) {
    html += `<option value="${escapeHtml(selectedValue)}">${escapeHtml(selectedValue)}</option>`;
  }
  select.innerHTML = html;
  select.value = selectedValue || "";
}

function setCategoryAction(action) {
  const hasSelectedCategory = Boolean(state.selectedTreeCategoryId);
  const finalAction = !hasSelectedCategory && action !== "add" ? "add" : action;
  state.categoryAction = finalAction;

  document.querySelectorAll("[data-category-action]").forEach((button) => {
    const active = button.dataset.categoryAction === finalAction;
    button.classList.toggle("active", active);
    button.disabled = !hasSelectedCategory;
  });
}

function setCategoryAddMode(mode) {
  state.categoryAddMode = mode === "sibling" ? "sibling" : "child";
  const siblingBtn = el("categoryAddSiblingBtn");
  const childBtn = el("categoryAddChildBtn");
  if (siblingBtn) {
    siblingBtn.classList.toggle("active", state.categoryAddMode === "sibling");
  }
  if (childBtn) {
    childBtn.classList.toggle("active", state.categoryAddMode === "child");
  }
  updateCategoryAddTargetText();
}

function updateCategoryAddTargetText() {
  if (state.categoryAction !== "add") return;
  const target = el("categoryActionModalTarget");
  const current = state.categories.find((item) => item.id === state.selectedTreeCategoryId);
  const currentName = current?.name || `目录 #${state.selectedTreeCategoryId}`;
  if (state.categoryAddMode === "sibling") {
    target.textContent = `同级目录：与“${currentName}”同级`;
    return;
  }
  target.textContent = `父级目录：${currentName}`;
}

function openCategoryActionModal(action) {
  if (!state.selectedTreeCategoryId) {
    toast("请先在目录树选择类型");
    return;
  }

  setCategoryAction(action);
  const modal = el("categoryActionModal");
  const title = el("categoryActionModalTitle");
  const target = el("categoryActionModalTarget");
  const addModeRow = el("categoryAddModeRow");
  const inputRow = el("categoryActionInputRow");
  const input = el("categoryActionInput");
  const confirmBtn = el("categoryActionConfirmBtn");
  const current = state.categories.find((item) => item.id === state.selectedTreeCategoryId);
  const currentName = current?.name || `目录 #${state.selectedTreeCategoryId}`;

  if (state.categoryAction === "delete") {
    title.textContent = "删除目录";
    target.textContent = `将删除：${currentName}`;
    addModeRow.style.display = "none";
    inputRow.style.display = "none";
    input.value = "";
    confirmBtn.textContent = "确认删除";
    confirmBtn.classList.add("danger");
  } else if (state.categoryAction === "rename") {
    title.textContent = "修改目录";
    target.textContent = `当前目录：${currentName}`;
    addModeRow.style.display = "none";
    inputRow.style.display = "";
    input.value = current?.name || "";
    input.placeholder = "请输入新目录名称";
    confirmBtn.textContent = "确认修改";
    confirmBtn.classList.remove("danger");
    window.setTimeout(() => input.focus(), 0);
  } else {
    title.textContent = "新增目录";
    addModeRow.style.display = "";
    inputRow.style.display = "";
    input.value = "";
    input.placeholder = "请输入新目录名称";
    confirmBtn.textContent = "确认新增";
    confirmBtn.classList.remove("danger");
    setCategoryAddMode(state.categoryAddMode);
    window.setTimeout(() => input.focus(), 0);
  }

  modal.classList.add("show");
}

function closeCategoryActionModal() {
  el("categoryActionModal").classList.remove("show");
}

async function confirmCategoryActionFromModal() {
  await applyCategoryAction();
  closeCategoryActionModal();
}

function setBoomCategoryAction(action) {
  const hasSelectedCategory = Boolean(state.selectedBoomBaseCategoryId);
  const finalAction = !hasSelectedCategory && action !== "add" ? "add" : action;
  state.boomCategoryAction = finalAction;

  document.querySelectorAll("[data-boom-category-action]").forEach((button) => {
    const active = button.dataset.boomCategoryAction === finalAction;
    const isAddAction = button.dataset.boomCategoryAction === "add";
    button.classList.toggle("active", active);
    button.disabled = isAddAction ? false : !hasSelectedCategory;
  });
}

function setBoomCategoryAddMode(mode) {
  state.boomCategoryAddMode = mode === "sibling" ? "sibling" : "child";
  const siblingBtn = el("boomCategoryAddSiblingBtn");
  const childBtn = el("boomCategoryAddChildBtn");
  if (siblingBtn) {
    siblingBtn.classList.toggle("active", state.boomCategoryAddMode === "sibling");
  }
  if (childBtn) {
    childBtn.classList.toggle("active", state.boomCategoryAddMode === "child");
  }
  updateBoomCategoryAddTargetText();
}

function updateBoomCategoryAddTargetText() {
  if (state.boomCategoryAction !== "add") return;
  const target = el("boomCategoryActionModalTarget");
  if (!state.selectedBoomBaseCategoryId) {
    target.textContent = "当前无已选BOOM目录，将新增顶级目录";
    return;
  }
  const current = state.boomCategories.find((item) => item.id === state.selectedBoomBaseCategoryId);
  const currentName = current?.name || `BOOM目录 #${state.selectedBoomBaseCategoryId}`;
  if (state.boomCategoryAddMode === "sibling") {
    target.textContent = `同级目录：与“${currentName}”同级`;
    return;
  }
  target.textContent = `父级目录：${currentName}`;
}

function openBoomCategoryActionModal(action) {
  if (action !== "add" && !state.selectedBoomBaseCategoryId) {
    toast("请先在目录树选择BOOM目录");
    return;
  }

  setBoomCategoryAction(action);
  const modal = el("boomCategoryActionModal");
  const title = el("boomCategoryActionModalTitle");
  const target = el("boomCategoryActionModalTarget");
  const addModeRow = el("boomCategoryAddModeRow");
  const inputRow = el("boomCategoryActionInputRow");
  const input = el("boomCategoryActionInput");
  const confirmBtn = el("boomCategoryActionConfirmBtn");
  const current = state.boomCategories.find((item) => item.id === state.selectedBoomBaseCategoryId);
  const currentName = current?.name || `BOOM目录 #${state.selectedBoomBaseCategoryId}`;

  if (state.boomCategoryAction === "delete") {
    title.textContent = "删除BOOM目录";
    target.textContent = `将删除：${currentName}`;
    addModeRow.style.display = "none";
    inputRow.style.display = "none";
    input.value = "";
    confirmBtn.textContent = "确认删除";
    confirmBtn.classList.add("danger");
  } else if (state.boomCategoryAction === "rename") {
    title.textContent = "修改BOOM目录";
    target.textContent = `当前目录：${currentName}`;
    addModeRow.style.display = "none";
    inputRow.style.display = "";
    input.value = current?.name || "";
    input.placeholder = "请输入新目录名称";
    confirmBtn.textContent = "确认修改";
    confirmBtn.classList.remove("danger");
    window.setTimeout(() => input.focus(), 0);
  } else {
    title.textContent = "新增BOOM目录";
    addModeRow.style.display = state.selectedBoomBaseCategoryId ? "" : "none";
    inputRow.style.display = "";
    input.value = "";
    input.placeholder = "请输入新目录名称";
    confirmBtn.textContent = "确认新增";
    confirmBtn.classList.remove("danger");
    setBoomCategoryAddMode(state.boomCategoryAddMode);
    window.setTimeout(() => input.focus(), 0);
  }

  modal.classList.add("show");
}

function closeBoomCategoryActionModal() {
  el("boomCategoryActionModal").classList.remove("show");
}

async function confirmBoomCategoryActionFromModal() {
  await applyBoomCategoryAction();
  closeBoomCategoryActionModal();
}

function openProductCategoryMoveModal(productId) {
  const product = state.materialProducts.find((item) => item.id === productId);
  if (!product) {
    throw new Error("未找到要修改目录的产品");
  }
  if (!state.categories.length) {
    throw new Error("当前没有可选目录");
  }

  state.movingTreeProductId = productId;
  fillCategorySelect("productCategoryMoveSelect");
  el("productCategoryMoveSelect").value = product.category_id == null ? "" : String(product.category_id);
  el("productCategoryMoveHint").textContent = `当前产品：${product.code || "-"} | ${product.chinese_name || product.name || "-"}`;
  el("productCategoryMoveModal").classList.add("show");
}

function closeProductCategoryMoveModal() {
  state.movingTreeProductId = null;
  el("productCategoryMoveModal").classList.remove("show");
}

async function confirmProductCategoryMove() {
  const productId = Number(state.movingTreeProductId);
  if (!productId) {
    throw new Error("请选择要修改目录的商品");
  }
  const categoryId = Number(el("productCategoryMoveSelect").value);
  if (!categoryId) {
    throw new Error("请选择目标目录");
  }
  await moveTreeProductToCategory(productId, categoryId);
  closeProductCategoryMoveModal();
}

function renderCategoryTree() {
  const container = el("categoryTree");
  const parentMap = new Map();
  for (const category of state.categories) {
    parentMap.set(category.id, category.parent_id ?? null);
  }

  const subtreeProducts = new Map();
  for (const product of state.materialProducts) {
    let categoryId = product.category_id == null ? null : Number(product.category_id);
    const visited = new Set();
    while (categoryId && !visited.has(categoryId)) {
      visited.add(categoryId);
      if (!subtreeProducts.has(categoryId)) {
        subtreeProducts.set(categoryId, []);
      }
      subtreeProducts.get(categoryId).push(product);
      categoryId = parentMap.get(categoryId) ?? null;
    }
  }

  function renderNodes(nodes, depth = 0) {
    let html = "";
    for (const node of nodes) {
      const active = state.selectedTreeCategoryId === node.id ? "active" : "";
      const dropTarget = state.treeDropCategoryId === node.id ? "drag-target" : "";
      const products = subtreeProducts.get(node.id) || [];
      const hasContent = products.length > 0;
      const expanded = state.expandedCategoryIds.has(node.id);
      const sign = hasContent ? (expanded ? "-" : "+") : "·";
      const signClass = hasContent ? "tree-sign" : "tree-sign empty";
      const padding = 10 + depth * 14;
      html += `<li>
        <div
          class="tree-item ${active} ${dropTarget}"
          data-id="${node.id}"
          data-expandable="${hasContent ? "1" : "0"}"
          style="padding-left:${padding}px"
        >
          <span class="${signClass}">${sign}</span>
          <span>${node.name}</span>
        </div>
      `;
      if (node.children && node.children.length > 0) {
        html += `<ul class="tree">${renderNodes(node.children, depth + 1)}</ul>`;
      }
      if (expanded && products.length > 0) {
        html += '<ul class="tree-products">';
        html += products
          .map((product) => {
            const name = product.chinese_name || product.name || "-";
            const imageBlock = product.first_image
              ? `<img class="tree-product-thumb" src="/media-thumb/${product.first_image}?size=168" alt="${name}" />`
              : '<div class="tree-product-no-image">无图</div>';
            const activeProduct = state.selectedTreeProductId === product.id ? "active" : "";
            const draggingProduct = state.draggingTreeProductId === product.id ? "dragging" : "";
            return `
            <li class="tree-product-item ${activeProduct} ${draggingProduct}" data-product-id="${product.id}" draggable="true">
              <div class="tree-product-main">
                <div class="tree-product-media">
                  ${imageBlock}
                </div>
                <div class="tree-product-info">
                  <div class="tree-product-head">
                    <div class="tree-product-title">${product.code || "-"} | ${name}</div>
                    <div class="button-row">
                      <button type="button" class="tree-product-edit-btn" data-tree-edit-id="${product.id}">修改</button>
                      <button type="button" class="tree-product-edit-btn" data-tree-change-category-id="${product.id}">修改目录</button>
                    </div>
                  </div>
                  <div class="tree-product-grid">
                    <div>作用：${product.effect || "-"}</div>
                    <div>喷洒半径：${product.spray_radius || "-"}</div>
                    <div>单个重量：${product.unit_weight || "-"}</div>
                    <div>包装数量：${product.package_quantity || "-"}</div>
                    <div>包装尺寸：${product.package_size || "-"}</div>
                    <div>总重量：${product.gross_weight || "-"}</div>
                    <div>目录：${product.category_name || "-"}</div>
                  </div>
                </div>
              </div>
            </li>
            `;
          })
          .join("");
        html += "</ul>";
      }
      html += "</li>";
    }
    return html;
  }

  container.innerHTML = renderNodes(state.categoryTree);

  container.querySelectorAll(".tree-item").forEach((item) => {
    item.addEventListener("click", () => {
      const id = Number(item.dataset.id);
      state.selectedTreeCategoryId = id;
      state.selectedTreeProductId = null;
      updateEditSelectedProductButtonState();
      setCategoryAction(state.categoryAction);
      if (item.dataset.expandable === "1") {
        if (state.expandedCategoryIds.has(id)) {
          state.expandedCategoryIds.delete(id);
        } else {
          state.expandedCategoryIds.add(id);
        }
      }
      renderCategoryTree();
    });

    item.addEventListener("dragover", (event) => {
      if (!state.draggingTreeProductId) return;
      event.preventDefault();
      const categoryId = Number(item.dataset.id);
      if (!categoryId) return;
      state.treeDropCategoryId = categoryId;
      item.classList.add("drag-target");
    });

    item.addEventListener("dragleave", () => {
      const categoryId = Number(item.dataset.id);
      if (state.treeDropCategoryId === categoryId) {
        state.treeDropCategoryId = null;
      }
      item.classList.remove("drag-target");
    });

    item.addEventListener("drop", (event) => {
      if (!state.draggingTreeProductId) return;
      event.preventDefault();
      event.stopPropagation();
      const categoryId = Number(item.dataset.id);
      if (!categoryId) return;
      const productId = Number(state.draggingTreeProductId);
      state.treeDropCategoryId = null;
      item.classList.remove("drag-target");
      moveTreeProductToCategory(productId, categoryId).catch((err) => toast(err.message));
    });
  });

  container.querySelectorAll(".tree-product-item[data-product-id]").forEach((item) => {
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      const productId = Number(item.dataset.productId);
      if (!productId) return;
      state.selectedTreeProductId = productId;
      updateEditSelectedProductButtonState();
      renderCategoryTree();
    });

    item.addEventListener("dragstart", (event) => {
      const productId = Number(item.dataset.productId);
      if (!productId) return;
      state.draggingTreeProductId = productId;
      state.treeDropCategoryId = null;
      item.classList.add("dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(productId));
      }
    });

    item.addEventListener("dragend", () => {
      state.draggingTreeProductId = null;
      state.treeDropCategoryId = null;
      renderCategoryTree();
    });
  });

  container.querySelectorAll("button[data-tree-edit-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const productId = Number(button.dataset.treeEditId);
      if (!productId) return;
      loadProductDetail(productId).catch((err) => toast(err.message));
    });
  });

  container.querySelectorAll("button[data-tree-change-category-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const productId = Number(button.dataset.treeChangeCategoryId);
      if (!productId) return;
      try {
        openProductCategoryMoveModal(productId);
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

async function moveTreeProductToCategory(productId, categoryId) {
  if (!productId || !categoryId) {
    throw new Error("拖拽移动失败");
  }

  const product = state.materialProducts.find((item) => item.id === productId);
  if (!product) {
    throw new Error("未找到要移动的产品");
  }

  const currentCategoryId = product.category_id == null ? null : Number(product.category_id);
  if (currentCategoryId === categoryId) {
    state.draggingTreeProductId = null;
    state.treeDropCategoryId = null;
    renderCategoryTree();
    return;
  }

  await request(`/api/products/${productId}/move-category`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category_id: categoryId }),
  });

  state.draggingTreeProductId = null;
  state.treeDropCategoryId = categoryId;
  state.selectedTreeCategoryId = categoryId;
  state.selectedTreeProductId = productId;
  state.expandedCategoryIds.add(categoryId);
  toast("产品目录已移动");

  await Promise.all([loadProducts(), loadMaterialProducts()]);
  if (Number(el("productId").value) === productId) {
    el("productCategory").value = String(categoryId);
  }
  state.treeDropCategoryId = null;
  renderCategoryTree();
}

function renderRecycleBinTree() {
  const container = el("recycleBinTree");
  if (!container) return;

  const parentMap = new Map();
  for (const category of state.categories) {
    parentMap.set(category.id, category.parent_id ?? null);
  }

  const subtreeProducts = new Map();
  const uncategorizedProducts = [];
  for (const product of state.recycleBinProducts) {
    let categoryId = product.category_id == null ? null : Number(product.category_id);
    if (!categoryId || !parentMap.has(categoryId)) {
      uncategorizedProducts.push(product);
      continue;
    }
    const visited = new Set();
    while (categoryId && !visited.has(categoryId)) {
      visited.add(categoryId);
      if (!subtreeProducts.has(categoryId)) {
        subtreeProducts.set(categoryId, []);
      }
      subtreeProducts.get(categoryId).push(product);
      categoryId = parentMap.get(categoryId) ?? null;
    }
  }

  function renderProductNode(product) {
    const name = product.chinese_name || product.name || "-";
    const imageBlock = product.first_image
      ? `<img class="tree-product-thumb" src="/media-thumb/${product.first_image}?size=168" alt="${name}" />`
      : '<div class="tree-product-no-image">无图</div>';
    return `
      <li class="tree-product-item recycle-product-item">
        <div class="tree-product-main">
          <div class="tree-product-media">${imageBlock}</div>
          <div class="tree-product-info">
            <div class="tree-product-head">
              <div class="tree-product-title">${product.code || "-"} | ${name}</div>
              <div class="button-row">
                <button type="button" class="tree-product-edit-btn" data-recycle-action="restore" data-id="${product.id}">恢复</button>
                <button type="button" class="danger" data-recycle-action="purge" data-id="${product.id}">彻底删除</button>
              </div>
            </div>
            <div class="tree-product-grid">
              <div>作用：${product.effect || "-"}</div>
              <div>喷洒半径：${product.spray_radius || "-"}</div>
              <div>单个重量：${product.unit_weight || "-"}</div>
              <div>包装数量：${product.package_quantity || "-"}</div>
              <div>包装尺寸：${product.package_size || "-"}</div>
              <div>总重量：${product.gross_weight || "-"}</div>
              <div>目录：${product.category_name || "未分类"}</div>
              <div>删除时间：${product.deleted_at || "-"}</div>
            </div>
          </div>
        </div>
      </li>
    `;
  }

  function renderNodes(nodes, depth = 0) {
    let html = "";
    for (const node of nodes) {
      const products = subtreeProducts.get(node.id) || [];
      const hasContent = products.length > 0;
      const expanded = state.recycleExpandedCategoryIds.has(node.id);
      const sign = hasContent ? (expanded ? "-" : "+") : "·";
      const signClass = hasContent ? "tree-sign" : "tree-sign empty";
      const padding = 10 + depth * 14;
      html += `<li>
        <div
          class="tree-item"
          data-recycle-category-id="${node.id}"
          data-expandable="${hasContent ? "1" : "0"}"
          style="padding-left:${padding}px"
        >
          <span class="${signClass}">${sign}</span>
          <span>${node.name}</span>
        </div>
      `;
      if (node.children && node.children.length > 0) {
        html += `<ul class="tree">${renderNodes(node.children, depth + 1)}</ul>`;
      }
      if (expanded && products.length > 0) {
        html += `<ul class="tree-products">${products.map(renderProductNode).join("")}</ul>`;
      }
      html += "</li>";
    }
    return html;
  }

  let html = "";
  if (uncategorizedProducts.length > 0) {
    html += `
      <li>
        <div class="tree-item active">
          <span class="tree-sign empty">·</span>
          <span>未分类</span>
        </div>
        <ul class="tree-products">${uncategorizedProducts.map(renderProductNode).join("")}</ul>
      </li>
    `;
  }
  html += renderNodes(state.categoryTree);

  if (!html) {
    container.innerHTML = '<li class="hint">回收站为空</li>';
    return;
  }

  container.innerHTML = html;

  container.querySelectorAll("[data-recycle-category-id]").forEach((item) => {
    item.addEventListener("click", () => {
      if (item.dataset.expandable !== "1") return;
      const categoryId = Number(item.dataset.recycleCategoryId);
      if (!categoryId) return;
      if (state.recycleExpandedCategoryIds.has(categoryId)) {
        state.recycleExpandedCategoryIds.delete(categoryId);
      } else {
        state.recycleExpandedCategoryIds.add(categoryId);
      }
      renderRecycleBinTree();
    });
  });

  container.querySelectorAll("button[data-recycle-action]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const productId = Number(button.dataset.id);
      if (!productId) return;
      if (button.dataset.recycleAction === "restore") {
        restoreRecycleBinProduct(productId).catch((err) => toast(err.message));
        return;
      }
      purgeRecycleBinProduct(productId).catch((err) => toast(err.message));
    });
  });
}

function renderProducts(items) {
  const body = el("productsBody");
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="11" class="hint">暂无数据</td></tr>';
    return;
  }

  body.innerHTML = items
    .map((item) => {
      const chineseName = item.chinese_name || item.name || "-";
      const img = item.first_image
        ? `<img class="thumb" src="/media/${item.first_image}" alt="${chineseName}" />`
        : '<span class="hint">无图</span>';
      return `
      <tr>
        <td>${item.code}</td>
        <td>${chineseName}</td>
        <td>${item.effect || "-"}</td>
        <td>${item.spray_radius || "-"}</td>
        <td>${item.unit_weight || "-"}</td>
        <td>${item.package_quantity || "-"}</td>
        <td>${item.package_size || "-"}</td>
        <td>${item.gross_weight || "-"}</td>
        <td>${item.category_name || "-"}</td>
        <td>${img}</td>
        <td>
          <div class="button-row">
            <button data-action="edit" data-id="${item.id}">编辑</button>
            <button class="danger" data-action="delete" data-id="${item.id}">删除</button>
          </div>
        </td>
      </tr>
      `;
    })
    .join("");

  body.querySelectorAll("button[data-action='edit']").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = Number(button.dataset.id);
      await loadProductDetail(id);
    });
  });

  body.querySelectorAll("button[data-action='delete']").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = Number(button.dataset.id);
      if (!window.confirm("确认删除该产品？")) return;
      await request(`/api/products/${id}`, { method: "DELETE" });
      toast("产品已移入回收站");
      if (state.selectedTreeProductId === id) {
        state.selectedTreeProductId = null;
        updateEditSelectedProductButtonState();
      }
      if (String(el("productId").value) === String(id)) {
        resetProductForm();
      }
      await Promise.all([loadProducts(), loadStats(), loadMaterialProducts(), loadRecycleBinProducts()]);
    });
  });
}

function updatePager() {
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
  el("pageInfo").textContent = `第 ${state.page} / ${totalPages} 页`;
  el("prevPageBtn").disabled = state.page <= 1;
  el("nextPageBtn").disabled = state.page >= totalPages;
}

function renderProductImages(images) {
  const container = el("imageList");
  const mainImage = el("productMainImage");
  const mainHint = el("productMainImageHint");

  const showMain = (imagePath) => {
    if (!mainImage || !mainHint) return;
    if (!imagePath) {
      mainImage.classList.remove("show");
      mainImage.removeAttribute("src");
      mainHint.style.display = "block";
      return;
    }
    mainImage.src = `/media/${imagePath}`;
    mainImage.classList.add("show");
    mainHint.style.display = "none";
  };

  if (!images.length) {
    container.innerHTML = '<div class="hint">暂无图片</div>';
    state.selectedProductMainImagePath = null;
    showMain(null);
    return;
  }

  const availablePaths = new Set(images.map((img) => img.image_path));
  if (!state.selectedProductMainImagePath || !availablePaths.has(state.selectedProductMainImagePath)) {
    state.selectedProductMainImagePath = images[0].image_path;
  }
  showMain(state.selectedProductMainImagePath);

  container.innerHTML = images
    .map(
      (img) => `
    <div class="image-card ${
      state.selectedProductMainImagePath === img.image_path ? "active" : ""
    }" data-image-path="${img.image_path}">
      <img src="/media/${img.image_path}" alt="${img.image_path}" />
      <button class="danger" data-id="${img.id}">删除图片</button>
    </div>
  `
    )
    .join("");

  container.querySelectorAll(".image-card[data-image-path]").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedProductMainImagePath = card.dataset.imagePath || null;
      renderProductImages(images);
    });
  });

  container.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const id = Number(button.dataset.id);
      if (!window.confirm("确认删除该图片？")) return;
      await request(`/api/product-images/${id}`, { method: "DELETE" });
      toast("图片已删除");
      const productId = Number(el("productId").value);
      if (productId) {
        await Promise.all([loadProductDetail(productId), loadProducts(), loadStats()]);
      }
    });
  });
}

function renderProductBoomBaseSelect(
  items,
  selectedBaseItemId = null,
  placeholder = "选择BOOM具体名称"
) {
  const select = el("bomBaseItemSelect");
  if (!select) return;

  let html = `<option value="">${placeholder}</option>`;
  for (const item of items) {
    const cost = Number(item.default_unit_cost || 0);
    const unit = item.unit ? ` | ${item.unit}` : "";
    html += `<option value="${item.id}">${escapeHtml(item.item_name || "")}${escapeHtml(unit)} | 默认单价 ${toMoney(cost)}</option>`;
  }
  select.innerHTML = html;

  const selectedValue = selectedBaseItemId ? String(selectedBaseItemId) : "";
  if ([...select.options].some((option) => option.value === selectedValue)) {
    select.value = selectedValue;
    return;
  }
  select.value = "";
}

async function loadProductBoomBaseItems(boomCategoryId, selectedBaseItemId = null) {
  if (!boomCategoryId) {
    state.currentProductBoomBaseItems = [];
    renderProductBoomBaseSelect([], null, "当前产品未设置BOOM目录，无法选择BOOM基础项");
    return;
  }
  const data = await request(`/api/category-boom-base-items?boom_category_id=${boomCategoryId}`);
  state.currentProductBoomBaseItems = data.items || [];
  renderProductBoomBaseSelect(state.currentProductBoomBaseItems, selectedBaseItemId);
}

function applySelectedProductBoomBaseItem() {
  const selectedId = Number(el("bomBaseItemSelect").value);
  if (!selectedId) {
    el("bomItemUnit").value = "";
    return;
  }
  const selected = state.currentProductBoomBaseItems.find((item) => item.id === selectedId);
  if (!selected) {
    el("bomItemUnit").value = "";
    return;
  }

  el("bomItemUnit").value = selected.unit || "";
}

function setBomEditorEnabled(enabled) {
  const bomEditorHint = el("bomEditorHint");
  const bomEditor = el("bomEditor");
  if (!bomEditorHint || !bomEditor) return;

  bomEditorHint.textContent = enabled
    ? "为当前产品设置BOM项目后，可在成本计算中自动带入单件成本。"
    : "请先保存产品后，再维护BOM项目。";

  bomEditor.querySelectorAll("input, button, select").forEach((node) => {
    node.disabled = !enabled;
  });
}

function setProductSpecEditorEnabled(enabled) {
  const hint = el("productSpecEditorHint");
  const editor = el("productSpecEditor");
  if (!hint || !editor) return;

  hint.textContent = enabled ? "可为当前产品新增多个规格。" : "请先保存产品后，再维护规格。";

  editor.querySelectorAll("input, button").forEach((node) => {
    node.disabled = !enabled;
  });
}

function resetProductSpecEditor() {
  state.editingProductSpecId = null;
  el("productSpecName").value = "";
  el("saveProductSpecBtn").textContent = "新增规格";
  el("cancelProductSpecEditBtn").style.display = "none";
}

function startEditProductSpec(specId) {
  const item = state.currentProductSpecs.find((row) => row.id === specId);
  if (!item) {
    throw new Error("未找到要修改的规格");
  }

  state.editingProductSpecId = specId;
  el("productSpecName").value = item.spec_name || "";
  el("saveProductSpecBtn").textContent = "保存修改";
  el("cancelProductSpecEditBtn").style.display = "";
}

function renderProductSpecs(items) {
  const body = el("productSpecsBody");
  state.currentProductSpecs = [...items];

  if (!items.length) {
    body.innerHTML = '<tr><td colspan="2" class="hint">暂无规格</td></tr>';
    return;
  }

  body.innerHTML = items
    .map(
      (item) => `
      <tr>
        <td>${escapeHtml(item.spec_name || "-")}</td>
        <td>
          <div class="button-row">
            <button type="button" data-product-spec-action="edit" data-id="${item.id}">修改</button>
            <button type="button" class="danger" data-product-spec-action="delete" data-id="${item.id}">删除</button>
          </div>
        </td>
      </tr>
      `
    )
    .join("");

  body.querySelectorAll("button[data-product-spec-action='edit']").forEach((button) => {
    button.addEventListener("click", () => {
      const specId = Number(button.dataset.id);
      try {
        startEditProductSpec(specId);
      } catch (err) {
        toast(err.message);
      }
    });
  });

  body.querySelectorAll("button[data-product-spec-action='delete']").forEach((button) => {
    button.addEventListener("click", () => {
      const specId = Number(button.dataset.id);
      deleteProductSpec(specId).catch((err) => toast(err.message));
    });
  });
}

function buildProductSpecPayload() {
  const specName = el("productSpecName").value.trim();
  if (!specName) {
    throw new Error("规格名称不能为空");
  }
  return { spec_name: specName };
}

async function saveProductSpec() {
  const productId = Number(el("productId").value);
  if (!productId) {
    throw new Error("请先保存产品，再维护规格");
  }

  const payload = buildProductSpecPayload();
  if (state.editingProductSpecId) {
    await request(`/api/product-specs/${state.editingProductSpecId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    toast("规格已修改");
  } else {
    await request(`/api/products/${productId}/specs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    toast("规格已新增");
  }

  resetProductSpecEditor();
  await loadProductDetail(productId);
}

async function deleteProductSpec(specId) {
  if (!specId) return;
  if (!window.confirm("确认删除该规格？")) return;
  const productId = Number(el("productId").value);
  await request(`/api/product-specs/${specId}`, { method: "DELETE" });
  toast("规格已删除");
  resetProductSpecEditor();
  if (!productId) return;
  await loadProductDetail(productId);
}

function resetBomEditor() {
  state.editingBomItemId = null;
  el("bomBaseItemSelect").value = "";
  el("bomItemUnit").value = "";
  el("bomItemQty").value = "0";
  el("saveBomItemBtn").textContent = "新增项目";
  el("cancelBomEditBtn").style.display = "none";
}

function startEditBomItem(bomItemId) {
  const item = state.currentProductBomItems.find((row) => row.id === bomItemId);
  if (!item) {
    throw new Error("未找到要修改的BOM项目");
  }

  state.editingBomItemId = bomItemId;
  el("bomBaseItemSelect").value = item.base_item_id ? String(item.base_item_id) : "";
  el("bomItemUnit").value = item.unit || "";
  el("bomItemQty").value = formatDecimal(item.quantity, 6);
  el("saveBomItemBtn").textContent = "保存修改";
  el("cancelBomEditBtn").style.display = "";
}

function renderBomItems(items, totalCost = 0) {
  const body = el("bomItemsBody");
  const bomTotal = Number(totalCost);
  state.currentProductBomItems = [...items];
  state.currentProductBomTotalCost = Number.isFinite(bomTotal) ? bomTotal : 0;

  if (!items.length) {
    body.innerHTML = '<tr><td colspan="8" class="hint">暂无BOM项目</td></tr>';
    setText("bomTotalCost", "BOM单件成本合计: ¥0.00");
    return;
  }

  body.innerHTML = items
    .map((item) => {
      const lineTotal = Number(item.line_total);
      return `
      <tr>
        <td>${escapeHtml(item.item_name || "-")}</td>
        <td>${escapeHtml(item.item_spec || "-")}</td>
        <td>${escapeHtml(item.unit || "-")}</td>
        <td>${formatDecimal(item.quantity)}</td>
        <td>${toMoney(Number(item.unit_cost))}</td>
        <td>${toMoney(Number.isFinite(lineTotal) ? lineTotal : Number(item.quantity) * Number(item.unit_cost))}</td>
        <td>${escapeHtml(item.remark || "-")}</td>
        <td>
          <div class="button-row">
            <button type="button" data-bom-action="edit" data-id="${item.id}">修改</button>
            <button type="button" class="danger" data-bom-action="delete" data-id="${item.id}">删除</button>
          </div>
        </td>
      </tr>
      `;
    })
    .join("");

  setText("bomTotalCost", `BOM单件成本合计: ¥${toMoney(state.currentProductBomTotalCost)}`);

  body.querySelectorAll("button[data-bom-action='edit']").forEach((button) => {
    button.addEventListener("click", () => {
      const bomItemId = Number(button.dataset.id);
      try {
        startEditBomItem(bomItemId);
      } catch (err) {
        toast(err.message);
      }
    });
  });

  body.querySelectorAll("button[data-bom-action='delete']").forEach((button) => {
    button.addEventListener("click", () => {
      const bomItemId = Number(button.dataset.id);
      deleteBomItem(bomItemId).catch((err) => toast(err.message));
    });
  });
}

function buildBomItemPayload() {
  const baseItemId = el("bomBaseItemSelect").value ? Number(el("bomBaseItemSelect").value) : null;
  if (!baseItemId) {
    throw new Error("请选择BOOM具体名称");
  }

  const quantity = Number(el("bomItemQty").value || "0");
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error("BOM数量必须大于等于0");
  }

  return {
    base_item_id: baseItemId,
    quantity,
  };
}

async function saveBomItem() {
  const productId = Number(el("productId").value);
  if (!productId) {
    throw new Error("请先保存产品，再维护BOM");
  }

  const payload = buildBomItemPayload();
  if (state.editingBomItemId) {
    await request(`/api/bom-items/${state.editingBomItemId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    toast("BOM项目已修改");
  } else {
    await request(`/api/products/${productId}/bom-items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    toast("BOM项目已新增");
  }

  resetBomEditor();
  await Promise.all([loadProductDetail(productId), loadProducts(), loadMaterialProducts()]);
}

async function deleteBomItem(bomItemId) {
  if (!bomItemId) return;
  if (!window.confirm("确认删除该BOM项目？")) return;
  const productId = Number(el("productId").value);
  await request(`/api/bom-items/${bomItemId}`, { method: "DELETE" });
  toast("BOM项目已删除");
  resetBomEditor();
  if (!productId) return;
  await Promise.all([loadProductDetail(productId), loadProducts(), loadMaterialProducts()]);
}

function resetProductForm() {
  el("productId").value = "";
  el("productCode").value = "";
  el("productChineseName").value = "";
  el("productCategory").value = "";
  el("productBoomCategory").value = "";
  el("productEffect").value = "";
  el("productDescription").value = "";
  el("productSprayRadius").value = "";
  el("productUnitWeight").value = "";
  el("productPackageQuantity").value = "";
  el("productPackageSize").value = "";
  el("productGrossWeight").value = "";
  setProductCodeError("");
  el("productFormTitle").textContent = "新增产品";
  el("productShowImagesToggle").checked = false;
  setProductImagePanelVisible(false);
  updateDeleteProductButtonState();
  state.selectedProductMainImagePath = null;
  const mainImage = el("productMainImage");
  if (mainImage) {
    mainImage.classList.remove("show");
    mainImage.removeAttribute("src");
  }
  const mainHint = el("productMainImageHint");
  if (mainHint) {
    mainHint.style.display = "block";
  }
  el("imageFile").value = "";
  el("imageList").innerHTML = '<div class="hint">请先选择或保存一个产品后上传图片。</div>';
  state.currentProductSpecs = [];
  resetProductSpecEditor();
  renderProductSpecs([]);
  setProductSpecEditorEnabled(false);
  state.currentProductBoomBaseItems = [];
  renderProductBoomBaseSelect([], null, "请先保存产品后选择BOOM基础项");
  resetBomEditor();
  renderBomItems([], 0);
  setBomEditorEnabled(false);
}

function setProductImagePanelVisible(show) {
  const panel = el("productImagePanel");
  if (!panel) return;
  panel.classList.toggle("show", Boolean(show));
}

function resetMaterialPanels() {
  setText("flowPerHour", "-");
  setText("materialCostUnitHint", "默认自动带入产品BOM单件成本，可手动修改");

  setText("costPackageCount", "-");
  setText("costSubtotal", "-");
  setText("costQuoteExTax", "-");
  setText("costQuoteInclTax", "-");
  setText("costUnitExTax", "-");
  setText("costUnitInclTax", "-");

  renderPackagingMachineTree();
  renderQuoteLines();
}

async function loadStats() {
  const stats = await request("/api/stats");
  el("stats").textContent = `目录: ${stats.categories} | 产品: ${stats.products} | 图片: ${stats.images}`;
}

async function loadCategories() {
  const data = await request("/api/categories");
  state.categories = data.items;
  state.categoryTree = data.tree;

  fillCategorySelect("filterCategory", true);
  fillCategorySelect("productCategory");

  if (
    state.selectedTreeCategoryId &&
    !state.categories.some((category) => category.id === state.selectedTreeCategoryId)
  ) {
    state.selectedTreeCategoryId = null;
  }
  if (
    state.selectedBoomBaseCategoryId &&
    !state.boomCategories.some((category) => category.id === state.selectedBoomBaseCategoryId)
  ) {
    state.selectedBoomBaseCategoryId = null;
  }

  setCategoryAction(state.categoryAction);

  renderCategoryTree();
  renderRecycleBinTree();
}

async function loadBoomCategories() {
  const data = await request("/api/boom-categories");
  state.boomCategories = data.items || [];
  state.boomCategoryTree = data.tree || [];

  fillBoomCategorySelect("productBoomCategory");

  if (
    state.selectedBoomBaseCategoryId &&
    !state.boomCategories.some((category) => category.id === state.selectedBoomBaseCategoryId)
  ) {
    state.selectedBoomBaseCategoryId = null;
  }
  if (!state.selectedBoomBaseCategoryId && state.boomCategoryTree.length > 0) {
    state.selectedBoomBaseCategoryId = Number(state.boomCategoryTree[0].id) || null;
  }

  setBoomCategoryAction(state.boomCategoryAction);
  renderBoomBaseCategoryTree();
  await loadBoomBaseItems();
}

function resetConfigUnitForm() {
  state.editingConfigUnitId = null;
  el("configUnitId").value = "";
  el("configUnitName").value = "";
  el("saveConfigUnitBtn").textContent = "新增单位";
  el("cancelConfigUnitEditBtn").style.display = "none";
}

function renderConfigUnits(items) {
  const body = el("configUnitsBody");
  state.configUnits = [...items];
  renderBoomUnitSelect(el("boomBaseUnit")?.value || "");

  if (!items.length) {
    body.innerHTML = '<tr><td colspan="2" class="hint">暂无单位配置</td></tr>';
    return;
  }

  body.innerHTML = items
    .map(
      (item) => `
      <tr>
        <td>${escapeHtml(item.name || "-")}</td>
        <td>
          <div class="button-row">
            <button type="button" data-config-unit-action="edit" data-id="${item.id}">修改</button>
            <button type="button" class="danger" data-config-unit-action="delete" data-id="${item.id}">删除</button>
          </div>
        </td>
      </tr>
      `
    )
    .join("");

  body.querySelectorAll("button[data-config-unit-action='edit']").forEach((button) => {
    button.addEventListener("click", () => {
      const unitId = Number(button.dataset.id);
      const target = state.configUnits.find((item) => item.id === unitId);
      if (!target) {
        toast("未找到要修改的单位");
        return;
      }
      state.editingConfigUnitId = unitId;
      el("configUnitId").value = String(unitId);
      el("configUnitName").value = target.name || "";
      el("saveConfigUnitBtn").textContent = "保存修改";
      el("cancelConfigUnitEditBtn").style.display = "";
    });
  });

  body.querySelectorAll("button[data-config-unit-action='delete']").forEach((button) => {
    button.addEventListener("click", () => {
      const unitId = Number(button.dataset.id);
      deleteConfigUnit(unitId).catch((err) => toast(err.message));
    });
  });
}

async function loadConfigUnits() {
  const data = await request("/api/config-units");
  renderConfigUnits(data.items || []);
}

async function saveConfigUnit() {
  const name = el("configUnitName").value.trim();
  if (!name) {
    throw new Error("单位名称不能为空");
  }

  const payload = { name };
  if (state.editingConfigUnitId) {
    await request(`/api/config-units/${state.editingConfigUnitId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    toast("单位已修改");
  } else {
    await request("/api/config-units", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    toast("单位已新增");
  }

  const currentBoomCategoryId = Number(state.selectedBoomBaseCategoryId || 0);
  resetConfigUnitForm();
  await loadConfigUnits();
  if (currentBoomCategoryId) {
    await loadBoomBaseItems();
  }
}

async function deleteConfigUnit(unitId) {
  if (!unitId) return;
  if (!window.confirm("确认删除该单位？")) return;
  await request(`/api/config-units/${unitId}`, { method: "DELETE" });
  toast("单位已删除");
  if (state.editingConfigUnitId === unitId) {
    resetConfigUnitForm();
  }
  await loadConfigUnits();
}

async function loadProducts() {
  const keyword = el("searchKeyword").value.trim();
  const categoryId = el("filterCategory").value;

  const params = new URLSearchParams({
    page: String(state.page),
    page_size: String(state.pageSize),
  });

  if (keyword) params.set("q", keyword);
  if (categoryId) params.set("category_id", categoryId);

  const data = await request(`/api/products?${params.toString()}`);
  state.total = data.total;
  renderProducts(data.items);
  updatePager();
}

async function fetchAllProducts(options = {}) {
  const keyword = (options.keyword || "").trim();
  const categoryId = options.categoryId || "";
  const items = [];
  const pageSize = 100;
  let page = 1;
  let total = 0;

  do {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
    });
    if (keyword) params.set("q", keyword);
    if (categoryId) params.set("category_id", String(categoryId));

    const data = await request(`/api/products?${params.toString()}`);
    items.push(...(data.items || []));
    total = Number(data.total || 0);
    page += 1;
  } while (items.length < total);

  return items;
}

function renderPackagingMachineTree() {
  const container = el("packagingMachineTree");
  if (!container) return;

  const parentMap = new Map();
  for (const category of state.categories) {
    parentMap.set(category.id, category.parent_id ?? null);
  }

  const subtreeProducts = new Map();
  for (const product of state.materialProducts) {
    let categoryId = product.category_id == null ? null : Number(product.category_id);
    const visited = new Set();
    while (categoryId && !visited.has(categoryId)) {
      visited.add(categoryId);
      if (!subtreeProducts.has(categoryId)) {
        subtreeProducts.set(categoryId, []);
      }
      subtreeProducts.get(categoryId).push(product);
      categoryId = parentMap.get(categoryId) ?? null;
    }
  }

  function renderProductNode(product) {
    const name = product.chinese_name || product.name || "-";
    return `
      <li class="tree-product-item packaging-machine-card" data-packaging-product-id="${product.id}">
        <div class="packaging-machine-head">
          <div class="tree-product-title">${product.code || "-"} | ${name}</div>
          <button type="button" class="tree-product-edit-btn" data-packaging-save-id="${product.id}">保存</button>
        </div>
        <div class="packaging-machine-grid">
          <label class="packaging-machine-field">
            <span>包装名字</span>
            <input type="text" data-packaging-field="packaging_machine_name" value="${escapeHtml(product.packaging_machine_name || "")}" />
          </label>
          <label class="packaging-machine-field">
            <span>数量</span>
            <input type="text" data-packaging-field="packaging_machine_quantity" value="${escapeHtml(product.packaging_machine_quantity || "")}" />
          </label>
          <label class="packaging-machine-field">
            <span>包数</span>
            <input type="text" data-packaging-field="packaging_machine_pack_count" value="${escapeHtml(product.packaging_machine_pack_count || "")}" />
          </label>
          <label class="packaging-machine-field">
            <span>箱子大小</span>
            <input type="text" data-packaging-field="packaging_machine_box_size" value="${escapeHtml(product.packaging_machine_box_size || "")}" />
          </label>
          <label class="packaging-machine-field">
            <span>袋子长度</span>
            <input type="text" data-packaging-field="packaging_machine_bag_length" value="${escapeHtml(product.packaging_machine_bag_length || "")}" />
          </label>
          <label class="packaging-machine-field">
            <span>振幅</span>
            <input type="text" data-packaging-field="packaging_machine_amplitude" value="${escapeHtml(product.packaging_machine_amplitude || "")}" />
          </label>
          <label class="packaging-machine-field">
            <span>程序</span>
            <input type="text" data-packaging-field="packaging_machine_program" value="${escapeHtml(product.packaging_machine_program || "")}" />
          </label>
        </div>
      </li>
    `;
  }

  function renderNodes(nodes, depth = 0) {
    let html = "";
    for (const node of nodes) {
      const products = subtreeProducts.get(node.id) || [];
      const hasContent = products.length > 0;
      const expanded = state.packagingExpandedCategoryIds.has(node.id);
      const sign = hasContent ? (expanded ? "-" : "+") : "·";
      const signClass = hasContent ? "tree-sign" : "tree-sign empty";
      const padding = 10 + depth * 14;
      html += `<li>
        <div
          class="tree-item"
          data-packaging-category-id="${node.id}"
          data-expandable="${hasContent ? "1" : "0"}"
          style="padding-left:${padding}px"
        >
          <span class="${signClass}">${sign}</span>
          <span>${node.name}</span>
        </div>
      `;
      if (node.children && node.children.length > 0) {
        html += `<ul class="tree">${renderNodes(node.children, depth + 1)}</ul>`;
      }
      if (expanded && products.length > 0) {
        html += `<ul class="tree-products">${products.map(renderProductNode).join("")}</ul>`;
      }
      html += "</li>";
    }
    return html;
  }

  container.innerHTML = renderNodes(state.categoryTree);
  if (!container.innerHTML.trim()) {
    container.innerHTML = '<li class="hint">暂无目录数据</li>';
    return;
  }

  container.querySelectorAll("[data-packaging-category-id]").forEach((item) => {
    item.addEventListener("click", () => {
      if (item.dataset.expandable !== "1") return;
      const categoryId = Number(item.dataset.packagingCategoryId);
      if (!categoryId) return;
      if (state.packagingExpandedCategoryIds.has(categoryId)) {
        state.packagingExpandedCategoryIds.delete(categoryId);
      } else {
        state.packagingExpandedCategoryIds.add(categoryId);
      }
      renderPackagingMachineTree();
    });
  });

  container.querySelectorAll("button[data-packaging-save-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const productId = Number(button.dataset.packagingSaveId);
      if (!productId) return;
      savePackagingMachineData(productId).catch((err) => toast(err.message));
    });
  });
}

function renderBoomBaseCategoryTree() {
  const container = el("boomBaseCategoryTree");
  if (!container) return;

  const pathMap = boomCategoryPathMap();
  setText(
    "boomBaseCategoryHint",
    state.selectedBoomBaseCategoryId
      ? `当前BOOM目录：${pathMap.get(state.selectedBoomBaseCategoryId) || "未知目录"}`
      : "请先在目录树中选择一个BOOM目录"
  );

  function renderNodes(nodes, depth = 0) {
    let html = "";
    for (const node of nodes) {
      const active = state.selectedBoomBaseCategoryId === node.id ? "active" : "";
      const padding = 10 + depth * 14;
      html += `<li>
        <div class="tree-item ${active}" data-boom-category-id="${node.id}" style="padding-left:${padding}px">
          <span class="tree-sign empty">·</span>
          <span>${node.name}</span>
        </div>
      `;
      if (node.children && node.children.length > 0) {
        html += `<ul class="tree">${renderNodes(node.children, depth + 1)}</ul>`;
      }
      html += "</li>";
    }
    return html;
  }

  container.innerHTML = renderNodes(state.boomCategoryTree);
  container.querySelectorAll("[data-boom-category-id]").forEach((item) => {
    item.addEventListener("click", () => {
      const id = Number(item.dataset.boomCategoryId);
      if (!id) return;
      state.selectedBoomBaseCategoryId = id;
      resetBoomBaseForm();
      loadBoomBaseItems().catch((err) => toast(err.message));
      renderBoomBaseCategoryTree();
      setBoomCategoryAction(state.boomCategoryAction);
    });
  });
}

function resetBoomBaseForm() {
  state.editingBoomBaseItemId = null;
  el("boomBaseItemId").value = "";
  el("boomBaseItemName").value = "";
  renderBoomUnitSelect("");
  el("boomBaseDefaultUnitCost").value = "";
  el("boomBaseDescription").value = "";
  el("saveBoomBaseItemBtn").textContent = "新增项目";
  el("cancelBoomBaseEditBtn").style.display = "none";
  updateBoomBaseSaveButtonState();
}

function renderBoomBaseItems(items) {
  const body = el("boomBaseItemsBody");
  state.boomBaseItems = [...items];
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="6" class="hint">当前BOOM目录暂无基础信息</td></tr>';
    return;
  }

  body.innerHTML = items
    .map((item) => {
      const categoryName = item.boom_category_name || item.category_name || "-";
      return `
      <tr>
        <td>${escapeHtml(categoryName)}</td>
        <td>${escapeHtml(item.item_name || "-")}</td>
        <td>${escapeHtml(item.unit || "-")}</td>
        <td>¥${toMoney(Number(item.default_unit_cost || 0))}</td>
        <td>${escapeHtml(item.description || "-")}</td>
        <td>
          <div class="button-row">
            <button type="button" data-boom-action="edit" data-id="${item.id}">修改</button>
            <button type="button" class="danger" data-boom-action="delete" data-id="${item.id}">删除</button>
          </div>
        </td>
      </tr>
      `;
    })
    .join("");

  body.querySelectorAll("button[data-boom-action='edit']").forEach((button) => {
    button.addEventListener("click", () => {
      const baseItemId = Number(button.dataset.id);
      const target = state.boomBaseItems.find((item) => item.id === baseItemId);
      if (!target) {
        toast("未找到要修改的BOOM基础项");
        return;
      }
      state.editingBoomBaseItemId = baseItemId;
      el("boomBaseItemId").value = String(target.id);
      el("boomBaseItemName").value = target.item_name || "";
      renderBoomUnitSelect(target.unit || "");
      el("boomBaseDefaultUnitCost").value = formatDecimal(Number(target.default_unit_cost || 0), 6);
      el("boomBaseDescription").value = target.description || "";
      el("saveBoomBaseItemBtn").textContent = "保存修改";
      el("cancelBoomBaseEditBtn").style.display = "";
    });
  });

  body.querySelectorAll("button[data-boom-action='delete']").forEach((button) => {
    button.addEventListener("click", () => {
      const baseItemId = Number(button.dataset.id);
      deleteBoomBaseItem(baseItemId).catch((err) => toast(err.message));
    });
  });
}

async function loadBoomBaseItems() {
  const boomCategoryId = Number(state.selectedBoomBaseCategoryId);
  if (!boomCategoryId) {
    state.boomBaseItems = [];
    el("boomBaseItemsBody").innerHTML =
      '<tr><td colspan="6" class="hint">请选择BOOM目录后维护BOOM基础信息</td></tr>';
    updateBoomBaseSaveButtonState();
    return;
  }
  const data = await request(`/api/category-boom-base-items?boom_category_id=${boomCategoryId}`);
  renderBoomBaseItems(data.items || []);
  updateBoomBaseSaveButtonState();
}

async function saveBoomBaseItem() {
  const boomCategoryId = Number(state.selectedBoomBaseCategoryId);
  if (!boomCategoryId) {
    throw new Error("请选择BOOM目录");
  }

  const itemName = el("boomBaseItemName").value.trim();
  if (!itemName) {
    throw new Error("项目名称不能为空");
  }

  const payload = {
    boom_category_id: boomCategoryId,
    item_name: itemName,
    unit: el("boomBaseUnit").value.trim(),
    default_unit_cost: el("boomBaseDefaultUnitCost").value.trim() || "0",
    description: el("boomBaseDescription").value.trim(),
  };

  if (state.editingBoomBaseItemId) {
    await request(`/api/category-boom-base-items/${state.editingBoomBaseItemId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    toast("BOOM基础项已修改");
  } else {
    await request("/api/category-boom-base-items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    toast("BOOM基础项已新增");
  }

  resetBoomBaseForm();
  await loadBoomBaseItems();

  const productId = Number(el("productId").value);
  if (productId) {
    const productBoomCategoryId = Number(el("productBoomCategory").value);
    if (productBoomCategoryId && productBoomCategoryId === boomCategoryId) {
      await loadProductBoomBaseItems(productBoomCategoryId);
    }
  }
}

async function deleteBoomBaseItem(baseItemId) {
  if (!baseItemId) return;
  if (!window.confirm("确认删除该BOOM基础项？")) return;

  await request(`/api/category-boom-base-items/${baseItemId}`, { method: "DELETE" });
  toast("BOOM基础项已删除");
  if (state.editingBoomBaseItemId === baseItemId) {
    resetBoomBaseForm();
  }
  await loadBoomBaseItems();

  const productId = Number(el("productId").value);
  if (productId) {
    const productBoomCategoryId = Number(el("productBoomCategory").value);
    if (productBoomCategoryId) {
      await loadProductBoomBaseItems(productBoomCategoryId);
    }
  }
}

function syncMaterialCostUnitFromSelectedProduct() {
  const product = getMaterialProductById(el("materialCostProduct").value);
  if (!product) {
    el("materialCostUnit").value = "0";
    setText("materialCostUnitHint", "默认自动带入产品BOM单件成本，可手动修改");
    return;
  }

  const bomUnitCost = Number(product.bom_unit_cost || 0);
  const normalizedCost = Number.isFinite(bomUnitCost) ? bomUnitCost : 0;
  el("materialCostUnit").value = formatDecimal(normalizedCost, 6);

  if (normalizedCost > 0) {
    setText("materialCostUnitHint", `已自动带入BOM单件成本: ¥${toMoney(normalizedCost)}`);
    return;
  }

  setText("materialCostUnitHint", "该产品未设置BOM成本，当前默认 0，可手动输入");
}

function refreshMaterialSelectors() {
  fillMaterialProductSelect("materialCostProduct");
  fillMaterialProductSelect("quoteProduct");
  syncMaterialCostUnitFromSelectedProduct();
}

async function savePackagingMachineData(productId) {
  const card = document.querySelector(`[data-packaging-product-id="${productId}"]`);
  if (!card) {
    throw new Error("未找到要保存的产品");
  }

  const payload = {};
  card.querySelectorAll("[data-packaging-field]").forEach((field) => {
    payload[field.dataset.packagingField] = field.value.trim();
  });

  await request(`/api/products/${productId}/packaging-machine`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  toast("包装机数据已保存");
  await loadMaterialProducts();
}

async function loadMaterialProducts() {
  state.materialProducts = await fetchAllProducts();
  if (
    state.selectedTreeProductId &&
    !state.materialProducts.some((product) => product.id === state.selectedTreeProductId)
  ) {
    state.selectedTreeProductId = null;
  }
  updateEditSelectedProductButtonState();
  refreshMaterialSelectors();
  renderCategoryTree();
  renderPackagingMachineTree();
}

async function loadRecycleBinProducts() {
  const data = await request("/api/recycle-bin/products");
  state.recycleBinProducts = data.items || [];
  renderRecycleBinTree();
}

async function restoreRecycleBinProduct(productId) {
  await request(`/api/recycle-bin/products/${productId}/restore`, { method: "POST" });
  toast("产品已恢复");
  await Promise.all([
    loadRecycleBinProducts(),
    loadProducts(),
    loadStats(),
    loadMaterialProducts(),
  ]);
}

async function purgeRecycleBinProduct(productId) {
  if (!window.confirm("确认彻底删除该产品？")) return;
  if (!window.confirm("请再次确认：彻底删除后无法恢复，是否继续？")) return;
  await request(`/api/recycle-bin/products/${productId}`, { method: "DELETE" });
  toast("产品已彻底删除");
  await Promise.all([
    loadRecycleBinProducts(),
    loadProducts(),
    loadStats(),
    loadMaterialProducts(),
  ]);
}

async function editSelectedTreeProduct() {
  const productId = Number(state.selectedTreeProductId);
  if (!productId) {
    throw new Error("请先在目录树中选中产品");
  }
  await loadProductDetail(productId);
}

function calculateFlowPerHour() {
  const diameter = Number(el("flowDiameter").value);
  if (!Number.isFinite(diameter) || diameter <= 0) {
    throw new Error("出水孔径必须大于 0");
  }

  const flow = (110 * 3.14 * diameter * diameter) / 3.14 / 1.6 / 1.6;
  setText("flowPerHour", flow.toFixed(5));
}

function calculateMaterialCost() {
  const product = getMaterialProductById(el("materialCostProduct").value);
  if (!product) {
    throw new Error("请选择产品");
  }

  const quantity = Number(el("materialCostQuantity").value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("数量必须大于 0");
  }

  const unitCost = Number(el("materialCostUnit").value);
  const packageCost = Number(el("materialCostPack").value);
  const freightCost = Number(el("materialCostFreight").value);
  const taxRate = Number(el("materialCostTaxRate").value) / 100;
  const profitRate = Number(el("materialCostProfitRate").value) / 100;

  const packageQty = parseFirstNumber(product.package_quantity);
  const packageCount = packageQty && packageQty > 0 ? Math.ceil(quantity / packageQty) : 0;

  const materialTotal = quantity * (Number.isFinite(unitCost) ? unitCost : 0);
  const packageTotal = packageCount * (Number.isFinite(packageCost) ? packageCost : 0);
  const freightTotal = packageCount * (Number.isFinite(freightCost) ? freightCost : 0);
  const subtotal = materialTotal + packageTotal + freightTotal;

  const quoteExTax = subtotal * (1 + (Number.isFinite(profitRate) ? profitRate : 0));
  const quoteInclTax = quoteExTax * (1 + (Number.isFinite(taxRate) ? taxRate : 0));
  const unitExTax = quoteExTax / quantity;
  const unitInclTax = quoteInclTax / quantity;

  setText("costPackageCount", `${packageCount} 箱`);
  setText("costSubtotal", `¥${toMoney(subtotal)}`);
  setText("costQuoteExTax", `¥${toMoney(quoteExTax)}`);
  setText("costQuoteInclTax", `¥${toMoney(quoteInclTax)}`);
  setText("costUnitExTax", `¥${toMoney(unitExTax)}`);
  setText("costUnitInclTax", `¥${toMoney(unitInclTax)}`);
}

function renderQuoteLines() {
  const body = el("quoteLinesBody");
  if (!state.quoteLines.length) {
    body.innerHTML = '<tr><td colspan="6" class="hint">暂无报价行</td></tr>';
    setText("quoteTotal", "总数量: 0 | 报价总额: 0.00");
    return;
  }

  body.innerHTML = state.quoteLines
    .map(
      (line) => `
      <tr>
        <td>${line.code}</td>
        <td>${line.name}</td>
        <td>${line.quantity}</td>
        <td>${toMoney(line.unitPrice)}</td>
        <td>${toMoney(line.amount)}</td>
        <td><button class="danger" data-remove-line="${line.id}">删除</button></td>
      </tr>
    `
    )
    .join("");

  body.querySelectorAll("button[data-remove-line]").forEach((button) => {
    button.addEventListener("click", () => {
      const lineId = Number(button.dataset.removeLine);
      state.quoteLines = state.quoteLines.filter((line) => line.id !== lineId);
      renderQuoteLines();
    });
  });

  const totalQuantity = state.quoteLines.reduce((sum, line) => sum + line.quantity, 0);
  const totalAmount = state.quoteLines.reduce((sum, line) => sum + line.amount, 0);
  setText("quoteTotal", `总数量: ${totalQuantity} | 报价总额: ${toMoney(totalAmount)}`);
}

function addQuoteLine() {
  const product = getMaterialProductById(el("quoteProduct").value);
  if (!product) throw new Error("请选择产品");

  const quantity = Number(el("quoteQty").value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("数量必须大于 0");
  }

  const unitPrice = Number(el("quoteUnitPrice").value);
  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    throw new Error("单价不能小于 0");
  }

  state.quoteLines.push({
    id: Date.now() + Math.floor(Math.random() * 1000),
    productId: product.id,
    code: product.code || "-",
    name: product.chinese_name || product.name || "-",
    quantity,
    unitPrice,
    amount: quantity * unitPrice,
  });

  renderQuoteLines();
}

function clearQuoteLines() {
  state.quoteLines = [];
  renderQuoteLines();
}

async function loadProductDetail(id) {
  const data = await request(`/api/products/${id}`);
  const product = data.product;
  setActivePage("page-product-form", true);
  state.selectedProductMainImagePath = null;

  el("productId").value = String(product.id);
  el("productCode").value = product.code || "";
  el("productChineseName").value = product.chinese_name || product.name || "";
  el("productCategory").value = product.category_id == null ? "" : String(product.category_id);
  el("productBoomCategory").value =
    product.boom_category_id == null ? "" : String(product.boom_category_id);
  el("productEffect").value = product.effect || "";
  el("productDescription").value = product.description || "";
  el("productSprayRadius").value = product.spray_radius || "";
  el("productUnitWeight").value = product.unit_weight || "";
  el("productPackageQuantity").value = product.package_quantity || "";
  el("productPackageSize").value = product.package_size || "";
  el("productGrossWeight").value = product.gross_weight || "";
  setProductCodeError("");
  el("productFormTitle").textContent = `编辑产品 #${product.id}`;
  el("productShowImagesToggle").checked = true;
  setProductImagePanelVisible(true);
  updateDeleteProductButtonState();

  renderProductImages(data.images || []);
  resetProductSpecEditor();
  renderProductSpecs(data.specs || []);
  setProductSpecEditorEnabled(true);
  resetBomEditor();
  await loadProductBoomBaseItems(product.boom_category_id, null);
  renderBomItems(data.bom_items || [], Number(data.bom_total_cost || 0));
  setBomEditorEnabled(true);
}

async function deleteProductFromDetail() {
  const productId = Number(el("productId").value);
  if (!productId) {
    throw new Error("请先选择产品");
  }

  if (!window.confirm("确认删除当前产品？")) return;
  if (!window.confirm("请再次确认：产品会进入回收站，是否继续？")) return;

  await request(`/api/products/${productId}`, { method: "DELETE" });
  toast("产品已移入回收站");

  if (state.selectedTreeProductId === productId) {
    state.selectedTreeProductId = null;
    updateEditSelectedProductButtonState();
  }

  resetProductForm();
  await Promise.all([loadProducts(), loadStats(), loadMaterialProducts(), loadRecycleBinProducts()]);
}

async function applyCategoryAction() {
  const action = state.categoryAction;
  const categoryId = state.selectedTreeCategoryId;
  const name = (el("categoryActionInput")?.value || "").trim();

  if (!categoryId) {
    throw new Error("请先在目录树选择类型");
  }

  if (action === "add") {
    if (!name) throw new Error("目录名称不能为空");
    const current = state.categories.find((item) => item.id === categoryId);
    const parentId =
      state.categoryAddMode === "sibling" ? (current?.parent_id ?? null) : categoryId;
    const created = await request("/api/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        parent_id: parentId,
      }),
    });
    state.selectedTreeCategoryId = created.id || state.selectedTreeCategoryId;
    toast("目录已新增");
    await Promise.all([loadCategories(), loadProducts(), loadStats(), loadMaterialProducts()]);
    return;
  }

  if (action === "rename") {
    if (!name) throw new Error("目录名称不能为空");
    await request(`/api/categories/${categoryId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    toast("目录已重命名");
    await Promise.all([loadCategories(), loadProducts(), loadMaterialProducts()]);
    return;
  }

  await request(`/api/categories/${categoryId}`, { method: "DELETE" });
  state.expandedCategoryIds.delete(categoryId);
  state.selectedTreeCategoryId = null;
  toast("目录已删除");
  await Promise.all([loadCategories(), loadProducts(), loadStats(), loadMaterialProducts()]);
}

async function applyBoomCategoryAction() {
  const action = state.boomCategoryAction;
  const categoryId = state.selectedBoomBaseCategoryId;
  const name = (el("boomCategoryActionInput")?.value || "").trim();

  if (!categoryId && action !== "add") {
    throw new Error("请先在目录树选择BOOM目录");
  }

  if (action === "add") {
    if (!name) throw new Error("BOOM目录名称不能为空");
    const current = state.boomCategories.find((item) => item.id === categoryId);
    const parentId = !categoryId
      ? null
      : state.boomCategoryAddMode === "sibling"
        ? (current?.parent_id ?? null)
        : categoryId;
    const created = await request("/api/boom-categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        parent_id: parentId,
      }),
    });
    state.selectedBoomBaseCategoryId = created.id || state.selectedBoomBaseCategoryId;
    toast("BOOM目录已新增");
    await Promise.all([loadBoomCategories(), loadProducts(), loadMaterialProducts()]);
    return;
  }

  if (action === "rename") {
    if (!name) throw new Error("BOOM目录名称不能为空");
    await request(`/api/boom-categories/${categoryId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    toast("BOOM目录已重命名");
    await Promise.all([loadBoomCategories(), loadProducts(), loadMaterialProducts()]);
    return;
  }

  await request(`/api/boom-categories/${categoryId}`, { method: "DELETE" });
  state.selectedBoomBaseCategoryId = null;
  toast("BOOM目录已删除");
  await Promise.all([loadBoomCategories(), loadProducts(), loadMaterialProducts()]);
}

async function saveProduct() {
  setProductCodeError("");
  const productId = el("productId").value;
  const payload = {
    code: el("productCode").value.trim(),
    chinese_name: el("productChineseName").value.trim(),
    category_id: el("productCategory").value ? Number(el("productCategory").value) : null,
    boom_category_id: el("productBoomCategory").value ? Number(el("productBoomCategory").value) : null,
    effect: el("productEffect").value.trim(),
    description: el("productDescription").value.trim(),
    spray_radius: el("productSprayRadius").value.trim(),
    unit_weight: el("productUnitWeight").value.trim(),
    package_quantity: el("productPackageQuantity").value.trim(),
    package_size: el("productPackageSize").value.trim(),
    gross_weight: el("productGrossWeight").value.trim(),
  };

  if (productId) {
    await request(`/api/products/${productId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    toast("产品已更新");
    await Promise.all([loadProducts(), loadStats(), loadMaterialProducts()]);
    await loadProductDetail(Number(productId));
    return;
  }

  const created = await request("/api/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  toast("产品已新增");
  await Promise.all([loadProducts(), loadStats(), loadMaterialProducts()]);
  await loadProductDetail(created.id);
}

async function uploadImage() {
  const productId = el("productId").value;
  if (!productId) throw new Error("请先选择或保存一个产品");

  const fileInput = el("imageFile");
  if (!fileInput.files || fileInput.files.length === 0) {
    throw new Error("请选择要上传的图片");
  }

  const form = new FormData();
  form.append("image", fileInput.files[0]);

  await request(`/api/products/${productId}/images`, {
    method: "POST",
    body: form,
  });

  fileInput.value = "";
  toast("图片上传成功");
  await Promise.all([loadProductDetail(Number(productId)), loadProducts(), loadStats()]);
}

function bindEvents() {
  el("productShowImagesToggle").addEventListener("change", () => {
    setProductImagePanelVisible(el("productShowImagesToggle").checked);
  });
  el("categoryActionConfirmBtn").addEventListener("click", () =>
    confirmCategoryActionFromModal().catch((err) => toast(err.message))
  );
  el("categoryActionCancelBtn").addEventListener("click", closeCategoryActionModal);
  el("categoryActionModal").addEventListener("click", (event) => {
    if (event.target === el("categoryActionModal")) {
      closeCategoryActionModal();
    }
  });
  el("categoryActionInput").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    confirmCategoryActionFromModal().catch((err) => toast(err.message));
  });
  el("categoryAddSiblingBtn").addEventListener("click", () => {
    setCategoryAddMode("sibling");
  });
  el("categoryAddChildBtn").addEventListener("click", () => {
    setCategoryAddMode("child");
  });
  document.querySelectorAll("[data-category-action]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      openCategoryActionModal(button.dataset.categoryAction || "add");
    });
  });
  el("boomCategoryActionConfirmBtn").addEventListener("click", () =>
    confirmBoomCategoryActionFromModal().catch((err) => toast(err.message))
  );
  el("boomCategoryActionCancelBtn").addEventListener("click", closeBoomCategoryActionModal);
  el("boomCategoryActionModal").addEventListener("click", (event) => {
    if (event.target === el("boomCategoryActionModal")) {
      closeBoomCategoryActionModal();
    }
  });
  el("productCategoryMoveConfirmBtn").addEventListener("click", () =>
    confirmProductCategoryMove().catch((err) => toast(err.message))
  );
  el("productCategoryMoveCancelBtn").addEventListener("click", closeProductCategoryMoveModal);
  el("productCategoryMoveModal").addEventListener("click", (event) => {
    if (event.target === el("productCategoryMoveModal")) {
      closeProductCategoryMoveModal();
    }
  });
  el("boomCategoryActionInput").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    confirmBoomCategoryActionFromModal().catch((err) => toast(err.message));
  });
  el("boomCategoryAddSiblingBtn").addEventListener("click", () => {
    setBoomCategoryAddMode("sibling");
  });
  el("boomCategoryAddChildBtn").addEventListener("click", () => {
    setBoomCategoryAddMode("child");
  });
  document.querySelectorAll("[data-boom-category-action]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      openBoomCategoryActionModal(button.dataset.boomCategoryAction || "add");
    });
  });

  el("searchBtn").addEventListener("click", () => {
    state.page = 1;
    loadProducts().catch((err) => toast(err.message));
  });

  el("searchKeyword").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      state.page = 1;
      loadProducts().catch((err) => toast(err.message));
    }
  });

  el("filterCategory").addEventListener("change", () => {
    state.page = 1;
    loadProducts().catch((err) => toast(err.message));
  });

  el("productCode").addEventListener("input", () => setProductCodeError(""));
  el("productBoomCategory").addEventListener("change", () => {
    resetBomEditor();
    loadProductBoomBaseItems(Number(el("productBoomCategory").value) || null).catch((err) =>
      toast(err.message)
    );
  });
  el("saveProductBtn").addEventListener("click", () => {
    saveProduct().catch((err) => {
      const conflict = err?.payload?.conflict;
      if (conflict) {
        const conflictName = conflict.chinese_name || "未命名产品";
        setProductCodeError(`编码重复：与产品 #${conflict.id}（${conflictName}）冲突`);
        return;
      }
      toast(err.message);
    });
  });
  el("resetProductBtn").addEventListener("click", resetProductForm);
  el("deleteProductBtn").addEventListener("click", () =>
    deleteProductFromDetail().catch((err) => toast(err.message))
  );
  el("uploadImageBtn").addEventListener("click", () =>
    uploadImage().catch((err) => toast(err.message))
  );
  el("bomBaseItemSelect").addEventListener("change", () => {
    applySelectedProductBoomBaseItem();
  });

  el("prevPageBtn").addEventListener("click", () => {
    if (state.page <= 1) return;
    state.page -= 1;
    loadProducts().catch((err) => toast(err.message));
  });

  el("nextPageBtn").addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    if (state.page >= totalPages) return;
    state.page += 1;
    loadProducts().catch((err) => toast(err.message));
  });

  el("calcFlowBtn").addEventListener("click", () => {
    try {
      calculateFlowPerHour();
    } catch (err) {
      toast(err.message);
    }
  });

  el("saveBoomBaseItemBtn").addEventListener("click", () =>
    saveBoomBaseItem().catch((err) => toast(err.message))
  );
  el("cancelBoomBaseEditBtn").addEventListener("click", () => resetBoomBaseForm());
  el("materialCostProduct").addEventListener("change", () => {
    syncMaterialCostUnitFromSelectedProduct();
  });

  el("calcCostBtn").addEventListener("click", () => {
    try {
      calculateMaterialCost();
    } catch (err) {
      toast(err.message);
    }
  });

  el("saveConfigUnitBtn").addEventListener("click", () =>
    saveConfigUnit().catch((err) => toast(err.message))
  );
  el("cancelConfigUnitEditBtn").addEventListener("click", () => resetConfigUnitForm());
  el("saveProductSpecBtn").addEventListener("click", () =>
    saveProductSpec().catch((err) => toast(err.message))
  );
  el("cancelProductSpecEditBtn").addEventListener("click", () => resetProductSpecEditor());
  el("saveBomItemBtn").addEventListener("click", () =>
    saveBomItem().catch((err) => toast(err.message))
  );
  el("cancelBomEditBtn").addEventListener("click", () => resetBomEditor());

  el("addQuoteLineBtn").addEventListener("click", () => {
    try {
      addQuoteLine();
    } catch (err) {
      toast(err.message);
    }
  });
  el("clearQuoteBtn").addEventListener("click", () => {
    if (!state.quoteLines.length) return;
    if (!window.confirm("确认清空报价单？")) return;
    clearQuoteLines();
  });
}

async function bootstrap() {
  bindEvents();
  setCategoryAction("add");
  setBoomCategoryAction("add");
  updateEditSelectedProductButtonState();
  updateDeleteProductButtonState();
  initSideNavigation();
  resetProductForm();
  resetBoomBaseForm();
  resetConfigUnitForm();
  setProductImagePanelVisible(false);
  resetMaterialPanels();
  el("quoteDate").value = new Date().toISOString().slice(0, 10);

  await Promise.all([loadCategories(), loadBoomCategories(), loadConfigUnits(), loadStats()]);
  await Promise.all([loadProducts(), loadMaterialProducts(), loadRecycleBinProducts()]);
}

bootstrap().catch((err) => {
  console.error(err);
  toast(err.message || "初始化失败");
});
