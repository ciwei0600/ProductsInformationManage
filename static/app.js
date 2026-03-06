const state = {
  categories: [],
  categoryTree: [],
  page: 1,
  pageSize: 20,
  total: 0,
  selectedTreeCategoryId: null,
  selectedTreeProductId: null,
  selectedProductMainImagePath: null,
  expandedCategoryIds: new Set(),
  categoryAction: "add",
  materialProducts: [],
  quoteLines: [],
  currentProductBomItems: [],
  currentProductBomTotalCost: 0,
  editingBomItemId: null,
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

function updateEditSelectedProductButtonState() {
  const button = el("editSelectedProductBtn");
  if (!button) return;
  button.disabled = !state.selectedTreeProductId;
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

function categoryPathMap() {
  const children = new Map();

  for (const item of state.categories) {
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

function setCategoryAction(action) {
  const hasSelectedCategory = Boolean(state.selectedTreeCategoryId);
  const finalAction = !hasSelectedCategory && action !== "add" ? "add" : action;
  state.categoryAction = finalAction;

  document.querySelectorAll("[data-category-action]").forEach((button) => {
    const active = button.dataset.categoryAction === finalAction;
    button.classList.toggle("active", active);
  });
  document.querySelectorAll("[data-category-action='rename'], [data-category-action='delete']").forEach((button) => {
    button.disabled = !hasSelectedCategory;
  });
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
  const inputRow = el("categoryActionInputRow");
  const input = el("categoryActionInput");
  const confirmBtn = el("categoryActionConfirmBtn");
  const current = state.categories.find((item) => item.id === state.selectedTreeCategoryId);
  const currentName = current?.name || `目录 #${state.selectedTreeCategoryId}`;

  if (state.categoryAction === "delete") {
    title.textContent = "删除目录";
    target.textContent = `将删除：${currentName}`;
    inputRow.style.display = "none";
    input.value = "";
    confirmBtn.textContent = "确认删除";
    confirmBtn.classList.add("danger");
  } else if (state.categoryAction === "rename") {
    title.textContent = "修改目录";
    target.textContent = `当前目录：${currentName}`;
    inputRow.style.display = "";
    input.value = current?.name || "";
    input.placeholder = "请输入新目录名称";
    confirmBtn.textContent = "确认修改";
    confirmBtn.classList.remove("danger");
    window.setTimeout(() => input.focus(), 0);
  } else {
    title.textContent = "新增目录";
    target.textContent = `父级目录：${currentName}`;
    inputRow.style.display = "";
    input.value = "";
    input.placeholder = "请输入新目录名称";
    confirmBtn.textContent = "确认新增";
    confirmBtn.classList.remove("danger");
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
      const products = subtreeProducts.get(node.id) || [];
      const hasContent = products.length > 0;
      const expanded = state.expandedCategoryIds.has(node.id);
      const sign = hasContent ? (expanded ? "-" : "+") : "·";
      const signClass = hasContent ? "tree-sign" : "tree-sign empty";
      const padding = 10 + depth * 14;
      html += `<li>
        <div
          class="tree-item ${active}"
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
              ? `<img class="tree-product-thumb" src="/media/${product.first_image}" alt="${name}" />`
              : '<div class="tree-product-no-image">无图</div>';
            const activeProduct = state.selectedTreeProductId === product.id ? "active" : "";
            return `
            <li class="tree-product-item ${activeProduct}" data-product-id="${product.id}">
              <div class="tree-product-main">
                <div class="tree-product-media">
                  ${imageBlock}
                </div>
                <div class="tree-product-info">
                  <div class="tree-product-title">${product.code || "-"} | ${name}</div>
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
      toast("产品已删除");
      if (state.selectedTreeProductId === id) {
        state.selectedTreeProductId = null;
        updateEditSelectedProductButtonState();
      }
      if (String(el("productId").value) === String(id)) {
        resetProductForm();
      }
      await Promise.all([loadProducts(), loadStats(), loadMaterialProducts()]);
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

function setBomEditorEnabled(enabled) {
  const bomEditorHint = el("bomEditorHint");
  const bomEditor = el("bomEditor");
  if (!bomEditorHint || !bomEditor) return;

  bomEditorHint.textContent = enabled
    ? "为当前产品设置BOM项目后，可在成本计算中自动带入单件成本。"
    : "请先保存产品后，再维护BOM项目。";

  bomEditor.querySelectorAll("input, button").forEach((node) => {
    node.disabled = !enabled;
  });
}

function resetBomEditor() {
  state.editingBomItemId = null;
  el("bomItemName").value = "";
  el("bomItemSpec").value = "";
  el("bomItemUnit").value = "";
  el("bomItemQty").value = "0";
  el("bomItemUnitCost").value = "0";
  el("bomItemRemark").value = "";
  el("saveBomItemBtn").textContent = "新增项目";
  el("cancelBomEditBtn").style.display = "none";
}

function startEditBomItem(bomItemId) {
  const item = state.currentProductBomItems.find((row) => row.id === bomItemId);
  if (!item) {
    throw new Error("未找到要修改的BOM项目");
  }

  state.editingBomItemId = bomItemId;
  el("bomItemName").value = item.item_name || "";
  el("bomItemSpec").value = item.item_spec || "";
  el("bomItemUnit").value = item.unit || "";
  el("bomItemQty").value = formatDecimal(item.quantity, 6);
  el("bomItemUnitCost").value = formatDecimal(item.unit_cost, 6);
  el("bomItemRemark").value = item.remark || "";
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
  const itemName = el("bomItemName").value.trim();
  if (!itemName) {
    throw new Error("BOM项目名称不能为空");
  }

  const quantity = Number(el("bomItemQty").value || "0");
  const unitCost = Number(el("bomItemUnitCost").value || "0");
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error("BOM数量必须大于等于0");
  }
  if (!Number.isFinite(unitCost) || unitCost < 0) {
    throw new Error("BOM单价必须大于等于0");
  }

  return {
    item_name: itemName,
    item_spec: el("bomItemSpec").value.trim(),
    unit: el("bomItemUnit").value.trim(),
    quantity,
    unit_cost: unitCost,
    remark: el("bomItemRemark").value.trim(),
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

  renderMaterialPackageTable([]);
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
  fillCategorySelect("materialPackageCategory", true);

  if (
    state.selectedTreeCategoryId &&
    !state.categories.some((category) => category.id === state.selectedTreeCategoryId)
  ) {
    state.selectedTreeCategoryId = null;
  }

  setCategoryAction(state.categoryAction);

  renderCategoryTree();
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

function renderMaterialPackageTable(items) {
  const body = el("materialPackageBody");
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="7" class="hint">暂无数据</td></tr>';
    setText("materialPackageSummary", "共 0 个产品");
    return;
  }

  body.innerHTML = items
    .map((item) => {
      const name = item.chinese_name || item.name || "-";
      return `
      <tr>
        <td>${item.code || "-"}</td>
        <td>${name}</td>
        <td>${item.package_quantity || "-"}</td>
        <td>${item.package_size || "-"}</td>
        <td>${item.unit_weight || "-"}</td>
        <td>${item.gross_weight || "-"}</td>
        <td>${item.category_name || "-"}</td>
      </tr>
      `;
    })
    .join("");

  setText("materialPackageSummary", `共 ${items.length} 个产品`);
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

async function refreshMaterialPackagingByFilter() {
  const keyword = el("materialPackageKeyword").value.trim();
  const categoryId = el("materialPackageCategory").value;

  if (!keyword && !categoryId) {
    renderMaterialPackageTable(state.materialProducts);
    return;
  }

  const items = await fetchAllProducts({ keyword, categoryId });
  renderMaterialPackageTable(items);
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
  await refreshMaterialPackagingByFilter();
  renderCategoryTree();
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

  renderProductImages(data.images || []);
  resetBomEditor();
  renderBomItems(data.bom_items || [], Number(data.bom_total_cost || 0));
  setBomEditorEnabled(true);
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
    const created = await request("/api/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        parent_id: categoryId,
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

async function saveProduct() {
  setProductCodeError("");
  const productId = el("productId").value;
  const payload = {
    code: el("productCode").value.trim(),
    chinese_name: el("productChineseName").value.trim(),
    category_id: el("productCategory").value ? Number(el("productCategory").value) : null,
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
  el("editSelectedProductBtn").addEventListener("click", () =>
    editSelectedTreeProduct().catch((err) => toast(err.message))
  );
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
  document.querySelectorAll("[data-category-action]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      openCategoryActionModal(button.dataset.categoryAction || "add");
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
  el("uploadImageBtn").addEventListener("click", () =>
    uploadImage().catch((err) => toast(err.message))
  );

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

  el("materialPackageSearchBtn").addEventListener("click", () =>
    refreshMaterialPackagingByFilter().catch((err) => toast(err.message))
  );
  el("materialPackageKeyword").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      refreshMaterialPackagingByFilter().catch((err) => toast(err.message));
    }
  });
  el("materialPackageCategory").addEventListener("change", () =>
    refreshMaterialPackagingByFilter().catch((err) => toast(err.message))
  );
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
  updateEditSelectedProductButtonState();
  initSideNavigation();
  resetProductForm();
  setProductImagePanelVisible(false);
  resetMaterialPanels();
  el("quoteDate").value = new Date().toISOString().slice(0, 10);

  await Promise.all([loadCategories(), loadStats()]);
  await Promise.all([loadProducts(), loadMaterialProducts()]);
}

bootstrap().catch((err) => {
  console.error(err);
  toast(err.message || "初始化失败");
});
